// Función serverless (Vercel Cron) que actualiza automáticamente los resultados
// de los partidos pendientes en Firestore, sin necesidad de abrir la app.
// También revela (visible:true) las predicciones de cualquier partido que ya
// no esté 'scheduled' — ver revealPredictions() más abajo — como respaldo
// garantizado de esa misma tarea en api/live-updates.js, que depende de que
// alguien haya configurado el workflow de GitHub Actions.
//
// Fuente de datos: la API no oficial de ESPN (site.api.espn.com), gratis y
// sin restricción de temporada (antes usaba API-Football, cuyo plan gratis
// no daba acceso a la temporada 2026 — ver historial de api/live-updates.js
// para el diagnóstico completo). Mismos slugs de liga que ahí: 'col.1' para
// competition:'fpc', 'fifa.world' para competition:'mundial'.
//
// Este cron corre solo 2 veces al día (garantizado por Vercel, incluso en
// plan Hobby) — es el respaldo de última línea si por lo que sea el workflow
// de GitHub Actions de live-updates (cada 5 min) no está corriendo: encuentra
// cualquier partido que ya debería haber arrancado y todavía sigue
// 'scheduled', y lo actualiza directo con lo que diga ESPN (a 'live' si ya
// empezó, a 'finished' con el resultado real si ya terminó).
//
// Se ejecuta automáticamente 2 veces al día vía Vercel Cron (ver vercel.json).
// Usa el Admin SDK de Firebase (permisos de servidor, no las reglas del cliente)
// para leer/escribir directamente en Firestore.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - CRON_SECRET (opcional): si está configurada, Vercel Cron la envía como
//     "Authorization: Bearer <CRON_SECRET>" y este endpoint rechaza cualquier
//     llamada que no la incluya, para que no cualquiera pueda dispararlo.
//   (Ya no hace falta API_FOOTBALL_KEY para este endpoint.)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ESPN_LEAGUE_SLUGS = { fpc: 'col.1', mundial: 'fifa.world' };

function matchCompetition(m) {
  return m.competition === 'mundial' ? 'mundial' : 'fpc';
}

