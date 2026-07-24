// Función serverless que actualiza 'profetas/players/players' desde BSD
// (Bzzoiro Sports Data, sports.bzzoiro.com) — para el selector de Goleador
// de pre-temporada.
//
// POR QUÉ BSD (probado con evidencia real, 2026-07-24):
// Antes se usó ESPN (nóminas incompletas, casi sin fotos) y luego
// API-Football (bueno, pero con límite de 10/min y 100/día que reventaba
// justo cuando se necesitaba). BSD cubre la Categoría Primera A completa
// (liga 80, los 20 equipos), trae la nómina entera en UNA sola llamada por
// equipo (sin paginación), con NOMBRE COMPLETO, posición (G/D/M/F) y —lo más
// importante— NO tiene ningún límite de peticiones. Las fotos vienen por un
// proxy público aparte: https://sports.bzzoiro.com/img/player/{id}/ (sin
// key). Se verificó que ~90% de los jugadores de la Primera A tienen foto
// real (incluido Hugo Rodallega); el ~10% que no la tiene da 404, y el
// navegador cae a iniciales solo en ese caso (ver playerAvatarHtml en app.js).
//
// Como no hay límite, esto trae los 20 equipos de una sola vez (nada de
// tandas ni pausas). Y en vez de borrar toda la colección al empezar (lo que
// con API-Football destruía lo bueno si una corrida fallaba), reemplaza EQUIPO
// POR EQUIPO: solo toca los equipos que se trajeron bien; si alguno falla,
// sus jugadores anteriores quedan intactos.
//
// Protegida verificando el ID token de Firebase de quien llama (claim
// admin:true), igual que exige firestore.rules para escribir en 'players'.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (texto)
//   - BSD_API_KEY: la key de BSD (se manda como "Authorization: Token <key>")

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

export const config = { maxDuration: 60 };

// IDs de equipo de BSD (liga 80 = Categoría Primera A), sacados de la página
// pública de la liga y verificados el 2026-07-24. La clave es el nombre de
// NUESTRO equipo normalizado (sin tildes, minúsculas). Si algún día cambia la
// liga (equipo ascendido), aparecerá en 'unmappedTeams' en la respuesta y hay
// que agregar su ID aquí (se saca de https://sports.bzzoiro.com/leagues/80/).
const BSD_TEAM_IDS = {
  'alianza fc': 4783,            // Alianza Valledupar FC
  'america de cali': 753,
  'atletico bucaramanga': 771,
  'atletico nacional': 766,
  'boyaca chico': 4784,         // Boyacá Chicó FC
  'cucuta deportivo': 4635,
  'deportes tolima': 781,
  'deportivo cali': 3733,
  'deportivo pasto': 3419,
  'deportivo pereira': 4780,
  'fortaleza ceif': 4782,       // Fortaleza FC
  'independiente medellin': 786,
  'independiente santa fe': 797,
  'internacional de bogota': 3181,
  'jaguares de cordoba': 4785,
  'junior': 789,                // Junior Barranquilla
  'llaneros': 4781,             // Llaneros FC
  'millonarios': 736,
  'once caldas': 3891,
  'aguilas doradas': 4786       // Rionegro Águilas Doradas
};

// BSD usa G/D/M/F. Goleador = todos los que pueden marcar: delanteros (F) y
// volantes (M). Se excluyen arqueros (G) y defensas (D).
const OFFENSIVE_POSITIONS = ['F', 'M'];

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

function normalizeTeamName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

async function fetchSquad(bsdId, key) {
  const url = `https://sports.bzzoiro.com/api/players/?team=${bsdId}&page_size=100`;
  const r = await fetch(url, {
    headers: { 'Authorization': 'Token ' + key },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const body = await r.json();
  return Array.isArray(body.results) ? body.results : [];
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

    const key = process.env.BSD_API_KEY;
    const db = getFirestore();
    const playersCol = db.collection('profetas').doc('players').collection('players');

    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const fpcTeams = teamsSnap.docs.map(d => d.data()).filter(t => t.competition !== 'mundial');

    const unmappedTeams = [];
    const failedTeams = [];
    const newPlayers = [];
    const succeededTeamIds = new Set();

    // BSD no tiene límite de peticiones, así que se traen los 20 equipos de
    // corrido (cada llamada ~0.5s).
    for (const t of fpcTeams) {
      const bsdId = BSD_TEAM_IDS[normalizeTeamName(t.name)];
      if (!bsdId) { unmappedTeams.push(t.name); continue; }
      let players;
      try {
        players = await fetchSquad(bsdId, key);
      } catch (e) {
        failedTeams.push(t.name);
        continue;
      }
      succeededTeamIds.add(t.id);
      for (const p of players) {
        if (OFFENSIVE_POSITIONS.indexOf(p.position) < 0) continue;
        newPlayers.push({
          id: 'bsd-' + p.id,
          bsdId: String(p.id),
          name: p.name || p.short_name || '?',
          teamId: t.id,
          teamName: t.name,
          position: p.position,
          number: (p.jersey_number == null ? null : p.jersey_number),
          // Foto por el proxy público de BSD. Puede dar 404 (~10% de los
          // jugadores no tienen foto); el navegador cae a iniciales en ese
          // caso (ver playerAvatarHtml). Se guarda igual la URL.
          photoUrl: 'https://sports.bzzoiro.com/img/player/' + p.id + '/'
        });
      }
    }

    // Reemplazo EQUIPO POR EQUIPO: se borran los jugadores anteriores solo de
    // los equipos que se trajeron bien en esta corrida, y se escriben los
    // nuevos. Los equipos que fallaron conservan sus jugadores de antes — así
    // una corrida a medias nunca destruye lo que ya estaba bueno (el error de
    // diseño que tuvimos con API-Football).
    const existing = await playersCol.get();
    const toDelete = existing.docs.filter(doc => {
      const tid = doc.data().teamId;
      return succeededTeamIds.has(tid);
    });

    let batch = db.batch(); let ops = 0;
    async function commitIfFull() { ops++; if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; } }
    for (const doc of toDelete) { batch.delete(doc.ref); await commitIfFull(); }
    for (const p of newPlayers) { batch.set(playersCol.doc(p.id), p); await commitIfFull(); }
    if (ops > 0) await batch.commit();

    res.status(200).json({
      ok: true,
      totalTeams: fpcTeams.length - unmappedTeams.length,
      teamsSucceeded: succeededTeamIds.size,
      playersSaved: newPlayers.length,
      failedTeams,
      unmappedTeams
    });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando jugadores', details: String(err) });
  }
}
