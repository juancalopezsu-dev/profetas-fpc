// Función serverless que actualiza 'profetas/players/players' desde API-Football
// (para el selector de Goleador de pre-temporada).
//
// POR QUÉ API-FOOTBALL Y NO ESPN (probado con evidencia real, 2026-07-24):
// ESPN traía nóminas incompletas e inconsistentes para la col.1 (registros
// fantasma como "Yon Rodallega", equipos que fallaban en silencio) y casi sin
// fotos (solo ~8 jugadores en toda la liga tenían headshot). API-Football, en
// cambio, devuelve nóminas completas y estables, con posición limpia
// (Attacker/Midfielder/Defender/Goalkeeper) y URL de foto para TODOS los
// jugadores (la mayoría reales; unos pocos con una silueta genérica). El
// bloqueo anterior de API-Football era solo por TEMPORADA y solo en
// fixtures/teams — el endpoint de nóminas (/players/squads?team=ID) NO
// depende de temporada y funciona con el plan gratis.
//
// DOS RESTRICCIONES REALES DEL PLAN GRATIS (verificadas):
//  1. /teams?league=239&season=X solo deja consultar 2022-2024 ("Free plans
//     do not have access to this season"). Por eso NO se piden los IDs de
//     equipo en vivo: se dejan fijos abajo (AF_TEAM_IDS), verificados uno por
//     uno contra la nómina real de cada equipo.
//  2. Límite de 10 peticiones por minuto. Como son 20 equipos (20 llamadas a
//     squads), no caben en una sola invocación de Vercel (tope 60s en Hobby).
//     Por eso esto trabaja POR TANDAS: el navegador llama con ?offset=0, luego
//     offset=6, etc. (ver el bucle en app.js). Cada tanda procesa unos pocos
//     equipos con pausa de 7s entre llamadas (para no pasar de 10/min) y
//     escribe esos jugadores; en offset 0 primero borra la colección entera
//     para no dejar jugadores viejos.
//
// Protegida verificando el ID token de Firebase de quien llama (claim
// admin:true), igual que exige firestore.rules para escribir en 'players'.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (texto)
//   - API_FOOTBALL_KEY: la key de API-Football (ya configurada)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Vercel Hobby permite hasta 60s por función; lo pedimos explícito porque una
// tanda con pausas de 7s puede acercarse a los 45s.
export const config = { maxDuration: 60 };

// IDs de equipo de API-Football, fijos y verificados el 2026-07-24 (cada uno
// se comprobó pidiendo su nómina real). La clave es el nombre de NUESTRO
// equipo normalizado (sin tildes, minúsculas). API-Football bloquea /teams
// para 2025/2026 en el plan gratis, así que no se pueden pedir en vivo — pero
// los IDs son estables entre temporadas. Si algún día cambia la liga (equipo
// nuevo/ascendido), aparecerá en 'unmappedTeams' en la respuesta y hay que
// agregar su ID aquí (se saca con /teams?search=<nombre>).
const AF_TEAM_IDS = {
  'millonarios': 1125,
  'deportivo pasto': 1126,
  'deportivo cali': 1127,
  'independiente medellin': 1128,
  'atletico bucaramanga': 1131,
  'boyaca chico': 1132,
  'jaguares de cordoba': 1133,
  'internacional de bogota': 1134,
  'junior': 1135,
  'once caldas': 1136,
  'atletico nacional': 1137,
  'america de cali': 1138,
  'independiente santa fe': 1139,
  'alianza fc': 1141,
  'deportes tolima': 1142,
  'aguilas doradas': 1144,
  'fortaleza ceif': 1147,
  'deportivo pereira': 1462,
  'llaneros': 1464,
  'cucuta deportivo': 1470
};

const OFFENSIVE_POSITIONS = ['Attacker', 'Midfielder'];
const CHUNK_SIZE = 5;      // equipos por tanda (5 * 8s = 40s, con margen bajo el tope de 60s de Vercel)
const PACE_MS = 8000;      // pausa entre llamadas para no pasar de 10/min (con holgura)

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeTeamName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

