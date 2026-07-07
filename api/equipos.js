// Función serverless (Vercel) que consulta los equipos de la liga en API-Football
// para obtener sus escudos oficiales (team.logo). La API key vive SOLO aquí,
// como variable de entorno del servidor (API_FOOTBALL_KEY).
//
// Uso desde el navegador: GET /api/equipos
// Liga BetPlay Dimayor (Primera A) = league id 239 en API-Football.
//
// Todo el cuerpo de la función vive dentro de un único try/catch para que
// cualquier error inesperado (JSON inválido, respuesta no-OK de la API,
// campos faltantes, etc.) se devuelva como JSON con detalle en vez de
// tumbar la función (502 "This Serverless Function has crashed").

const LEAGUE_ID = 239; // Liga BetPlay Dimayor / Primera A Colombia
const SEASON = 2026;

export default async function handler(req, res) {
  try {
    const apiKey = process.env.API_FOOTBALL_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel (Settings > Environment Variables).' });
      return;
    }

    const url = `https://v3.football.api-sports.io/teams?league=${LEAGUE_ID}&season=${SEASON}`;
    const apiRes = await fetch(url, {
      headers: { 'x-apisports-key': apiKey }
    });

    const rawText = await apiRes.text();

    if (!apiRes.ok) {
      res.status(502).json({
        error: 'API-Football respondió con un error HTTP',
        status: apiRes.status,
        statusText: apiRes.statusText,
        body: rawText.slice(0, 500)
      });
      return;
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      res.status(502).json({
        error: 'La respuesta de API-Football no es JSON válido',
        details: String(parseErr && parseErr.message || parseErr),
        body: rawText.slice(0, 500)
      });
      return;
    }

    if (data.errors && Object.keys(data.errors).length) {
      res.status(502).json({ error: 'API-Football devolvió un error', details: data.errors });
      return;
    }

    const teams = (data.response || [])
      .filter(function (t) { return t && t.team && t.team.name; })
      .map(function (t) { return { name: t.team.name, logo: t.team.logo || null }; });

    res.status(200).json({ teams });
  } catch (err) {
    res.status(500).json({
      error: 'Error consultando API-Football',
      details: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });
  }
}
