// ENDPOINT TEMPORAL DE DIAGNÓSTICO — se borra apenas termine la prueba.
// Verifica qué da BSD para la Primera A (liga 80): próximos partidos, el
// formato de las incidencias (goles con autor) de un partido terminado, y la
// tabla de posiciones. Nunca devuelve la API key.

export default async function handler(req, res) {
  const key = process.env.BSD_API_KEY;
  if (!key) { res.status(500).json({ error: 'Falta BSD_API_KEY.' }); return; }
  const headers = { 'Authorization': 'Token ' + key };
  const out = {};

  async function getJson(url) {
    const r = await fetch(url, { headers });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
  }

  try {
    // 1) Próximos partidos de la liga 80 (los de mañana deberían salir aquí)
    const up = await getJson('https://sports.bzzoiro.com/api/matches/?league=80&status=notstarted&page_size=12');
    out.upcoming = {
      status: up.status,
      count: up.body.count,
      sample: (up.body.results || []).slice(0, 12).map(e => ({
        id: e.id, date: e.event_date, status: e.status,
        home: e.home_team, away: e.away_team,
        score: (e.home_score == null ? '-' : e.home_score) + '-' + (e.away_score == null ? '-' : e.away_score)
      }))
    };

    // 2) Un partido TERMINADO con incidencias (goles con autor) — full=true
    const fin = await getJson('https://sports.bzzoiro.com/api/matches/?league=80&status=finished&full=true&page_size=8');
    const withGoals = (fin.body.results || []).find(e => (e.home_score || 0) + (e.away_score || 0) > 0 && Array.isArray(e.incidents) && e.incidents.length);
    out.finishedSample = withGoals ? {
      id: withGoals.id, date: withGoals.event_date,
      home: withGoals.home_team, away: withGoals.away_team,
      score: withGoals.home_score + '-' + withGoals.away_score,
      incidents: withGoals.incidents
    } : {
      note: 'no encontré un terminado con incidencias en la muestra',
      firstResultKeys: (fin.body.results || [])[0] ? Object.keys((fin.body.results || [])[0]) : null,
      firstIncidents: (fin.body.results || [])[0] ? (fin.body.results || [])[0].incidents : null
    };

    // 3) Tabla de posiciones de la liga 80
    const st = await getJson('https://sports.bzzoiro.com/api/leagues/80/standings/');
    out.standings = {
      status: st.status,
      // devolver crudo recortado para ver la forma exacta
      shape: Array.isArray(st.body) ? 'array' : typeof st.body,
      sample: JSON.stringify(st.body).slice(0, 1200)
    };

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: String(err), partial: out });
  }
}
