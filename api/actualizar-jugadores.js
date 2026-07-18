// Función serverless que actualiza 'profetas/players/players' desde la API
// de ESPN (para el selector de Goleador de pre-temporada).
//
// Esto empezó como una función 100% del lado del navegador (fetch directo a
// site.api.espn.com desde app.js), pero se comprobó con evidencia real que
// ESPN NO manda el header Access-Control-Allow-Origin en una solicitud
// fetch() real de navegador — un curl simple sin las cabeceras Sec-Fetch-*
// que cualquier navegador agrega solo (y que no se pueden quitar desde JS)
// sí recibía ese header, lo cual dio un falso positivo la primera vez que
// se probó. Se confirmó el bloqueo real de dos formas: con
// fetch(url,{mode:'no-cors'}) la solicitud SÍ llega y responde (el
// navegador solo bloquea leer la respuesta), y repitiendo el curl con las
// cabeceras Sec-Fetch-Mode/Sec-Fetch-Site que un navegador real manda, el
// header Access-Control-Allow-Origin deja de aparecer en la respuesta de
// ESPN. Por eso esto se movió acá: entre dos servidores no aplica CORS.
//
// Protegida verificando el ID token de Firebase de quien llama — tiene que
// traer el claim admin:true, el mismo que ya exigen las reglas de Firestore
// para escribir en 'players' (ver isAdmin() en firestore.rules). Se manda
// como "Authorization: Bearer <idToken>" desde app.js.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

// ESPN solo expone 4 posiciones para la col.1: Goalkeeper/Defender/
// Midfielder/Forward — no hay un valor separado para "extremo". Se probó la
// respuesta real de las 20 planillas (564 jugadores) antes de decidir este
// filtro: los extremos reales (ej. Yimmi Chará) vienen etiquetados como
// Midfielder, igual que los volantes de marca/contención puros, y probar un
// filtro por estadísticas ofensivas (goles/remates) como alternativa
// tampoco los separó limpiamente (hay volantes de marca con tantos remates
// como extremos, y titulares nuevos sin ninguna estadística todavía). Se
// decidió con el usuario (2026-07-18) incluir Forward + TODOS los
// Midfielder para no dejar a ningún extremo por fuera, aceptando que
// también entren algunos volantes de marca puros.
const OFFENSIVE_POSITION_ABBRS = ['F', 'M'];

// Mismo criterio que teamNameMatches() en api/live-updates.js (ver ese
// archivo para el porqué) — ESPN a veces agrega sufijos al nombre del equipo.
function teamNameMatchesEspn(ourName, espnName) {
  const a = (ourName || '').toLowerCase().trim();
  const b = (espnName || '').toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b || b.indexOf(a) >= 0 || a.indexOf(b) >= 0) return true;
  const aFirst = a.split(' ')[0];
  return aFirst.length > 3 && b.indexOf(aFirst) >= 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido (usa POST).' });
    return;
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' });
    return;
  }

  try {
    getApp();
    const auth = getAuth();

    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ error: 'Falta el token de sesión.' });
      return;
    }
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({ error: 'Token inválido o vencido. Vuelve a entrar como administrador.' });
      return;
    }
    if (decoded.admin !== true) {
      res.status(403).json({ error: 'Esta acción es solo para administradores.' });
      return;
    }

    const db = getFirestore();
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const fpcTeams = teamsSnap.docs.map(d => d.data()).filter(t => t.competition !== 'mundial');

    const teamsResp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/teams');
    const teamsJson = await teamsResp.json();
    const league = teamsJson.sports && teamsJson.sports[0] && teamsJson.sports[0].leagues && teamsJson.sports[0].leagues[0];
    const espnTeams = league ? league.teams.map(t => t.team) : [];

    const newPlayers = [];
    const teamsNotFound = [];

    for (const t of fpcTeams) {
      const espnTeam = espnTeams.find(et => teamNameMatchesEspn(t.name, et.displayName));
      if (!espnTeam) { teamsNotFound.push(t.name); continue; }
      try {
        const rosterResp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/teams/${espnTeam.id}/roster`);
        const rosterJson = await rosterResp.json();
        const athletes = rosterJson.athletes || [];
        athletes.forEach(a => {
          const abbr = a.position && a.position.abbreviation;
          if (OFFENSIVE_POSITION_ABBRS.indexOf(abbr) < 0) return;
          newPlayers.push({
            id: 'espn-' + a.id,
            espnId: String(a.id),
            name: a.displayName || a.fullName || '?',
            teamId: t.id,
            teamName: t.name,
            position: abbr || null,
            photoUrl: (a.headshot && a.headshot.href) ? a.headshot.href : null
          });
        });
      } catch (e) { /* seguimos con los demás equipos */ }
    }

    // Se reemplaza la lista completa (se borran los que ya no salieron en
    // esta corrida) para que un jugador que salió del equipo no se quede
    // como opción para siempre.
    const existingSnap = await db.collection('profetas').doc('players').collection('players').get();
    const newIds = new Set(newPlayers.map(p => p.id));
    const staleIds = existingSnap.docs.map(d => d.id).filter(id => !newIds.has(id));

    let batch = db.batch();
    let opsInBatch = 0;
    async function commitIfFull() {
      opsInBatch++;
      if (opsInBatch >= 450) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }
    const playersCol = db.collection('profetas').doc('players').collection('players');
    for (const p of newPlayers) {
      batch.set(playersCol.doc(p.id), p);
      await commitIfFull();
    }
    for (const id of staleIds) {
      batch.delete(playersCol.doc(id));
      await commitIfFull();
    }
    if (opsInBatch > 0) await batch.commit();

    res.status(200).json({
      ok: true,
      playersSaved: newPlayers.length,
      teamsMatched: fpcTeams.length - teamsNotFound.length,
      teamsTotal: fpcTeams.length,
      teamsNotFound
    });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando jugadores', details: String(err) });
  }
}
