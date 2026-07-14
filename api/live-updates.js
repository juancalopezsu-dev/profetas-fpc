// Función serverless (Vercel Cron, idealmente cada 5 minutos) que mantiene
// el marcador EN VIVO de los partidos actualizado solo, sin que nadie
// necesite tener la app abierta.
//
// Fuente de datos: la API no oficial de ESPN (site.api.espn.com), gratis y
// sin API key ni restricción de temporada — a diferencia de API-Football,
// cuyo plan gratis no daba acceso a la temporada 2026 (ver commits
// anteriores). Verificado a mano contra la API real antes de escribir este
// archivo:
//   https://site.api.espn.com/apis/site/v2/sports/soccer/{liga}/scoreboard?dates=YYYYMMDD
//   - liga = 'fifa.world' para partidos con competition:'mundial'
//   - liga = 'col.1' para partidos con competition:'fpc' (Colombian Primera A)
// La respuesta trae, en un solo pedido: marcador (competitors[].score),
// estado del partido (competitions[0].status.type.state: 'pre'/'in'/'post')
// y la lista de goles con jugador y minuto (competitions[0].details[],
// filtrando scoringPlay:true) — no hace falta un segundo pedido para los
// goles como sí hacía falta con API-Football.
//
// En cada ejecución:
//   1. Pasa a 'live' (por tiempo, sin llamar a ESPN) cualquier partido
//      'scheduled' cuyo kickoff ya pasó. Esto es lo que hace que un partido
//      que ya arrancó (o que ya terminó por completo sin que nadie se diera
//      cuenta, ej. si el cron estuvo caído un rato) entre al paso 2 de todos
//      modos — no hace falta que ESPN diga "ya empezó" para considerarlo.
//   2. Le pone 'visible: true' a las predicciones de cualquier partido que ya
//      no esté 'scheduled' (ver revealPredictions() y firestore.rules).
//   3. Si no queda ningún partido 'live', termina ahí.
//   4. Para cada partido 'live' (haya arrancado hace 2 minutos o llevado
//      cerrado varios días sin que el cron corriera), consulta el scoreboard
//      de ESPN de su competencia y fecha, y actualiza marcador + goles +
//      status ('live' -> 'finished' cuando ESPN reporta state:'post').
//
// No hay chequeo de cuota: ESPN no tiene el límite diario estricto que sí
// tenía el plan gratis de API-Football, así que este paso se quitó.
//
// La respuesta siempre incluye un array 'diagnostics' con, por cada partido
// no terminado: el status TAL COMO está guardado en Firestore, la URL exacta
// consultada a ESPN, cuántos eventos devolvió, si encontró el partido ahí
// adentro, y si el intento de escribir en Firestore funcionó o el error
// exacto si no. Pensado para poder abrir esta URL directo en el navegador
// (con ?secret=) y ver qué está pasando de verdad, sin adivinar.
//
// Respaldo manual: en Gestionar, cualquier partido 'live' se puede editar a
// mano (marcador directo o gol por gol) — no depende de que este cron ande a
// tiempo ni de que ESPN responda (ver comentarios en app.js).
//
// Nota sobre el plan de Vercel: los Cron Jobs de Vercel en el plan Hobby
// (gratis) solo se disparan una vez al día por más fina que sea la
// expresión cron — no sirven para "cada 5 minutos". Por eso este endpoint
// también se puede disparar desde afuera (ver .github/workflows/live-updates.yml,
// que sí llama cada 5 minutos usando GitHub Actions, gratis). El endpoint es
// idempotente y seguro de llamar así de seguido, o incluso a mano.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - CRON_SECRET (opcional pero recomendado): se puede mandar como header
//     "Authorization: Bearer <CRON_SECRET>" (así lo manda Vercel Cron y el
//     workflow de GitHub Actions) o, para poder abrir la URL directo en el
//     navegador, como "?secret=<CRON_SECRET>" en la query string.
//   (Ya no hace falta API_FOOTBALL_KEY para este endpoint.)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ESPN_LEAGUE_SLUGS = { fpc: 'col.1', mundial: 'fifa.world' };

function matchCompetition(m) {
  return m.competition === 'mundial' ? 'mundial' : 'fpc';
}

