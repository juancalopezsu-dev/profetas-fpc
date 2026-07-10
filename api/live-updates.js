// Función serverless (Vercel Cron, idealmente cada 5 minutos) que mantiene
// el marcador EN VIVO de los partidos actualizado solo, sin que nadie
// necesite tener la app abierta.
//
// En cada ejecución:
//   1. Pasa a 'live' (por tiempo, sin gastar cuota de API-Football) cualquier
//      partido 'scheduled' cuyo kickoff ya pasó.
//   2. Le pone 'visible: true' a las predicciones de cualquier partido que ya
//      no esté 'scheduled' — es el campo que firestore.rules exige para
//      dejarle ver a alguien la predicción de otra persona (ver
//      revealPredictions() más abajo y los comentarios en firestore.rules).
//      Tampoco gasta cuota de API-Football, son puras lecturas/escrituras de
//      Firestore.
//   3. Si después de eso no queda ningún partido 'live', termina ahí — cero
//      llamadas a API-Football (para no gastar cuota en días sin partidos).
//   4. Si hay partidos 'live', primero consulta /status (no gasta cuota) para
//      ver cuántas peticiones quedan hoy. Si quedan menos de MIN_REMAINING,
//      se salta esta ejecución — la siguiente ventana de 5 minutos lo reintenta.
//   5. Si hay cuota, consulta /fixtures por fecha para esos partidos y
//      actualiza marcador y status ('live' -> 'finished' cuando la API
//      reporta el partido terminado: FT, AET o PEN). Cada partido usa la
//      liga de API-Football que le corresponde según su campo 'competition'
//      ('fpc' = liga 239, temporada según el año de la fecha; 'mundial' =
//      liga 1, siempre temporada 2026) — ver leagueParamsFor() más abajo.
//      Las dos competencias comparten el mismo control de cuota del paso 4,
//      así que no hay un límite aparte por competencia.
//   6. Para cada partido que sigue en vivo, intenta además /fixtures/events
//      para sacar la lista de goles (equipo + minuto). Es un intento aparte
//      y nunca bloquea el marcador: si el plan de API-Football contratado no
//      da acceso a ese endpoint (o falla puntualmente), sencillamente no se
//      actualiza la lista de goles y el marcador total sigue funcionando igual.
//
// Respaldo manual: en Gestionar, cualquier partido 'live' se puede editar a
// mano (marcador directo o gol por gol) — no depende de que este cron ande a
// tiempo ni de que API-Football responda (ver comentarios en app.js).
//
// Nota sobre el plan de Vercel: los Cron Jobs de Vercel en el plan Hobby
// (gratis) solo se disparan una vez al día por más fina que sea la
// expresión cron — no sirven para "cada 5 minutos". Por eso este endpoint
// también se puede disparar desde afuera (ver .github/workflows/live-updates.yml,
// que sí llama cada 5 minutos usando GitHub Actions, gratis). El endpoint es
// idempotente y seguro de llamar así de seguido, o incluso a mano.
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - API_FOOTBALL_KEY: API key de API-Football
//   - CRON_SECRET (opcional pero recomendado): igual que en actualizar-resultados.js
//     — hay que llamar este endpoint con "Authorization: Bearer <CRON_SECRET>"

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const MIN_REMAINING_REQUESTS = 15;
const FINISHED_CODES = ['FT', 'AET', 'PEN'];

// Cada competencia le corresponde una liga distinta en API-Football. La FPC
// (Colombia Primera A) usa la temporada del año de la fecha del partido,
// igual que antes; el Mundial 2026 siempre es la misma temporada fija.
function leagueParamsFor(competition, date) {
  if (competition === 'mundial') return { id: 1, season: 2026 };
  return { id: 239, season: new Date(date).getFullYear() };
}
function matchCompetition(m) {
  return m.competition === 'mundial' ? 'mundial' : 'fpc';
}

// Colombia (Bogotá) no tiene horario de verano, siempre es UTC-5.
function bogotaDateStr(kickoff) {
  const epochMs = typeof kickoff === 'number' ? kickoff : new Date(kickoff).getTime();
  return new Date(epochMs - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

async function apiFootball(path, apiKey) {
  const apiRes = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': apiKey }
  });
  return apiRes.json();
}

function matchStatus(m) {
  if (m.status === 'live' || m.status === 'finished' || m.status === 'scheduled') return m.status;
  return m.homeScore != null ? 'finished' : 'scheduled';
}

