// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
// Verifica el formato real de la nómina de Santa Fe (team 797) en BSD, con
// la key ya configurada en Vercel. Nunca devuelve la API key.

export default async function handler(req, res) {
  const key = process.env.BSD_API_KEY;
  if (!key) { res.status(500).json({ error: 'Falta BSD_API_KEY en Vercel.' }); return; }
  const headers = { 'Authorization': 'Token ' + key };
  const out = {};

  async function tryGet(label, url) {
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch (e) { body = { _raw: text.slice(0, 300) }; }
      out[label] = { httpStatus: r.status, count: body.count, hasNext: !!body.next, resultsLength: Array.isArray(body.results) ? body.results.length : null, sample: Array.isArray(body.results) ? body.results.slice(0, 6) : body };
    } catch (e) {
      out[label] = { error: String(e) };
    }
  }

  // Santa Fe = team 797 en BSD. Probamos v1 y v2, con page_size grande.
  await tryGet('v1_players_team797', 'https://sports.bzzoiro.com/api/players/?team=797&page_size=100');
  await tryGet('v1_players_team797_posF', 'https://sports.bzzoiro.com/api/players/?team=797&position=F&page_size=100');

  res.status(200).json(out);
}
