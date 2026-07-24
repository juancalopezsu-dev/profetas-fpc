// Función serverless: importa los próximos partidos de la FPC desde BSD y los
// crea en Firestore (para que no haya que agregarlos a mano en Gestionar).
//
// Disparada por el botón "Importar partidos de la FPC" en Gestionar. Trae los
// fixtures 'notstarted' de la liga 80 (Categoría Primera A) en hora de Bogotá,
// mapea cada equipo de BSD a NUESTRO equipo, y crea un partido por cada uno
// que todavía no exista (dedupe por el id 'bsd-<bsdMatchId>'). Los crea con
// competition:'fpc', phase:'regular' (el admin ajusta la fase si es
// cuadrangular/final) y guarda 'bsdMatchId' para que después live-updates.js
// pueda pedirle a BSD el marcador y los goles de ESE partido.
//
// Protegida con el ID token de Firebase de quien llama (claim admin:true).
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, BSD_API_KEY.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// bsd team id -> nombre normalizado de NUESTRO equipo (ver el mismo mapa, al
// revés, en api/actualizar-jugadores.js). Verificado el 2026-07-24.
const BSD_ID_TO_OURNAME = {
  4783: 'alianza fc', 753: 'america de cali', 771: 'atletico bucaramanga',
  766: 'atletico nacional', 4784: 'boyaca chico', 4635: 'cucuta deportivo',
  781: 'deportes tolima', 3733: 'deportivo cali', 3419: 'deportivo pasto',
  4780: 'deportivo pereira', 4782: 'fortaleza ceif', 786: 'independiente medellin',
  797: 'independiente santa fe', 3181: 'internacional de bogota', 4785: 'jaguares de cordoba',
  789: 'junior', 4781: 'llaneros', 736: 'millonarios', 3891: 'once caldas', 4786: 'aguilas doradas'
};
// Respaldo por nombre exacto de BSD (si el fixture no trae el objeto de equipo).
const BSD_NAME_TO_ID = {
  'alianza valledupar fc': 4783, 'america de cali': 753, 'atletico bucaramanga': 771,
  'atletico nacional': 766, 'boyaca chico fc': 4784, 'cucuta deportivo': 4635,
  'deportes tolima': 781, 'deportivo cali': 3733, 'deportivo pasto': 3419,
  'deportivo pereira': 4780, 'fortaleza fc': 4782, 'independiente medellin': 786,
  'independiente santa fe': 797, 'internacional de bogota': 3181, 'jaguares de cordoba': 4785,
  'junior barranquilla': 789, 'llaneros fc': 4781, 'millonarios': 736,
  'once caldas': 3891, 'rionegro aguilas doradas': 4786
};

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Del fixture de BSD saca el bsd team id (preferimos el objeto de equipo; si
// no, el nombre) y de ahí NUESTRO equipo.
function ourTeamFor(fixtureTeamObj, fixtureTeamName, ourTeamsByNorm) {
  let bsdId = fixtureTeamObj && fixtureTeamObj.id ? fixtureTeamObj.id : null;
  if (!bsdId) bsdId = BSD_NAME_TO_ID[norm(fixtureTeamName)] || null;
  if (!bsdId) return null;
  const ourNorm = BSD_ID_TO_OURNAME[bsdId];
  if (!ourNorm) return null;
  return ourTeamsByNorm[ourNorm] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido (usa POST).' }); return; }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }
  if (!process.env.BSD_API_KEY) { res.status(500).json({ error: 'Falta configurar BSD_API_KEY en Vercel.' }); return; }

  try {
    getApp();
    const auth = getAuth();
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) { res.status(401).json({ error: 'Falta el token de sesión.' }); return; }
    let decoded;
    try { decoded = await auth.verifyIdToken(idToken); }
    catch (e) { res.status(401).json({ error: 'Token inválido o vencido. Vuelve a entrar como administrador.' }); return; }
    if (decoded.admin !== true) { res.status(403).json({ error: 'Esta acción es solo para administradores.' }); return; }

    const db = getFirestore();
    const matchesCol = db.collection('profetas').doc('matches').collection('matches');

    // Nuestros equipos FPC, indexados por nombre normalizado.
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const ourTeamsByNorm = {};
    teamsSnap.docs.map(d => d.data()).filter(t => t.competition !== 'mundial')
      .forEach(t => { ourTeamsByNorm[norm(t.name)] = t; });

    // Partidos que ya existen (para no duplicar). Se deduplica por el id del
    // documento Y por el bsdMatchId ya guardado — porque un partido pudo
    // haberse creado antes a mano (id aleatorio) y luego live-updates.js le
    // emparejó su bsdMatchId; en ese caso NO hay que volver a crearlo.
    const existingSnap = await matchesCol.get();
    const existingIds = new Set(existingSnap.docs.map(d => d.id));
    const existingBsdIds = new Set(existingSnap.docs.map(d => d.data().bsdMatchId).filter(Boolean).map(String));
    // Partidos FPC ya existentes SIN bsdMatchId, indexados por par de equipos,
    // para "enlazarlos" (guardarles el bsdMatchId) en vez de duplicarlos si el
    // mismo enfrentamiento ya estaba creado a mano.
    const unlinkedByPair = {};
    existingSnap.docs.forEach(d => {
      const m = d.data();
      if (!m.bsdMatchId && (m.competition !== 'mundial') && m.homeTeamId && m.awayTeamId) {
        unlinkedByPair[m.homeTeamId + '|' + m.awayTeamId] = d.ref;
      }
    });

    // Fixtures próximos de BSD.
    const url = 'https://sports.bzzoiro.com/api/matches/?league=80&status=notstarted&tz=America/Bogota&page_size=50';
    const r = await fetch(url, { headers: { 'Authorization': 'Token ' + process.env.BSD_API_KEY } });
    if (!r.ok) { res.status(502).json({ error: 'BSD respondió ' + r.status + ' al pedir los partidos.' }); return; }
    const body = await r.json();
    const fixtures = body.results || [];

    let created = 0, skippedExisting = 0, linked = 0;
    const unmapped = [];
    let batch = db.batch(); let ops = 0;
    async function commitIfFull() { ops++; if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; } }

    for (const f of fixtures) {
      const docId = 'bsd-' + f.id;
      if (existingIds.has(docId) || existingBsdIds.has(String(f.id))) { skippedExisting++; continue; }
      const home = ourTeamFor(f.home_team_obj, f.home_team, ourTeamsByNorm);
      const away = ourTeamFor(f.away_team_obj, f.away_team, ourTeamsByNorm);
      if (!home || !away) { unmapped.push((f.home_team || '?') + ' vs ' + (f.away_team || '?')); continue; }
      // ¿Ya existe este mismo enfrentamiento creado a mano (sin bsdMatchId)?
      // Entonces solo lo enlazamos, no lo duplicamos.
      const pairRef = unlinkedByPair[home.id + '|' + away.id];
      if (pairRef) {
        batch.update(pairRef, { bsdMatchId: String(f.id) });
        linked++;
        delete unlinkedByPair[home.id + '|' + away.id];
        await commitIfFull();
        continue;
      }
      const kickoff = f.event_date ? new Date(f.event_date).getTime() : null;
      batch.set(matchesCol.doc(docId), {
        id: docId,
        bsdMatchId: String(f.id),
        homeTeamId: home.id,
        awayTeamId: away.id,
        kickoff: kickoff,
        phase: 'regular',
        competition: 'fpc',
        homeScore: null,
        awayScore: null,
        status: 'scheduled',
        goals: []
      });
      created++;
      await commitIfFull();
    }
    if (ops > 0) await batch.commit();

    res.status(200).json({ ok: true, created, linked, skippedExisting, unmapped, fixturesFound: fixtures.length });
  } catch (err) {
    res.status(500).json({ error: 'Error importando partidos', details: String(err) });
  }
}
