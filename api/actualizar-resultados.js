// Función serverless (Vercel Cron, 2 veces al día — ver vercel.json) que es el
// RESPALDO de api/live-updates.js: si por lo que sea el disparador de cada
// pocos minutos (GitHub Actions / cron-job.org) no corrió, esto igual actualiza
// desde BSD el marcador, el estado y los goles (con autor) de los partidos de
// la FPC no terminados, y revela (visible:true) las predicciones de los que ya
// arrancaron. Misma fuente y misma lógica que live-updates.js (ver ese archivo).
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, BSD_API_KEY, CRON_SECRET (opc).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const BSD_LEAGUE = 80;
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
function bogotaDateStr(ms) { return new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10); }

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
function mapBsdStatus(bsdStatus, kickoffPassed) {
  const s = (bsdStatus || '').toLowerCase();
  if (/finish|ended|\bft\b|after|aet|pen|awarded|walkover/.test(s) || s === 'finished') return 'finished';
  if (s === 'notstarted' || s === 'postponed' || s === 'canceled' || s === 'cancelled') return kickoffPassed ? 'live' : 'scheduled';
  return 'live';
}
function goalsFromIncidents(incidents) {
  if (!Array.isArray(incidents)) return [];
  return incidents.filter(i => i.type === 'goal').map(i => ({
    team: i.is_home ? 'home' : 'away',
    minute: (i.minute == null ? null : i.minute),
    player: i.player || null,
    playerId: (i.player_id == null ? null : String(i.player_id)),
    goalType: i.goal_type || null
  })).sort((a, b) => (a.minute || 0) - (b.minute || 0));
}
async function bsdGet(path) {
  const r = await fetch('https://sports.bzzoiro.com' + path, { headers: { 'Authorization': 'Token ' + process.env.BSD_API_KEY } });
  if (!r.ok) throw new Error('BSD HTTP ' + r.status);
  return r.json();
}
async function revealPredictions(matchDoc) {
  const predsSnap = await matchDoc.ref.collection('predictions').get();
  let revealed = 0;
  for (const predDoc of predsSnap.docs) {
    if (predDoc.data().visible !== true) { await predDoc.ref.update({ visible: true }); revealed++; }
  }
  return revealed;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    const querySecret = req.query && req.query.secret;
    const authorized = authHeader === `Bearer ${process.env.CRON_SECRET}` || querySecret === process.env.CRON_SECRET;
    if (!authorized) { res.status(401).json({ error: 'No autorizado' }); return; }
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }
  if (!process.env.BSD_API_KEY) { res.status(500).json({ error: 'Falta configurar BSD_API_KEY en Vercel.' }); return; }

  try {
    const db = getDb();
    const now = Date.now();
    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    let predictionsRevealed = 0;
    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      const st = matchStatus(m);
      if (st === 'scheduled') continue;
      if (st === 'finished' && m.predictionsFullyRevealed === true) continue;
      predictionsRevealed += await revealPredictions(matchDoc);
      if (st === 'finished') { try { await matchDoc.ref.update({ predictionsFullyRevealed: true }); } catch (e) {} }
    }

    let updated = 0;
    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      if (matchCompetition(m) !== 'fpc') continue;
      if (matchStatus(m) === 'finished') continue;
      if (!m.kickoff || m.kickoff > now) continue; // solo los que ya deberían haber arrancado

      const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
      try {
        let bsdMatchId = m.bsdMatchId, detail = null;
        if (bsdMatchId) {
          detail = await bsdGet('/api/matches/' + bsdMatchId + '/?full=true&tz=America/Bogota');
        } else if (home && away) {
          // Ventana de ±1 día (ver la misma nota en api/live-updates.js).
          const dFrom = bogotaDateStr(m.kickoff - 86400000);
          const dTo = bogotaDateStr(m.kickoff + 86400000);
          const list = await bsdGet('/api/matches/?league=' + BSD_LEAGUE + '&date_from=' + dFrom + '&date_to=' + dTo + '&full=true&tz=America/Bogota&page_size=60');
          const hId = bsdTeamId(home), aId = bsdTeamId(away);
          const ev = (list.results || []).find(e => (e.home_team_obj && e.home_team_obj.id) === hId && (e.away_team_obj && e.away_team_obj.id) === aId);
          if (ev) { bsdMatchId = String(ev.id); detail = ev; }
        }
        if (!detail) continue;

        const updates = { goals: goalsFromIncidents(detail.incidents), status: mapBsdStatus(detail.status, true) };
        if (bsdMatchId && bsdMatchId !== m.bsdMatchId) updates.bsdMatchId = bsdMatchId;
        if (detail.home_score != null) updates.homeScore = detail.home_score;
        if (detail.away_score != null) updates.awayScore = detail.away_score;
        await matchDoc.ref.update(updates);
        updated++;
      } catch (e) { /* seguimos con los demás */ }
    }

    res.status(200).json({ updated, predictionsRevealed });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando resultados', details: String(err) });
  }
}