// Colombia (Bogotá) no tiene horario de verano, siempre es UTC-5. Esta
// función devuelve la fecha "de Colombia" (YYYY-MM-DD) de un kickoff
// guardado en milisegundos, sin depender de la zona horaria del servidor
// (Vercel corre en UTC) — verificado a mano que ESPN agrupa sus partidos
// bajo esta misma fecha incluso en partidos nocturnos que en UTC ya caen al
// día siguiente.
function bogotaDateStr(kickoff) {
  const epochMs = typeof kickoff === 'number' ? kickoff : new Date(kickoff).getTime();
  return new Date(epochMs - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function matchStatus(m) {
  if (m.status === 'live' || m.status === 'finished' || m.status === 'scheduled') return m.status;
  return m.homeScore != null ? 'finished' : 'scheduled';
}

async function espnScoreboard(leagueSlug, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/scoreboard?dates=${dateStr.replace(/-/g, '')}`;
  const apiRes = await fetch(url);
  const json = await apiRes.json();
  return json.events || [];
}

// Compara nombres con más de una estrategia porque ESPN a veces agrega
// sufijos ("Llaneros FC" vs nuestro "Llaneros") — igualdad exacta, que uno
// contenga al otro completo, y solo como último recurso la primera palabra.
function teamNameMatches(ourName, espnName) {
  const a = (ourName || '').toLowerCase().trim();
  const b = (espnName || '').toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b || b.indexOf(a) >= 0 || a.indexOf(b) >= 0) return true;
  const aFirst = a.split(' ')[0];
  return aFirst.length > 3 && b.indexOf(aFirst) >= 0;
}

function findEspnEvent(events, home, away) {
  return events.find(e => {
    const c = e.competitions && e.competitions[0];
    if (!c || !c.competitors) return false;
    const homeComp = c.competitors.find(x => x.homeAway === 'home');
    const awayComp = c.competitors.find(x => x.homeAway === 'away');
    if (!homeComp || !awayComp) return false;
    return teamNameMatches(home.name, homeComp.team.displayName) && teamNameMatches(away.name, awayComp.team.displayName);
  });
}

// Respaldo de api/live-updates.js: le pone 'visible: true' a las
// predicciones de un partido que ya no está 'scheduled' — es el campo que
// firestore.rules exige para dejarle ver a alguien la predicción de otra
// persona (ver comentarios ahí). Esta función corre igual en el cron de
// resultados (2 veces al día, garantizado por Vercel) para que la
// visibilidad no dependa solo de que el workflow de GitHub Actions de
// live-updates esté configurado.
async function revealPredictions(matchDoc) {
  const predsSnap = await matchDoc.ref.collection('predictions').get();
  let revealed = 0;
  for (const predDoc of predsSnap.docs) {
    if (predDoc.data().visible !== true) {
      await predDoc.ref.update({ visible: true });
      revealed++;
    }
  }
  return revealed;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    const querySecret = req.query && req.query.secret;
    const authorized = authHeader === `Bearer ${process.env.CRON_SECRET}` || querySecret === process.env.CRON_SECRET;
    if (!authorized) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' });
    return;
  }

  try {
    const db = getDb();
    const now = Date.now();

    // Los partidos y equipos viven como documentos individuales en
    // 'profetas/matches/matches/{id}' y 'profetas/teams/teams/{id}'
    // (no como un array dentro de un único documento).
    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    const matchDocs = matchesSnap.docs;

    let predictionsRevealed = 0;
    for (const matchDoc of matchDocs) {
      if (matchStatus(matchDoc.data()) !== 'scheduled') {
        predictionsRevealed += await revealPredictions(matchDoc);
      }
    }

    // Cualquier partido no terminado cuyo kickoff ya pasó — no solo
    // 'scheduled' con marcador nulo, también uno que se haya quedado 'live'
    // varios días sin que nadie lo actualizara (ej. si live-updates.js
    // estuvo caído). No hace falta separar por status: si ESPN dice que ya
    // terminó, se marca finished sin importar en qué status estaba antes.
    const pendingDocs = matchDocs.filter(d => {
      const m = d.data();
      return matchStatus(m) !== 'finished' && m.kickoff && m.kickoff <= now;
    });

    if (!pendingDocs.length) {
      res.status(200).json({ updated: 0, predictionsRevealed, message: 'No hay partidos pendientes con fecha para revisar.' });
      return;
    }

    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    // Se agrupa por competencia + fecha porque un mismo día puede tener
    // partidos de la FPC y del Mundial a la vez, y cada uno necesita su
    // propia consulta al scoreboard de ESPN con su propia liga.
    const groups = {};
    for (const d of pendingDocs) {
      const competition = matchCompetition(d.data());
      const date = bogotaDateStr(d.data().kickoff);
      const key = competition + '|' + date;
      if (!groups[key]) groups[key] = { competition, date, docs: [] };
      groups[key].docs.push(d);
    }

    let updatedCount = 0;

    for (const key of Object.keys(groups)) {
      const { competition, date, docs: dayDocs } = groups[key];
      const leagueSlug = ESPN_LEAGUE_SLUGS[competition] || ESPN_LEAGUE_SLUGS.fpc;
      let events = [];
      try { events = await espnScoreboard(leagueSlug, date); } catch (e) { continue; }

      for (const matchDoc of dayDocs) {
        const m = matchDoc.data();
        const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        if (!home || !away) continue;

        const ev = findEspnEvent(events, home, away);
        if (!ev) continue;

        const competitionData = ev.competitions[0];
        const homeComp = competitionData.competitors.find(x => x.homeAway === 'home');
        const awayComp = competitionData.competitors.find(x => x.homeAway === 'away');
        const state = competitionData.status.type.state; // 'pre' | 'in' | 'post'
        if (state === 'pre') continue;

        const updates = {};
        const homeScoreNum = parseInt(homeComp.score, 10);
        const awayScoreNum = parseInt(awayComp.score, 10);
        if (!isNaN(homeScoreNum)) updates.homeScore = homeScoreNum;
        if (!isNaN(awayScoreNum)) updates.awayScore = awayScoreNum;
        updates.status = state === 'post' ? 'finished' : 'live';

        if (Object.keys(updates).length) {
          await matchDoc.ref.update(updates);
          updatedCount++;
        }
      }
    }

    res.status(200).json({ updated: updatedCount, predictionsRevealed });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando resultados', details: String(err) });
  }
}
