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

// Descarta los "registros fantasma" de ESPN. Diagnosticado con evidencia
// real (2026-07-24): ESPN a veces tiene DOS registros para la misma persona
// — ej. Hugo Rodallega existe como id 131212 (delantero, con dorsal, fecha
// de nacimiento y estadísticas, en Santa Fe) Y como id 3097559 "Yon
// Rodallega" (volante, SIN dorsal, SIN fecha de nacimiento, SIN
// estadísticas, flotando en la nómina de Medellín). El segundo es un
// duplicado corrupto. Se comprobó que en toda la liga hay 5 registros con
// ese perfil vacío (sin dorsal NI fecha NI estadísticas). El usuario decidió
// (2026-07-24) filtrarlos, asumiendo el riesgo pequeño de que 1 de esos 5
// (Christian Negrete, Nacional) tenga un id de jugador normal y sea real con
// perfil incompleto — para un selector de GOLEADOR el costo es casi nulo:
// nadie sin dorsal, sin edad y sin un solo minuto registrado va a ser el
// goleador del torneo.
function isGhostRecord(a) {
  return !a.dateOfBirth && !a.jersey && !a.statistics;
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Diagnosticado con evidencia real (2026-07-24): pedirle a ESPN 20 planillas
// seguidas sin pausa hacía que algunas fallaran (probablemente límite de
// tasa) — 5 de 20 equipos se quedaron con 0 jugadores guardados en una
// corrida real, y el catch() vacío que había antes se lo tragaba en
// silencio, sin que quedara ningún rastro de cuáles fallaron ni por qué. Se
// confirmó que esos mismos 5 equipos responden perfecto al reintentar
// segundos después — no es un problema de los datos de ESPN, es que hay que
// tratar esta API como inestable bajo ráfagas y reintentar.
async function fetchJsonWithRetry(url, attempts = 3, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
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

    const teamsJson = await fetchJsonWithRetry('https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/teams');
    const league = teamsJson.sports && teamsJson.sports[0] && teamsJson.sports[0].leagues && teamsJson.sports[0].leagues[0];
    const espnTeams = league ? league.teams.map(t => t.team) : [];

    const newPlayers = [];
    const teamsNotFound = [];
    // A diferencia de teamsNotFound (nombre que no calzó con ningún equipo
    // de ESPN), esto son equipos que SÍ se encontraron pero cuya planilla
    // falló incluso después de reintentar — antes esto se perdía en
    // silencio (ver comentario de fetchJsonWithRetry arriba).
    const teamFetchErrors = [];
    const ghostsFiltered = []; // registros fantasma descartados (ver isGhostRecord)

    for (const t of fpcTeams) {
      const espnTeam = espnTeams.find(et => teamNameMatchesEspn(t.name, et.displayName));
      if (!espnTeam) { teamsNotFound.push(t.name); continue; }
      try {
        const rosterJson = await fetchJsonWithRetry(`https://site.api.espn.com/apis/site/v2/sports/soccer/col.1/teams/${espnTeam.id}/roster`);
        const athletes = rosterJson.athletes || [];
        athletes.forEach(a => {
          const abbr = a.position && a.position.abbreviation;
          if (OFFENSIVE_POSITION_ABBRS.indexOf(abbr) < 0) return;
          if (isGhostRecord(a)) { ghostsFiltered.push(a.displayName + ' (' + t.name + ')'); return; }
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
      } catch (e) {
        teamFetchErrors.push({ team: t.name, error: String(e) });
      }
      // Pausa corta entre equipos para no golpear a ESPN con 20 solicitudes
      // seguidas de una — esa ráfaga fue justo lo que causó las fallas que
      // se diagnosticaron el 2026-07-24.
      await sleep(200);
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
      teamsMatched: fpcTeams.length - teamsNotFound.length - teamFetchErrors.length,
      teamsTotal: fpcTeams.length,
      teamsNotFound,
      teamFetchErrors,
      ghostsFiltered
    });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando jugadores', details: String(err) });
  }
}
