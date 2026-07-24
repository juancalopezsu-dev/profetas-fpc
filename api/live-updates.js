// Función serverless (se dispara desde afuera cada pocos minutos — GitHub
// Actions / cron-job.org) que mantiene el marcador EN VIVO, el estado y los
// GOLES (con su autor) de los partidos de la FPC actualizados solos, sin que
// nadie tenga la app abierta.
//
// Fuente de datos: BSD (sports.bzzoiro.com), liga 80 = Categoría Primera A.
// Gratis y SIN límite de peticiones (a diferencia de ESPN/API-Football que se
// usaron antes — ver historial). Cada partido de la FPC se creó con el botón
// "Importar partidos" (ver api/importar-partidos.js), que le guardó su
// 'bsdMatchId'; con ese id se le pide a BSD el detalle del partido
// (/api/matches/{id}/?full=true), que trae marcador, estado e 'incidents'
// (goles con {type,minute,player,player_id,is_home}). Los partidos de la FPC
// que por lo que sea no tengan bsdMatchId se buscan por fecha+equipos y se les
// guarda el bsdMatchId para la próxima.
//
// Los partidos de otra competencia (ej. 'mundial', que fue una prueba) no se
// tocan acá — se actualizan a mano en Gestionar.
//
// En cada ejecución:
//   1. Pasa a 'live' (por tiempo) cualquier partido 'scheduled' cuyo kickoff
//      ya pasó, para revelar predicciones aunque BSD se demore.
//   2. Revela (visible:true) las predicciones de cualquier partido que ya no
//      esté 'scheduled'.
//   3. Para cada partido FPC no terminado, le pide a BSD marcador + goles +
//      estado y los guarda.
//
// Auth: header "Authorization: Bearer <CRON_SECRET>" o "?secret=<CRON_SECRET>".
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, BSD_API_KEY, CRON_SECRET (opc).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const BSD_LEAGUE = 80;
// nombre normalizado de NUESTRO equipo -> bsd team id (verificado 2026-07-24).
const BSD_TEAM_IDS = {
  'alianza fc': 4783, 'america de cali': 753, 'atletico bucaramanga': 771,
  'atletico nacional': 766, 'boyaca chico': 4784, 'cucuta deportivo': 4635,
  'deportes tolima': 781, 'deportivo cali': 3733, 'deportivo pasto': 3419,
  'deportivo pereira': 4780, 'fortaleza ceif': 4782, 'independiente medellin': 786,
  'independiente santa fe': 797, 'internacional de bogota': 3181, 'jaguares de cordoba': 4785,
  'junior': 789, 'llaneros': 4781, 'millonarios': 736, 'once caldas': 3891, 'aguilas doradas': 4786
};

function matchCompetition(m) { return m.competition === 'mundial' ? 'mundial' : 'fpc'; }
function norm(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' '); }
function bsdTeamId(team) { return team ? BSD_TEAM_IDS[norm(team.name)] : null; }

