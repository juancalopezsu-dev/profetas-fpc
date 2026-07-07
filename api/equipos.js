// Función serverless (Vercel) que consulta los equipos de la liga en API-Football
// para obtener sus escudos oficiales (team.logo). La API key vive SOLO aquí,
// como variable de entorno del servidor (API_FOOTBALL_KEY).
//
// Uso desde el navegador: GET /api/equipos
// Liga BetPlay Dimayor (Primera A) = league id 239 en API-Football.

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel (Settings > Environment Variables).' });
    return;
  }

  const LEAGUE_ID = 239; // Liga BetPlay Dimayor / Primera A Colombia
  const SEASON = 2026;

  try {
    const url = `https://v3.football.api-sports.io/teams?league=${LEAGUE_ID}&season=${SEASON}`;
    const apiRes = await fetch(url, {
      headers: { 'x-apisports-key': apiKey }
    });
    const data = await apiRes.json();

    if (data.errors && Object.keys(data.errors).length) {
      res.status(502).json({ error: 'API-Football devolvió un error', details: data.errors });
      return;
    }

    const teams = (data.response || []).map(t => ({
      name: t.team.name,
      logo: t.team.logo
    }));

    res.status(200).json({ teams });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando API-Football', details: String(err) });
  }
}
