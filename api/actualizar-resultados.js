// Función serverless (Vercel Cron) que actualiza automáticamente los resultados
// de los partidos pendientes en Firestore, sin necesidad de abrir la app.
//
// Se ejecuta automáticamente 2 veces al día vía Vercel Cron (ver vercel.json).
// Usa el Admin SDK de Firebase (permisos de servidor, no las reglas del cliente)
// para leer/escribir directamente en Firestore.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - API_FOOTBALL_KEY: API key de API-Football
//   - CRON_SECRET (opcional): si está configurada, Vercel Cron la envía como
//     "Authorization: Bearer <CRON_SECRET>" y este endpoint rechaza cualquier
//     llamada que no la incluya, para que no cualquiera pueda dispararlo.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const LEAGUE_ID = 239; // Liga BetPlay Dimayor / Primera A Colombia

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel.' });
    return;
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' });
    return;
  }

  try {
    const db = getDb();

    // Los partidos y equipos viven como documentos individuales en
    // 'profetas/matches/matches/{id}' y 'profetas/teams/teams/{id}'
    // (no como un array dentro de un único documento).
    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    const matchDocs = matchesSnap.docs;

    const pendingDocs = matchDocs.filter(d => {
      const m = d.data();
      return (m.homeScore === null || m.homeScore === undefined) && m.kickoff;
    });

    if (!pendingDocs.length) {
      res.status(200).json({ updated: 0, message: 'No hay partidos pendientes con fecha para revisar.' });
      return;
    }

    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    const dates = Array.from(new Set(pendingDocs.map(d => d.data().kickoff.slice(0, 10))));
    let updatedCount = 0;

    for (const date of dates) {
      const dayDocs = pendingDocs.filter(d => d.data().kickoff.slice(0, 10) === date);
      const season = new Date(date).getFullYear();
      const url = `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=${season}&date=${date}`;

      const apiRes = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
      const apiData = await apiRes.json();
      const fixtures = apiData.response || [];

      for (const fx of fixtures) {
        if (fx.fixture.status.short !== 'FT') continue;
        for (const matchDoc of dayDocs) {
          const m = matchDoc.data();
          if (m.homeScore !== null && m.homeScore !== undefined) continue;
          const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
          if (!home || !away) continue;
          const homeMatches = fx.teams.home.name.toLowerCase().indexOf(home.name.toLowerCase().split(' ')[0]) >= 0;
          const awayMatches = fx.teams.away.name.toLowerCase().indexOf(away.name.toLowerCase().split(' ')[0]) >= 0;
          if (homeMatches && awayMatches) {
            await matchDoc.ref.update({ homeScore: fx.goals.home, awayScore: fx.goals.away });
            updatedCount++;
          }
        }
      }
    }

    res.status(200).json({ updated: updatedCount });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando resultados', details: String(err) });
  }
}
