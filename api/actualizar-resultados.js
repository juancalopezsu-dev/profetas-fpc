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

    const matchesRef = db.collection('profetas').doc('matches');
    const matchesSnap = await matchesRef.get();
    const matchesData = matchesSnap.exists ? matchesSnap.data() : { matches: [], predictions: {} };
    const matches = matchesData.matches || [];

    const pending = matches.filter(m =>
      (m.homeScore === null || m.homeScore === undefined) && m.kickoff
    );

    if (!pending.length) {
      res.status(200).json({ updated: 0, message: 'No hay partidos pendientes con fecha para revisar.' });
      return;
    }

    const teamsSnap = await db.collection('profetas').doc('teams').get();
    const teams = teamsSnap.exists ? (teamsSnap.data().list || []) : [];
    const teamById = id => teams.find(t => t.id === id);

    const dates = Array.from(new Set(pending.map(m => m.kickoff.slice(0, 10))));
    let updatedCount = 0;

    for (const date of dates) {
      const dayMatches = pending.filter(m => m.kickoff.slice(0, 10) === date);
      const season = new Date(date).getFullYear();
      const url = `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=${season}&date=${date}`;

      const apiRes = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
      const apiData = await apiRes.json();
      const fixtures = apiData.response || [];

      fixtures.forEach(fx => {
        if (fx.fixture.status.short !== 'FT') return;
        dayMatches.forEach(m => {
          if (m.homeScore !== null && m.homeScore !== undefined) return;
          const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
          if (!home || !away) return;
          const homeMatches = fx.teams.home.name.toLowerCase().indexOf(home.name.toLowerCase().split(' ')[0]) >= 0;
          const awayMatches = fx.teams.away.name.toLowerCase().indexOf(away.name.toLowerCase().split(' ')[0]) >= 0;
          if (homeMatches && awayMatches) {
            m.homeScore = fx.goals.home;
            m.awayScore = fx.goals.away;
            updatedCount++;
          }
        });
      });
    }

    if (updatedCount > 0) {
      await matchesRef.set({ matches, predictions: matchesData.predictions || {} });
    }

    res.status(200).json({ updated: updatedCount });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando resultados', details: String(err) });
  }
}
