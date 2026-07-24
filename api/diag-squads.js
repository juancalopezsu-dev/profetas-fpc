// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
// Prueba las nóminas de los 5 equipos que fallaron para el usuario, con
// pausa de 7s entre llamadas (bajo el límite de 10/min). Reporta el conteo
// real o el error crudo de API-Football (para distinguir rate-limit,
// límite diario, o nómina genuinamente vacía). Nunca devuelve la API key.

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Falta API_FOOTBALL_KEY.' }); return; }
  const HOST = 'https://v3.football.api-sports.io';
  const headers = { 'x-apisports-key': apiKey };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 1470 Cúcuta, 1142 Tolima, 1127 Cali, 1133 Jaguares, 1135 Junior
  const targets = { '1470': 'Cucuta', '1142': 'Tolima', '1127': 'Cali', '1133': 'Jaguares', '1135': 'Junior' };
  const out = {};
  try {
    let first = true;
    for (const id of Object.keys(targets)) {
      if (!first) await sleep(7000);
      first = false;
      const r = await fetch(`${HOST}/players/squads?team=${id}`, { headers });
      const body = await r.json();
      const resp = body.response && body.response[0];
      out[targets[id] + ' (' + id + ')'] = {
        httpStatus: r.status,
        errorsRaw: body.errors,           // aquí saldría rate-limit / límite diario si aplica
        results: body.results,
        teamName: resp ? resp.team.name : null,
        playerCount: resp ? resp.players.length : 0
      };
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err), partial: out });
  }
}
