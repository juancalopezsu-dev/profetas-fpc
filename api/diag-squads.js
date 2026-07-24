// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
// Versión mínima: solo 3 llamadas (bajo el límite de 10/min del plan gratis)
// para verificar que estos 3 IDs de equipo apuntan a nóminas reales antes de
// hardcodearlos. Nunca devuelve la API key.

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Falta API_FOOTBALL_KEY.' }); return; }
  const HOST = 'https://v3.football.api-sports.io';
  const headers = { 'x-apisports-key': apiKey };
  const out = {};
  try {
    // 1141 = Alianza (¿Valledupar/FC?), 1464 = Llaneros, 1470 = Cúcuta
    for (const id of [1141, 1464, 1470]) {
      const r = await fetch(`${HOST}/players/squads?team=${id}`, { headers });
      const body = await r.json();
      const resp = body.response && body.response[0];
      out[id] = {
        errors: body.errors && Object.keys(body.errors).length ? body.errors : null,
        teamName: resp ? resp.team.name : null,
        playerCount: resp ? resp.players.length : 0,
        attackersAndMids: resp ? resp.players.filter(p => p.position === 'Attacker' || p.position === 'Midfielder').map(p => p.name + ' [' + p.position + ']') : []
      };
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err), partial: out });
  }
}
