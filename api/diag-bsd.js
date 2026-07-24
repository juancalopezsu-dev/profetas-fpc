// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
export default async function handler(req, res) {
  const key = process.env.BSD_API_KEY;
  if (!key) { res.status(500).json({ error: 'Falta BSD_API_KEY.' }); return; }
  const headers = { 'Authorization': 'Token ' + key };
  const out = {};
  async function getJson(url) {
    const r = await fetch(url, { headers });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: { _raw: t.slice(0, 200) } }; }
  }
  try {
    // Traer una página de partidos de la liga 80 y ver los status reales
    const all = await getJson('https://sports.bzzoiro.com/api/matches/?league=80&page_size=60&tz=America/Bogota');
    const results = all.body.results || [];
    const statuses = {};
    results.forEach(e => { statuses[e.status] = (statuses[e.status] || 0) + 1; });
    out.statusCounts = statuses;
    out.totalCount = all.body.count;

    // Encontrar un partido con marcador > 0 (ya jugado) y pedir su detalle full
    const played = results.filter(e => (e.home_score || 0) + (e.away_score || 0) > 0);
    out.playedFound = played.length;
    if (played.length) {
      const e0 = played[0];
      out.pickedMatch = { id: e0.id, date: e0.event_date, status: e0.status, home: e0.home_team, away: e0.away_team, score: e0.home_score + '-' + e0.away_score };
      const det = await getJson('https://sports.bzzoiro.com/api/matches/' + e0.id + '/?full=true&tz=America/Bogota');
      const b = det.body || {};
      out.detailKeys = Object.keys(b);
      out.incidents = b.incidents || null;
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err), partial: out });
  }
}