// Le pone 'visible: true' a las predicciones de un partido que ya no está
// 'scheduled'. Es lo único que le permite a firestore.rules mostrarle a
// alguien la predicción de otra persona (ver comentarios ahí) — nunca lo
// hace el navegador porque nadie puede editar la predicción ajena. Se salta
// las que ya estaban en true para no gastar escrituras de más.
async function revealPredictions(matchDoc) {
  const predsSnap = await matchDoc.ref.collection('predictions').get();
  let revealed = 0;
  for (const predDoc of predsSnap.docs) {
    if (predDoc.data().visible !== true) {
      await predDoc.ref.update({ visible: true });
      revealed++;
    }
  }
  return revealed;
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
  if (!apiKey) { res.status(500).json({ error: 'Falta configurar API_FOOTBALL_KEY en Vercel.' }); return; }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' }); return; }

  try {
    const db = getDb();
    const now = Date.now();

    // Paso 1: pasar a 'live' por tiempo, sin gastar cuota de API-Football.
    const matchesSnap = await db.collection('profetas').doc('matches').collection('matches').get();
    let flippedToLive = 0;
    for (const matchDoc of matchesSnap.docs) {
      const m = matchDoc.data();
      if (matchStatus(m) === 'scheduled' && m.kickoff && m.kickoff <= now) {
        const updates = { status: 'live' };
        if (m.homeScore == null) updates.homeScore = 0;
        if (m.awayScore == null) updates.awayScore = 0;
        await matchDoc.ref.update(updates);
        flippedToLive++;
      }
    }

    // Paso 2: revelar predicciones ajenas de cualquier partido que ya no
    // esté 'scheduled' (ver revealPredictions arriba). No gasta cuota de
    // API-Football — son puras lecturas/escrituras de Firestore.
    const freshSnap = flippedToLive
      ? await db.collection('profetas').doc('matches').collection('matches').get()
      : matchesSnap;
    let predictionsRevealed = 0;
    for (const matchDoc of freshSnap.docs) {
      if (matchStatus(matchDoc.data()) !== 'scheduled') {
        predictionsRevealed += await revealPredictions(matchDoc);
      }
    }

    // Paso 3: solo seguimos si de verdad hay algo en vivo que consultar en
    // API-Football (el marcador y los goles).
    const liveDocs = freshSnap.docs.filter(d => matchStatus(d.data()) === 'live');

    if (!liveDocs.length) {
      res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, liveChecked: 0, message: 'No hay partidos en vivo por consultar en API-Football.' });
      return;
    }

    // Paso 4: revisar cuánta cuota queda antes de gastarla. Si falla la
    // consulta misma, nos vamos a lo seguro y nos saltamos esta ejecución.
    let remaining = null;
    try {
      const statusData = await apiFootball('/status', apiKey);
      const requests = statusData && statusData.response && statusData.response.requests;
      if (requests) remaining = requests.limit_day - requests.current;
    } catch (e) { /* remaining se queda en null */ }

    if (remaining === null) {
      res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, liveChecked: liveDocs.length, skipped: true, reason: 'No se pudo verificar la cuota de API-Football, se salta esta ejecución por seguridad.' });
      return;
    }
    if (remaining < MIN_REMAINING_REQUESTS) {
      res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, liveChecked: liveDocs.length, skipped: true, reason: `Solo quedan ${remaining} peticiones de API-Football hoy, se salta esta ejecución.` });
      return;
    }

    // Paso 5: consultar /fixtures por fecha y actualizar marcador/status.
    const teamsSnap = await db.collection('profetas').doc('teams').collection('teams').get();
    const teams = teamsSnap.docs.map(d => d.data());
    const teamById = id => teams.find(t => t.id === id);

    // Se agrupa por competencia + fecha (no solo fecha) porque un mismo día
    // puede tener partidos de la FPC y del Mundial a la vez, y cada uno
    // necesita su propia consulta de /fixtures con su propia liga.
    const groups = {};
    for (const d of liveDocs) {
      const competition = matchCompetition(d.data());
      const date = bogotaDateStr(d.data().kickoff);
      const key = competition + '|' + date;
      if (!groups[key]) groups[key] = { competition, date, docs: [] };
      groups[key].docs.push(d);
    }
    let updatedCount = 0, finishedCount = 0, goalsUpdated = 0;

    for (const key of Object.keys(groups)) {
      const { competition, date, docs: dayDocs } = groups[key];
      const league = leagueParamsFor(competition, date);
      const data = await apiFootball(`/fixtures?league=${league.id}&season=${league.season}&date=${date}`, apiKey);
      const fixtures = data.response || [];

      for (const matchDoc of dayDocs) {
        const m = matchDoc.data();
        const home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        if (!home || !away) continue;

        const fx = fixtures.find(f => {
          const homeMatches = f.teams.home.name.toLowerCase().indexOf(home.name.toLowerCase().split(' ')[0]) >= 0;
          const awayMatches = f.teams.away.name.toLowerCase().indexOf(away.name.toLowerCase().split(' ')[0]) >= 0;
          return homeMatches && awayMatches;
        });
        if (!fx) continue;

        const short = fx.fixture.status.short;
        const updates = {};
        if (fx.goals.home !== null && fx.goals.home !== undefined) updates.homeScore = fx.goals.home;
        if (fx.goals.away !== null && fx.goals.away !== undefined) updates.awayScore = fx.goals.away;
        if (FINISHED_CODES.includes(short)) { updates.status = 'finished'; finishedCount++; }
        if (Object.keys(updates).length) { await matchDoc.ref.update(updates); updatedCount++; }

        // Goles minuto a minuto: mejor esfuerzo, nunca bloquea el marcador
        // total de arriba si el plan contratado no da acceso a este endpoint.
        try {
          const eventsData = await apiFootball(`/fixtures/events?fixture=${fx.fixture.id}`, apiKey);
          const events = eventsData.response || [];
          const goals = events
            .filter(e => e.type === 'Goal')
            .map(e => ({
              team: e.team && e.team.id === fx.teams.home.id ? 'home' : 'away',
              minute: e.time ? e.time.elapsed : null
            }));
          if (goals.length) { await matchDoc.ref.update({ goals }); goalsUpdated++; }
        } catch (e) { /* sin acceso al endpoint de eventos en este plan, o falla puntual: seguimos solo con el marcador total */ }
      }
    }

    res.status(200).json({ ok: true, flippedToLive, predictionsRevealed, liveChecked: liveDocs.length, updated: updatedCount, finished: finishedCount, goalsUpdated });
  } catch (err) {
    res.status(500).json({ error: 'Error actualizando marcador en vivo', details: String(err) });
  }
}
