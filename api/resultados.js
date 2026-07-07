// Función serverless (Vercel) que consulta API-Football.
// La API key vive SOLO aquí, como variable de entorno del servidor (API_FOOTBALL_KEY),
// nunca en el código del navegador. Esto evita exponerla públicamente en GitHub.
//
// Uso desde el navegador: GET /api/resultados?date=2026-07-12
// Liga BetPlay Dimayor (Primera A) = league id 239 en API-Football.

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel (Settings > Environment Variables).' });
    return;
  }

  const { date } = req.query;
  if (!date) {
    res.status(400).json({ error: 'Falta el parámetro date, ej. ?date=2026-07-12' });
    return;
  }

  const LEAGUE_ID = 239; // Liga BetPlay Dimayor / Primera A Colombia
  const SEASON = new Date(date).getFullYear();

  try {
    const url = `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=${SEASON}&date=${date}`;
    const apiRes = await fetch(url, {
      headers: { 'x-apisports-key': apiKey }
    });
    const data = await apiRes.json();

    if (data.errors && Object.keys(data.errors).length) {
      res.status(502).json({ error: 'API-Football devolvió un error', details: data.errors });
      return;
    }

    const fixtures = (data.response || []).map(f => ({
      homeTeam: f.teams.home.name,
      awayTeam: f.teams.away.name,
      homeScore: f.goals.home,
      awayScore: f.goals.away,
      status: f.fixture.status.short, // ej. "FT" = finalizado, "NS" = no ha empezado
      date: f.fixture.date
    }));

    res.status(200).json({ fixtures });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando API-Football', details: String(err) });
  }
}
