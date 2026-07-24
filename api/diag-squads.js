// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
// Prueba si el endpoint de nóminas (squads) de API-Football funciona con el
// plan gratis (el bloqueo anterior era por temporada, y aplicaba a
// fixtures/partidos — squads podría no depender de temporada).
//
// Nunca devuelve la API key, solo las respuestas crudas de API-Football.
// Uso: GET /api/diag-squads

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta API_FOOTBALL_KEY en Vercel.' });
    return;
  }
  const HOST = 'https://v3.football.api-sports.io';
  const headers = { 'x-apisports-key': apiKey };
  const out = { teamsBySeasonTried: {}, santaFeTeamId: null, squadsRaw: null, allTeams2024: null };

  async function getJson(url) {
    const r = await fetch(url, { headers });
    return { httpStatus: r.status, body: await r.json() };
  }

  try {
    // 1) Buscar el ID de Independiente Santa Fe probando varias temporadas
    //    (por si el endpoint de teams también está bloqueado por temporada
    //    en el plan gratis).
    let santaFeId = null;
    for (const season of [2026, 2025, 2024, 2023]) {
      const { httpStatus, body } = await getJson(`${HOST}/teams?league=239&season=${season}`);
      const errors = body.errors && Object.keys(body.errors).length ? body.errors : null;
      const resultsCount = typeof body.results === 'number' ? body.results : (body.response ? body.response.length : 0);
      out.teamsBySeasonTried[season] = { httpStatus, errors, resultsCount };
      if (!santaFeId && body.response && body.response.length) {
        const match = body.response.find(t => t.team && /santa\s*fe/i.test(t.team.name || ''));
        if (match) santaFeId = match.team.id;
      }
      if (season === 2024 && body.response) {
        out.allTeams2024 = body.response.map(t => ({ id: t.team.id, name: t.team.name }));
      }
    }
    out.santaFeTeamId = santaFeId;

    // 2) Si se encontró el ID, pedir la nómina cruda.
    if (santaFeId) {
      const { httpStatus, body } = await getJson(`${HOST}/players/squads?team=${santaFeId}`);
      out.squadsRaw = { httpStatus, body };
    } else {
      out.squadsNote = 'No se pudo obtener el ID de Santa Fe desde /teams en ninguna temporada probada — mira teamsBySeasonTried para ver el error exacto.';
    }

    // 3) ¿Funciona /teams?search= en el plan gratis? (para equipos ascendidos
    //    que no están en la temporada 2024, como Llaneros o Cúcuta).
    out.searchTests = {};
    for (const term of ['llaneros', 'cucuta']) {
      const { httpStatus, body } = await getJson(`${HOST}/teams?search=${term}`);
      out.searchTests[term] = {
        httpStatus,
        errors: body.errors && Object.keys(body.errors).length ? body.errors : null,
        results: (body.response || []).map(t => ({ id: t.team.id, name: t.team.name, country: t.team.country }))
      };
    }

    // 4) Verificar las 3 nóminas dudosas antes de hardcodear sus IDs.
    out.verifySquads = {};
    for (const id of [1141, 1464, 1470]) {
      const { httpStatus, body } = await getJson(`${HOST}/players/squads?team=${id}`);
      const resp = body.response && body.response[0];
      out.verifySquads[id] = {
        httpStatus,
        teamName: resp ? resp.team.name : null,
        playerCount: resp ? resp.players.length : 0,
        sample: resp ? resp.players.slice(0, 6).map(p => p.name + ' [' + p.position + ']') : []
      };
    }

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: 'Error en el diagnóstico', details: String(err), partial: out });
  }
}