// Fecha "de Colombia" (YYYY-MM-DD) de un kickoff en ms, sin depender de la
// zona horaria del servidor (Bogotá siempre es UTC-5).
function bogotaDateStr(ms) {
  return new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function matchStatusComputed(m) {
  if (m.status === 'live' || m.status === 'finished' || m.status === 'scheduled') return m.status;
  return m.homeScore != null ? 'finished' : 'scheduled';
}

// Estado de BSD -> nuestro estado. 'notstarted' se deja 'scheduled' salvo que
// nuestro reloj diga que ya empezó (entonces 'live' provisional).
function mapBsdStatus(bsdStatus, kickoffPassed) {
  const s = (bsdStatus || '').toLowerCase();
  if (/finish|ended|\bft\b|after|aet|pen|awarded|walkover/.test(s) || s === 'finished') return 'finished';
  if (s === 'notstarted' || s === 'postponed' || s === 'canceled' || s === 'cancelled') return kickoffPassed ? 'live' : 'scheduled';
  return 'live';
}

// De las incidencias de BSD saca los goles. is_home = equipo del jugador; en
// autogol el marcador (que igual viene autoritativo en home_score/away_score)
// lo maneja BSD, acá solo guardamos el gol para mostrarlo y para el goleo.
function goalsFromIncidents(incidents) {
  if (!Array.isArray(incidents)) return [];
  return incidents
    .filter(i => i.type === 'goal')
    .map(i => ({
      team: i.is_home ? 'home' : 'away',
      minute: (i.minute == null ? null : i.minute),
      player: i.player || null,
      playerId: (i.player_id == null ? null : String(i.player_id)),
      goalType: i.goal_type || null
    }))
    .sort((a, b) => (a.minute || 0) - (b.minute || 0));
}

async function bsdGet(path) {
  const r = await fetch('https://sports.bzzoiro.com' + path, {
    headers: { 'Authorization': 'Token ' + process.env.BSD_API_KEY }
  });
  if (!r.ok) throw new Error('BSD HTTP ' + r.status);
  return r.json();
}

// Actualiza sola la tabla de posiciones REAL de la liga (la de "Liga real" en
// la app) desde el endpoint de standings de BSD, mapeando cada equipo de BSD a
// NUESTRO equipo. Se guarda en el mismo formato que ya usa la app
// ('profetas/realStandings' -> {data:{teamId:{pj,pg,pe,pp,gf,gc}}}), así que
// el admin ya no la llena a mano.
async function updateRealStandings(db, teams) {
  const bsdIdToOurNorm = {};
  Object.keys(BSD_TEAM_IDS).forEach(ourNorm => { bsdIdToOurNorm[BSD_TEAM_IDS[ourNorm]] = ourNorm; });
  const teamByNorm = {};
  teams.forEach(t => { teamByNorm[norm(t.name)] = t; });

  const json = await bsdGet('/api/leagues/' + BSD_LEAGUE + '/standings/');
  const rows = (json && json.standings) || [];
  if (!rows.length) return 0;

  const data = {};
  let mapped = 0;
  for (const r of rows) {
    const ourNorm = bsdIdToOurNorm[r.team_id];
    const ourTeam = ourNorm ? teamByNorm[ourNorm] : null;
    if (!ourTeam) continue;
    data[ourTeam.id] = {
      pj: r.played || 0, pg: r.won || 0, pe: r.drawn || 0, pp: r.lost || 0,
      gf: r.gf || 0, gc: r.ga || 0
    };
    mapped++;
  }
  if (mapped) await db.collection('profetas').doc('realStandings').set({ data });
  return mapped;
}

// Le pone 'visible: true' a las predicciones de un partido que ya no está
// 'scheduled'. Se salta las que ya estaban en true. Un partido 'finished' con
// predictionsFullyRevealed:true ya no se relee (ahorra lecturas).
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
    if (!authorized) { res.status(401).json({ error: 'No autorizado. Usa "?secret=TU_CRON_SECRET" o el header Authorization.' }); return; }
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }
  if (!process.env.BSD_API_KEY) { res.status(500).json({ error: 'Falta configurar BSD_API_KEY en Vercel.' }); return; }

  const diagnostics = [];
  try {
    const db = getDb();
    const now = Date.now();

    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    // Paso 1: pasar a 'live' por tiempo (sin llamar a BSD).
    let flippedToLive = 0;
    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      if (matchStatusComputed(m) === 'scheduled' && m.kickoff && m.kickoff <= now) {
        const updates = { status: 'live' };
        if (m.homeScore == null) updates.homeScore = 0;
        if (m.awayScore == null) updates.awayScore = 0;
        try { await matchDoc.ref.update(updates); flippedToLive++; } catch (e) {}
      }
    }

    // Recargar si algo cambió, para el paso 2 y 3.
    const freshSnap = flippedToLive
      ? await db.collection('profetas').doc('matches').collection('matches').get()
      : matchesSnap;

    // Paso 2: revelar predicciones de los que ya no están 'scheduled'.
    let predictionsRevealed = 0;
    for (const matchDoc of freshSnap.docs) {
      const m = matchDoc.data();
      const st = matchStatusComputed(m);
      if (st === 'scheduled') continue;
      if (st === 'finished' && m.predictionsFullyRevealed === true) continue;
      predictionsRevealed += await revealPredictions(matchDoc);
      if (st === 'finished') { try { await matchDoc.ref.update({ predictionsFullyRevealed: true }); } catch (e) {} }
    }

    // Paso 3: para cada partido FPC no terminado, pedirle a BSD marcador +
    // goles + estado.
    let updatedCount = 0, finishedCount = 0;
    for (const matchDoc of freshSnap.docs) {
      const m = matchDoc.data();
      if (matchCompetition(m) !== 'fpc') continue;
      if (matchStatusComputed(m) === 'finished') continue;

      const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
      const diag = { id: matchDoc.id, teams: (home ? home.name : '?') + ' vs ' + (away ? away.name : '?'), bsdMatchId: m.bsdMatchId || null };

      try {
        // 1) conseguir el detalle del partido en BSD.
        let bsdMatchId = m.bsdMatchId;
        let detail = null;

        if (bsdMatchId) {
          detail = await bsdGet('/api/matches/' + bsdMatchId + '/?full=true&tz=America/Bogota');
        } else if (m.kickoff && home && away) {
          // Fallback: buscar por fecha + equipos, y guardar el bsdMatchId.
          const date = bogotaDateStr(m.kickoff);
          const list = await bsdGet('/api/matches/?league=' + BSD_LEAGUE + '&date_from=' + date + '&date_to=' + date + '&full=true&tz=America/Bogota&page_size=40');
          const hId = bsdTeamId(home), aId = bsdTeamId(away);
          const ev = (list.results || []).find(e => {
            const eh = e.home_team_obj && e.home_team_obj.id, ea = e.away_team_obj && e.away_team_obj.id;
            return eh === hId && ea === aId;
          });
          if (ev) { bsdMatchId = String(ev.id); detail = ev; }
        }

        if (!detail) { diag.result = 'no se encontró el partido en BSD'; diagnostics.push(diag); continue; }

        const kickoffPassed = m.kickoff && m.kickoff <= now;
        const newStatus = mapBsdStatus(detail.status, kickoffPassed);
        const goals = goalsFromIncidents(detail.incidents);

        const updates = { goals };
        if (bsdMatchId && bsdMatchId !== m.bsdMatchId) updates.bsdMatchId = bsdMatchId;
        if (detail.home_score != null) updates.homeScore = detail.home_score;
        if (detail.away_score != null) updates.awayScore = detail.away_score;
        updates.status = newStatus;
        if (newStatus === 'finished') finishedCount++;

        await matchDoc.ref.update(updates);
        updatedCount++;
        diag.result = 'ok'; diag.bsdStatus = detail.status; diag.mapped = newStatus;
        diag.score = (detail.home_score) + '-' + (detail.away_score); diag.goals = goals.length;
      } catch (e) {
        diag.result = 'ERROR: ' + String(e);
      }
      diagnostics.push(diag);
    }

    // Paso 4: actualizar sola la tabla de posiciones real desde BSD.
    let standingsMapped = 0;
    try { standingsMapped = await updateRealStandings(db, teams); } catch (e) { /* no crítico */ }

    res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, updated: updatedCount, finished: finishedCount, standingsMapped, diagnostics });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando marcador en vivo', details: String(err), diagnostics });
  }
}