// Algunos nombres de API-Football vienen mal codificados (UTF-8 leído como
// latin1), ej. "J. RamÃ­rez" en vez de "J. Ramírez". Solo intentamos
// arreglarlo si el nombre trae la firma del problema (Ã/Â), para no dañar
// los que ya están bien.
function fixMojibake(name) {
  if (!name || !/[ÃÂ]/.test(name)) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

async function fetchSquad(afId, apiKey) {
  const url = `https://v3.football.api-sports.io/players/squads?team=${afId}`;
  const r = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
  const body = await r.json();
  if (body.errors && Object.keys(body.errors).length) {
    throw new Error(JSON.stringify(body.errors));
  }
  const resp = body.response && body.response[0];
  return resp ? resp.players : [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido (usa POST).' }); return; }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }
  if (!process.env.API_FOOTBALL_KEY) { res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel.' }); return; }

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

    const body = req.body || {};
    const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
    // Modo reintento: el navegador manda los nombres de los equipos que
    // fallaron en la pasada normal (por el límite de 10/min de API-Football)
    // para volver a intentarlos, ya con el límite recuperado. En este modo
    // NO se borra la colección ni se avanza por 'offset' — solo se procesan
    // esos equipos puntuales.
    const retryTeams = Array.isArray(body.retryTeams) ? body.retryTeams : null;
    const apiKey = process.env.API_FOOTBALL_KEY;
    const db = getFirestore();
    const playersCol = db.collection('profetas').doc('players').collection('players');

    // Lista ordenada y estable de NUESTROS equipos FPC mapeados a su ID de
    // API-Football. El orden (por nombre) tiene que ser el mismo en cada
    // tanda para que 'offset' siempre apunte al mismo equipo.
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const fpcTeams = teamsSnap.docs.map(d => d.data())
      .filter(t => t.competition !== 'mundial')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const mapped = [];
    const unmappedTeams = [];
    for (const t of fpcTeams) {
      const afId = AF_TEAM_IDS[normalizeTeamName(t.name)];
      if (afId) mapped.push({ teamId: t.id, teamName: t.name, afId });
      else unmappedTeams.push(t.name);
    }

    // En la primera tanda normal (offset 0, no reintento), borrar la colección
    // entera para no dejar jugadores viejos (ej. de la fuente ESPN anterior o
    // de un equipo que ya no está).
    if (!retryTeams && offset === 0) {
      const existing = await playersCol.get();
      let delBatch = db.batch(); let n = 0;
      for (const doc of existing.docs) {
        delBatch.delete(doc.ref); n++;
        if (n >= 450) { await delBatch.commit(); delBatch = db.batch(); n = 0; }
      }
      if (n > 0) await delBatch.commit();
    }

    const slice = retryTeams
      ? mapped.filter(m => retryTeams.indexOf(m.teamName) >= 0)
      : mapped.slice(offset, offset + CHUNK_SIZE);
    let savedThisChunk = 0;
    const chunkErrors = [];
    let batch = db.batch(); let ops = 0;
    async function commitIfFull() { ops++; if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; } }

    for (const m of slice) {
      // Pausa ANTES de cada llamada (incluida la primera de la tanda) para
      // garantizar el espaciado de 7s también entre tandas consecutivas.
      await sleep(PACE_MS);
      let players;
      try {
        players = await fetchSquad(m.afId, apiKey);
      } catch (e) {
        chunkErrors.push({ team: m.teamName, error: String(e) });
        continue;
      }
      for (const p of players) {
        if (OFFENSIVE_POSITIONS.indexOf(p.position) < 0) continue;
        batch.set(playersCol.doc('af-' + p.id), {
          id: 'af-' + p.id,
          apiFootballId: String(p.id),
          name: fixMojibake(p.name) || '?',
          teamId: m.teamId,
          teamName: m.teamName,
          position: p.position,
          number: (p.number == null ? null : p.number),
          photoUrl: p.photo || null
        });
        savedThisChunk++;
        await commitIfFull();
      }
    }
    if (ops > 0) await batch.commit();

    if (retryTeams) {
      res.status(200).json({
        ok: true,
        retry: true,
        totalTeams: mapped.length,
        savedThisChunk,
        chunkErrors,
        unmappedTeams
      });
      return;
    }

    const nextOffset = offset + CHUNK_SIZE;
    const done = nextOffset >= mapped.length;

    res.status(200).json({
      ok: true,
      done,
      nextOffset: done ? null : nextOffset,
      totalTeams: mapped.length,
      processedSoFar: Math.min(nextOffset, mapped.length),
      savedThisChunk,
      unmappedTeams,
      chunkErrors
    });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando jugadores', details: String(err) });
  }
}