// Colombia (Bogotá) no tiene horario de verano, siempre es UTC-5. Verificado
// a mano que ESPN agrupa sus partidos bajo esta misma fecha "de Colombia"
// incluso cuando, en UTC, el kickoff cae ya en el día siguiente (partidos
// nocturnos).
function bogotaDateStr(kickoff) {
  const epochMs = typeof kickoff === 'number' ? kickoff : new Date(kickoff).getTime();
  return new Date(epochMs - 5 * 3600 * 1000).toISOString().slice(0, 10);
}
function bogotaDateTimeStr(ms) {
  if (ms == null) return null;
  return new Date(ms - 5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' (hora Bogotá)';
}

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

async function espnScoreboard(leagueSlug, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/scoreboard?dates=${dateStr.replace(/-/g, '')}`;
  const apiRes = await fetch(url);
  const json = await apiRes.json();
  return { url, httpStatus: apiRes.status, events: json.events || [] };
}

// Compara nombres con más de una estrategia porque ESPN a veces agrega
// sufijos ("Llaneros FC" vs nuestro "Llaneros") — probamos igualdad exacta,
// que uno contenga al otro completo, y solo como último recurso la primera
// palabra (evitando palabras genéricas de 3 letras o menos).
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

// competitions[0].details[] trae goles Y tarjetas mezclados — scoringPlay
// distingue lo que de verdad sumó gol (incluye autogoles y penales).
function extractGoals(competition, homeEspnTeamId) {
  const details = competition.details || [];
  return details
    .filter(d => d.scoringPlay)
    .map(d => {
      const minuteMatch = d.clock && d.clock.displayValue ? parseInt(d.clock.displayValue, 10) : NaN;
      return {
        team: d.team && d.team.id === homeEspnTeamId ? 'home' : 'away',
        minute: isNaN(minuteMatch) ? null : minuteMatch
      };
    });
}

function matchStatusComputed(m) {
  if (m.status === 'live' || m.status === 'finished' || m.status === 'scheduled') return m.status;
  return m.homeScore != null ? 'finished' : 'scheduled';
}

// Le pone 'visible: true' a las predicciones de un partido que ya no está
// 'scheduled'. Es lo único que le permite a firestore.rules mostrarle a
// alguien la predicción de otra persona (ver comentarios ahí) — nunca lo
// hace el navegador porque nadie puede editar la predicción ajena. Se salta
// las que ya estaban en true para no gastar escrituras de más.
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
      res.status(401).json({ error: 'No autorizado. Usa "?secret=TU_CRON_SECRET" en la URL o el header Authorization.' });
      return;
    }
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }

  const diagnostics = []; // un objeto por partido no terminado, se va llenando en cada paso
  const diagFor = (matchId) => diagnostics.find(d => d.id === matchId);

  try {
    const db = getDb();
    const now = Date.now();

    // Paso 0: cargar todos los partidos y armar el diagnóstico base (lo que
    // hay guardado en Firestore AHORA MISMO, antes de tocar nada) para los
    // que no estén ya 'finished'.
    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      const computed = matchStatusComputed(m);
      if (computed === 'finished' && m.status === 'finished') continue;
      const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
      diagnostics.push({
        id: matchDoc.id,
        teams: `${home ? home.name : '?'} vs ${away ? away.name : '?'}`,
        competition: matchCompetition(m),
        kickoffRaw: m.kickoff || null,
        kickoff: bogotaDateTimeStr(m.kickoff),
        statusRaw: m.status === undefined ? '(el campo status no existe en este documento)' : m.status,
        statusComputadoAntes: computed,
        homeScoreEnFirestoreAntes: m.homeScore,
        awayScoreEnFirestoreAntes: m.awayScore,
        pasoAVivoEnEstaEjecucion: false,
        espnConsulta: null,
        espnHttpStatus: null,
        espnEventosDevueltos: null,
        espnEncontroElPartido: null,
        espnEstado: null,
        espnMarcador: null,
        espnEquiposEnLaRespuesta: null,
        escrituraIntentada: false,
        escrituraResultado: null
      });
    }

    // Paso 1: pasar a 'live' por tiempo, sin llamar a ESPN.
    let flippedToLive = 0;
    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      if (matchStatusComputed(m) === 'scheduled' && m.kickoff && m.kickoff <= now) {
        const updates = { status: 'live' };
        if (m.homeScore == null) updates.homeScore = 0;
        if (m.awayScore == null) updates.awayScore = 0;
        try {
          await matchDoc.ref.update(updates);
          flippedToLive++;
          const d = diagFor(matchDoc.id);
          if (d) { d.pasoAVivoEnEstaEjecucion = true; d.statusComputadoAntes = 'live (recién pasado)'; }
        } catch (e) {
          const d = diagFor(matchDoc.id);
          if (d) d.escrituraResultado = 'ERROR al pasar a live: ' + String(e);
        }
      }
    }

    // Paso 2: revelar predicciones ajenas de cualquier partido que ya no
    // esté 'scheduled' (ver revealPredictions arriba).
    const freshSnap = flippedToLive
      ? await db.collection('profetas').doc('matches').collection('matches').get()
      : matchesSnap;
    let predictionsRevealed = 0;
    for (const matchDoc of freshSnap.docs) {
      if (matchStatusComputed(matchDoc.data()) !== 'scheduled') {
        predictionsRevealed += await revealPredictions(matchDoc);
      }
    }

    // Paso 3: solo seguimos a pedirle datos a ESPN si de verdad hay algo en
    // vivo (recién flipeado o de antes) que consultar.
    const liveDocs = freshSnap.docs.filter(d => matchStatusComputed(d.data()) === 'live');

    if (!liveDocs.length) {
      res.status(200).json({
        ok: true, flippedToLive, predictionsRevealed, liveChecked: 0,
        message: 'No hay ningún partido con status "live" en Firestore ahora mismo — por eso no se consultó a ESPN. Revisa el campo "statusRaw" de cada partido en "diagnostics" para ver por qué.',
        diagnostics
      });
      return;
    }

    // Paso 4: consultar el scoreboard de ESPN por competencia + fecha (un
    // mismo día puede tener partidos de la FPC y del Mundial a la vez) y
    // actualizar marcador, goles y status.
    const groups = {};
    for (const d of liveDocs) {
      const competition = matchCompetition(d.data());
      const date = bogotaDateStr(d.data().kickoff);
      const key = competition + '|' + date;
      if (!groups[key]) groups[key] = { competition, date, docs: [] };
      groups[key].docs.push(d);
    }
    let updatedCount = 0, finishedCount = 0;

    for (const key of Object.keys(groups)) {
      const { competition, date, docs: dayDocs } = groups[key];
      const leagueSlug = ESPN_LEAGUE_SLUGS[competition] || ESPN_LEAGUE_SLUGS.fpc;
      let events = [];
      let apiUrl = null, apiHttpStatus = null, apiError = null;
      try {
        const result = await espnScoreboard(leagueSlug, date);
        apiUrl = result.url; apiHttpStatus = result.httpStatus; events = result.events;
      } catch (e) { apiError = String(e); }

      for (const matchDoc of dayDocs) {
        const m = matchDoc.data();
        const d = diagFor(matchDoc.id);
        if (d) {
          d.espnConsulta = apiUrl;
          d.espnHttpStatus = apiHttpStatus;
          d.espnEventosDevueltos = events.length;
          if (apiError) d.espnError = apiError;
        }

        const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        if (!home || !away) {
          if (d) d.espnEncontroElPartido = 'no — falta el equipo local o visitante en Firestore (homeTeamId/awayTeamId no coincide con ningún equipo)';
          continue;
        }

        const ev = findEspnEvent(events, home, away);
        if (!ev) {
          if (d) {
            d.espnEncontroElPartido = false;
            d.espnEquiposEnLaRespuesta = events.map(e => e.shortName || e.name);
          }
          continue;
        }

        const competitionData = ev.competitions[0];
        const homeComp = competitionData.competitors.find(x => x.homeAway === 'home');
        const awayComp = competitionData.competitors.find(x => x.homeAway === 'away');
        const state = competitionData.status.type.state; // 'pre' | 'in' | 'post'

        if (d) {
          d.espnEncontroElPartido = true;
          d.espnEstado = `${competitionData.status.type.name} (state=${state})`;
          d.espnMarcador = `${homeComp.score}-${awayComp.score}`;
        }

        if (state === 'pre') {
          if (d) d.escrituraResultado = 'ESPN todavía no marca este partido como arrancado (state=pre) — no se tocó el marcador.';
          continue;
        }

        const updates = {};
        const homeScoreNum = parseInt(homeComp.score, 10);
        const awayScoreNum = parseInt(awayComp.score, 10);
        if (!isNaN(homeScoreNum)) updates.homeScore = homeScoreNum;
        if (!isNaN(awayScoreNum)) updates.awayScore = awayScoreNum;
        if (state === 'post') { updates.status = 'finished'; finishedCount++; }

        const goals = extractGoals(competitionData, homeComp.team.id);
        if (goals.length) updates.goals = goals;

        if (Object.keys(updates).length) {
          if (d) d.escrituraIntentada = true;
          try {
            await matchDoc.ref.update(updates);
            updatedCount++;
            if (d) d.escrituraResultado = 'ok: ' + JSON.stringify(updates);
          } catch (e) {
            if (d) d.escrituraResultado = 'ERROR: ' + String(e);
          }
        } else if (d) {
          d.escrituraResultado = 'no hacía falta escribir nada (ESPN no trajo marcador válido)';
        }
      }
    }

    res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, liveChecked: liveDocs.length, updated: updatedCount, finished: finishedCount, diagnostics });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando marcador en vivo', details: String(err), diagnostics });
  }
}
