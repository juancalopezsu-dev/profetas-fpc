import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, collectionGroup, deleteDoc, writeBatch, onSnapshot,
  query, where, or
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

// Todo el mundo (incluso antes de elegir perfil) necesita estar autenticado
// para poder leer o escribir en Firestore — las reglas exigen request.auth
// != null. Si ya había una sesión guardada (perfil o admin, vía custom
// token), Firebase la restaura sola; si no hay ninguna, entramos anónimo.
function ensureAuth(){
  return new Promise(function(resolve, reject){
    var unsub = onAuthStateChanged(auth, function(user){
      if(user){
        unsub();
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    }, reject);
  });
}

(function(){
  var DEFAULT_TEAMS = [
    ["América de Cali","AME","#8B1E2E"],
    ["Atlético Bucaramanga","BUC","#4C7A2B"],
    ["Atlético Nacional","NAL","#2E7D45"],
    ["Boyacá Chicó","CHI","#8B1E2E"],
    ["Deportivo Cali","CAL","#1B5E3E"],
    ["Deportivo Pasto","PAS","#8B1E2E"],
    ["Deportivo Pereira","PER","#4A4A4A"],
    ["Deportes Tolima","TOL","#B8933A"],
    ["Fortaleza CEIF","FOR","#2B4A8B"],
    ["Independiente Medellín","MED","#B8202E"],
    ["Independiente Santa Fe","SFE","#B8202E"],
    ["Internacional de Bogotá","INT","#3A6B8B"],
    ["Jaguares de Córdoba","JAG","#B8933A"],
    ["Junior","JUN","#D62828"],
    ["Llaneros","LLA","#3A6B8B"],
    ["Millonarios","MIL","#1B4B8B"],
    ["Once Caldas","ONC","#5B2A86"],
    ["Águilas Doradas","AGU","#B8933A"],
    ["Alianza FC","ALI","#B8202E"],
    ["Cúcuta Deportivo","CUC","#2B4A8B"]
  ];

  var state = {
    profiles: [],
    teams: [],
    matches: [],
    predictions: {},
    preseason: { picks:{}, result:null },
    realStandings: {},
    adminUnlocked: false,
    myId: null,
    tab: 'predicciones',
    tablaSub: 'apuesta',
    finalizadosVisibleCount: 10
  };

  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

  // Todo el HTML de esta app se arma pegando texto (no hay un framework con
  // auto-escape) — así que cualquier texto que alguien más controla (su
  // nombre de perfil, el goleador que escribió, el color/código de un
  // equipo, etc.) tiene que pasar por aquí antes de meterse en un innerHTML.
  // Si no, alguien podría poner como "nombre" algo como
  // '<img src=x onerror="...">' y ese código se ejecutaría en el navegador
  // de cualquiera que vea ese nombre — incluido un admin, lo que le daría
  // control de su sesión. Las reglas de Firestore no protegen contra esto:
  // permiten guardar cualquier texto en un campo que sea tuyo, es la propia
  // interfaz la que tiene que tratarlo como texto y no como HTML.
  function escapeHtml(s){
    if(s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function randomPin(){ return String(Math.floor(1000 + Math.random()*9000)); }

  // Colombia (Bogotá) no tiene horario de verano, siempre es UTC-5. Esta
  // función devuelve la fecha "de Colombia" (YYYY-MM-DD) de un instante en
  // milisegundos, sin depender de la zona horaria de quien la ejecute —
  // importante para no pedirle a API-Football la fecha equivocada en
  // partidos nocturnos (ej. 8pm Colombia ya es el día siguiente en UTC).
  function bogotaDateStr(kickoff){
    var epochMs = typeof kickoff === 'number' ? kickoff : new Date(kickoff).getTime();
    return new Date(epochMs - 5*3600*1000).toISOString().slice(0,10);
  }

  /* ---------- MANEJO DE ERRORES ---------- */
  // Muestra el error en pantalla en vez de dejar la app en blanco/verde en silencio.
  // Así se puede ver en el celular mismo qué está fallando, sin necesidad de conectar
  // un depurador remoto.
  function showFatalError(err){
    console.error('Error fatal:', err);
    var loadingEl = document.getElementById('boot-loading');
    if(loadingEl) loadingEl.remove();
    var detail = (err && err.stack) ? err.stack : (err && err.message) ? err.message : String(err);
    var box = document.getElementById('fatal-error-box');
    if(!box){
      box = document.createElement('div');
      box.id = 'fatal-error-box';
      box.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#1a0000;color:#ffb4b4;padding:18px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;overflow:auto;z-index:99999;';
      document.body.appendChild(box);
    }
    box.textContent = 'La app no pudo cargar por este error:\n\n' + detail;
  }
  window.addEventListener('error', function(event){
    showFatalError(event.error || event.message);
  });
  window.addEventListener('unhandledrejection', function(event){
    showFatalError(event.reason);
  });

  function hideBootLoading(){
    var el = document.getElementById('boot-loading');
    if(el) el.remove();
  }

  // Redimensiona una imagen a un máximo de maxSize x maxSize (manteniendo proporción)
  // y la devuelve como data URL en JPEG antes de guardarla en Firestore. Esto evita
  // que fotos de perfil y escudos pesen varios MB en base64 y hagan lenta la carga inicial.
  function resizeImageToDataUrl(file, maxSize){
    maxSize = maxSize || 150;
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(ev){
        var img = new Image();
        img.onload = function(){
          var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          var outW = Math.max(1, Math.round(img.width * scale));
          var outH = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          var ctx = canvas.getContext('2d');
          // Relleno de fondo porque JPEG no soporta transparencia (ej. escudos en PNG).
          ctx.fillStyle = '#F5F1E6';
          ctx.fillRect(0, 0, outW, outH);
          ctx.drawImage(img, 0, 0, outW, outH);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = function(){ reject(new Error('No se pudo leer la imagen')); };
        img.src = ev.target.result;
      };
      reader.onerror = function(){ reject(new Error('No se pudo leer el archivo')); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- FIRESTORE HELPERS ---------- */
  async function loadDoc(name, fallback){
    try{
      var snap = await getDoc(doc(db, 'profetas', name));
      if(snap.exists()) return snap.data();
      return fallback;
    }catch(e){ console.error('load error', name, e); return fallback; }
  }
  async function saveDoc(name, data){
    try{ await setDoc(doc(db, 'profetas', name), data); }
    catch(e){ console.error('save error', name, e); alert('No se pudo guardar. Revisa tu conexión.'); }
  }

  // Los equipos viven en la subcolección 'profetas/teams/teams/{teamId}' —
  // un documento por equipo, en vez de un array dentro de un único documento,
  // para no toparnos con el límite de 1MB por documento cuando hay escudos en base64.
  function teamsCol(){ return collection(db, 'profetas', 'teams', 'teams'); }

  async function saveTeam(team){
    try{ await setDoc(doc(db, 'profetas', 'teams', 'teams', team.id), team); }
    catch(e){ console.error('save team error', team.id, e); alert('No se pudo guardar el equipo. Revisa tu conexión.'); }
  }
  async function deleteTeamDoc(teamId){
    try{ await deleteDoc(doc(db, 'profetas', 'teams', 'teams', teamId)); }
    catch(e){ console.error('delete team error', teamId, e); alert('No se pudo eliminar el equipo. Revisa tu conexión.'); }
  }
  async function migrateTeamsToSubcollection(teams){
    try{
      var batch = writeBatch(db);
      teams.forEach(function(t){ batch.set(doc(db, 'profetas', 'teams', 'teams', t.id), t); });
      await batch.commit();
      // El documento viejo (array único) ya no se usa; lo borramos para liberar el espacio que ocupaba.
      await deleteDoc(doc(db, 'profetas', 'teams'));
    }catch(e){ console.error('migrate teams error', e); }
  }

  // Mismo patrón para los perfiles: 'profetas/profiles/profiles/{profileId}',
  // un documento por persona en vez de un array compartido, para que varias
  // fotos de perfil en base64 no topen el límite de 1MB de un solo documento.
  function profilesCol(){ return collection(db, 'profetas', 'profiles', 'profiles'); }

  async function saveProfile(profile){
    try{ await setDoc(doc(db, 'profetas', 'profiles', 'profiles', profile.id), profile); }
    catch(e){ console.error('save profile error', profile.id, e); alert('No se pudo guardar el perfil. Revisa tu conexión.'); }
  }
  async function deleteProfileDoc(profileId){
    try{ await deleteDoc(doc(db, 'profetas', 'profiles', 'profiles', profileId)); }
    catch(e){ console.error('delete profile error', profileId, e); alert('No se pudo eliminar el perfil. Revisa tu conexión.'); }
  }
  async function migrateProfilesToSubcollection(profiles){
    try{
      var batch = writeBatch(db);
      // Importante: se conserva el mismo p.id de cada perfil (no se generan IDs
      // nuevos), porque las predicciones en 'matches' están ligadas a esos IDs.
      profiles.forEach(function(p){ batch.set(doc(db, 'profetas', 'profiles', 'profiles', p.id), p); });
      await batch.commit();
      await deleteDoc(doc(db, 'profetas', 'profiles'));
    }catch(e){ console.error('migrate profiles error', e); }
  }

  // Partidos y predicciones: 'profetas/matches/matches/{matchId}' y, dentro de
  // cada partido, 'predictions/{profileId}'. Cada predicción es su propio
  // documento con su propio ownerUid, para que las reglas de Firestore puedan
  // verificar por documento quién puede crearla o editarla (algo imposible si
  // todas las predicciones vivieran mezcladas en un array o mapa gigante).
  function matchesCol(){ return collection(db, 'profetas', 'matches', 'matches'); }

  async function saveMatch(match){
    try{ await setDoc(doc(db, 'profetas', 'matches', 'matches', match.id), match); }
    catch(e){ console.error('save match error', match.id, e); alert('No se pudo guardar el partido. Revisa tu conexión.'); }
  }
  async function deleteMatchDoc(matchId){
    try{
      var preds = state.predictions[matchId] || {};
      var batch = writeBatch(db);
      Object.keys(preds).forEach(function(pid){
        batch.delete(doc(db, 'profetas', 'matches', 'matches', matchId, 'predictions', pid));
      });
      batch.delete(doc(db, 'profetas', 'matches', 'matches', matchId));
      await batch.commit();
    }catch(e){ console.error('delete match error', matchId, e); alert('No se pudo eliminar el partido. Revisa tu conexión.'); }
  }
  async function savePrediction(matchId, profileId, pred){
    try{
      // merge:true a propósito: nunca debe borrar el campo 'visible' que
      // api/live-updates.js (o api/actualizar-resultados.js) le haya puesto
      // aparte — ese campo es lo único que permite que Firestore le muestre
      // esta predicción a los demás una vez pasó el kickoff (ver firestore.rules).
      var path = 'profetas/matches/matches/'+matchId+'/predictions/'+profileId;
      console.log('[DEBUG savePrediction] guardando en:', path, { home: pred.home, away: pred.away, ownerUid: profileId });
      await setDoc(doc(db, 'profetas', 'matches', 'matches', matchId, 'predictions', profileId), {
        home: pred.home, away: pred.away, ownerUid: profileId
      }, { merge: true });
      console.log('[DEBUG savePrediction] guardado OK en:', path);
    }catch(e){ console.error('save prediction error', matchId, profileId, e); alert('No se pudo guardar tu predicción. Revisa tu conexión.'); }
  }
  async function deletePrediction(matchId, profileId){
    try{ await deleteDoc(doc(db, 'profetas', 'matches', 'matches', matchId, 'predictions', profileId)); }
    catch(e){ console.error('delete prediction error', matchId, profileId, e); }
  }

  /* ---------- TIEMPO REAL ---------- */
  // En vez de leer una sola vez con getDoc/getDocs, nos suscribimos con
  // onSnapshot: la primera vez que llega el dato resuelve la promesa (así
  // loadAll() sigue esperando la carga inicial como antes), y cada cambio
  // posterior en Firestore (otra persona prediciendo, el admin cargando un
  // resultado, etc.) actualiza el estado y refresca la pantalla sola, sin
  // que nadie tenga que recargar la página.
  var unsubscribers = [];

  function watchDoc(name, applyFn, onUpdate){
    return new Promise(function(resolve){
      var first = true;
      var unsub = onSnapshot(doc(db, 'profetas', name), function(snap){
        applyFn(snap.exists() ? snap.data() : null);
        if(first){ first = false; resolve(); }
        else if(onUpdate){ onUpdate(); }
      }, function(err){
        console.error('watchDoc error', name, err);
        if(first){ first = false; resolve(); }
      });
      unsubscribers.push(unsub);
    });
  }

  function watchCollection(colRef, applyFn, onUpdate){
    return new Promise(function(resolve){
      var first = true;
      var unsub = onSnapshot(colRef, function(snap){
        var list = [];
        snap.forEach(function(docSnap){ list.push(docSnap.data()); });
        applyFn(list);
        if(first){ first = false; resolve(); }
        else if(onUpdate){ onUpdate(); }
      }, function(err){
        console.error('watchCollection error', err);
        if(first){ first = false; resolve(); }
      });
      unsubscribers.push(unsub);
    });
  }

  // Igual que watchCollection, pero para una collectionGroup (todas las
  // subcolecciones 'predictions' de todos los partidos a la vez). Agrupa los
  // documentos por matchId (el padre de 'predictions' es el propio partido).
  function watchCollectionGroup(colGroupRef, applyFn, onUpdate){
    return new Promise(function(resolve){
      var first = true;
      var unsub = onSnapshot(colGroupRef, function(snap){
        var map = {};
        snap.forEach(function(docSnap){
          var matchId = docSnap.ref.parent.parent.id;
          if(!map[matchId]) map[matchId] = {};
          map[matchId][docSnap.id] = docSnap.data();
        });
        applyFn(map);
        if(first){ first = false; resolve(); }
        else if(onUpdate){ onUpdate(); }
      }, function(err){
        console.error('[DEBUG watchCollectionGroup] la consulta falló — por eso "state.predictions" se queda vacío/desactualizado sin ningún aviso visible en la interfaz:', err);
        if(first){ first = false; resolve(); }
      });
      unsubscribers.push(unsub);
    });
  }

  // Vuelve a pintar la pantalla actual (login o la pestaña activa) con el
  // estado ya actualizado. Si la persona está escribiendo algo en ese
  // momento (un input/select dentro de la vista visible), no interrumpe —
  // el próximo render (al terminar de escribir, cambiar de pestaña, guardar,
  // etc.) ya va a usar el estado más reciente igual.
  function refreshCurrentView(){
    var mainShell = document.getElementById('main-shell');
    var loginView = document.getElementById('login-view');
    var active = document.activeElement;
    var isFormField = active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA' || active.tagName==='SELECT');
    if(mainShell && !mainShell.classList.contains('hidden')){
      var viewEl = document.getElementById('view');
      if(isFormField && viewEl && viewEl.contains(active)) return;
      renderShell();
      renderView();
    } else if(loginView && !loginView.classList.contains('hidden')){
      if(isFormField && loginView.contains(active)) return;
      renderLogin();
    }
  }

  async function loadAll(){
    unsubscribers.forEach(function(fn){ try{ fn(); }catch(e){} });
    unsubscribers = [];

    var profilesPromise = watchCollection(profilesCol(), function(list){
      list.sort(function(a,b){ return a.name.localeCompare(b.name); });
      state.profiles = list;
    }, refreshCurrentView);

    var teamsPromise = watchCollection(teamsCol(), function(list){
      list.sort(function(a,b){ return a.name.localeCompare(b.name); });
      state.teams = list;
    }, refreshCurrentView);

    var matchesPromise = watchCollection(matchesCol(), function(list){
      state.matches = list;
    }, refreshCurrentView);

    // Firestore rechaza la consulta ENTERA si, sin filtro, pudiera devolver
    // algún documento que la regla no deja leer (no filtra resultado por
    // resultado como uno esperaría). Por eso nunca se pide "todas las
    // predicciones" a secas: se piden solo las que ya son visibles para
    // todos (visible==true, lo pone api/live-updates.js al pasar el
    // kickoff) o las propias (ownerUid==mi uid) — ambos filtros calzan
    // exactamente con las condiciones de 'allow read' en firestore.rules,
    // que es lo que le permite a Firestore comprobar que la consulta es
    // segura sin tener que mirar cada documento uno por uno.
    var myUid = auth.currentUser ? auth.currentUser.uid : '__none__';
    console.log('[DEBUG loadAll] consultando collectionGroup(db,"predictions") con myUid =', myUid);
    var predictionsQuery = query(collectionGroup(db, 'predictions'),
      or(where('visible', '==', true), where('ownerUid', '==', myUid)));
    var predictionsPromise = watchCollectionGroup(predictionsQuery, function(map){
      console.log('[DEBUG loadAll] predictions recibidas — matchIds:', Object.keys(map), 'detalle:', map);
      state.predictions = map;
    }, refreshCurrentView);

    var preseasonPromise = watchDoc('preseason', function(data){
      state.preseason = data || { picks:{}, result:null };
    }, refreshCurrentView);

    var realStandingsPromise = watchDoc('realStandings', function(data){
      state.realStandings = (data && data.data) || {};
    }, refreshCurrentView);

    await Promise.all([profilesPromise, teamsPromise, matchesPromise, predictionsPromise, preseasonPromise, realStandingsPromise]);

    if(!state.profiles.length){
      var legacyProfilesDoc = await loadDoc('profiles', null);
      if(legacyProfilesDoc && legacyProfilesDoc.list && legacyProfilesDoc.list.length){
        // Se conservan los IDs originales: las predicciones en 'matches' están ligadas a ellos.
        state.profiles = legacyProfilesDoc.list;
        await migrateProfilesToSubcollection(state.profiles);
      }
    }

    if(!state.teams.length){
      var legacyTeamsDoc = await loadDoc('teams', null);
      if(legacyTeamsDoc && legacyTeamsDoc.list && legacyTeamsDoc.list.length){
        state.teams = legacyTeamsDoc.list;
      } else {
        state.teams = DEFAULT_TEAMS.map(function(t){ return {id:uid(), name:t[0], code:t[1], color:t[2]}; });
      }
      await migrateTeamsToSubcollection(state.teams);
    }
  }
  async function savePreseason(){ await saveDoc('preseason', state.preseason); }
  async function saveRealStandings(){ await saveDoc('realStandings', { data: state.realStandings }); }

  function teamById(id){ return state.teams.find(function(t){return t.id===id;}); }
  function profileById(id){ return state.profiles.find(function(p){return p.id===id;}); }

  /* ---------- PERFIL BOT (predicción automática de respaldo) ---------- */
  var BOT_NAME = 'Carlos Antonio Vélez';
  function getBotProfile(){ return state.profiles.find(function(p){ return p.isBot; }); }
  function getBotProfileId(){ var b = getBotProfile(); return b ? b.id : null; }

  // Solo se puede llamar desde una sesión de administrador: crear el perfil
  // del bot es una escritura de perfil cuyo 'ownerUid' nunca va a coincidir
  // con el auth.uid de quien la haga (el bot no inicia sesión con PIN), así
  // que las reglas de Firestore solo la permiten si isAdmin() es cierto.
  async function ensureBotProfile(){
    var bot = getBotProfile();
    if(bot) return bot;
    var id = uid();
    bot = { id: id, name: BOT_NAME, photo: null, isBot: true, ownerUid: id };
    state.profiles.push(bot);
    await saveProfile(bot);
    return bot;
  }

  // Marcadores bajos y comunes (~80% de las veces) vs. resultados más
  // goleadores y menos comunes (~20%, hasta un máximo razonable de 5 goles
  // por equipo, evitando repetir uno de los marcadores comunes de la lista).
  var BOT_COMMON_SCORES = [[0,0],[1,0],[0,1],[1,1],[2,0],[0,2],[2,1],[1,2],[2,2]];
  function randomBotScore(){
    if(Math.random() < 0.8){
      var pick = BOT_COMMON_SCORES[Math.floor(Math.random()*BOT_COMMON_SCORES.length)];
      return { home: pick[0], away: pick[1] };
    }
    var home, away, tries = 0;
    do{
      home = Math.floor(Math.random()*6);
      away = Math.floor(Math.random()*6);
      tries++;
    } while(BOT_COMMON_SCORES.some(function(s){ return s[0]===home && s[1]===away; }) && tries < 20);
    return { home: home, away: away };
  }

  // Rellena con un marcador aleatorio la predicción del bot en cualquier
  // partido que ya exista pero que se haya quedado sin ella (ej. partidos
  // creados antes de que existiera el bot). Solo admin puede escribir
  // predicciones del bot (su ownerUid nunca coincide con un auth.uid real),
  // así que esto se llama solo desde dentro de Gestionar.
  async function fillMissingBotPredictions(){
    var botId = getBotProfileId();
    if(!botId) return 0;
    var filled = 0;
    var writes = [];
    state.matches.forEach(function(m){
      if(!state.predictions[m.id]) state.predictions[m.id] = {};
      if(!state.predictions[m.id][botId]){
        var score = randomBotScore();
        var pred = { home: String(score.home), away: String(score.away), ownerUid: botId };
        state.predictions[m.id][botId] = pred;
        writes.push(savePrediction(m.id, botId, pred));
        filled++;
      }
    });
    if(writes.length){ await Promise.all(writes); }
    return filled;
  }

  function shieldHtml(team, size){
    size = size || 44;
    if(!team) return '<div class="shield" style="background:#444;width:'+size+'px;height:'+size+'px;">?</div>';
    if(team.logoUrl){
      return '<img class="shield" src="'+escapeHtml(team.logoUrl)+'" alt="'+escapeHtml(team.name)+'" style="width:'+size+'px;height:'+size+'px;">';
    }
    return '<div class="shield" style="background:'+escapeHtml(team.color)+';width:'+size+'px;height:'+size+'px;font-size:'+(size*0.32)+'px;">'+escapeHtml(team.code)+'</div>';
  }

  function avatarHtml(profile, size){
    size = size || 34;
    if(profile && profile.photo){
      return '<img class="avatar" src="'+escapeHtml(profile.photo)+'" style="width:'+size+'px;height:'+size+'px;">';
    }
    var initials = profile ? escapeHtml(profile.name.slice(0,2).toUpperCase()) : '?';
    return '<div class="avatar-fallback" style="width:'+size+'px;height:'+size+'px;">'+initials+'</div>';
  }

  function isLocked(match){
    if(!match.kickoff) return false;
    return new Date(match.kickoff).getTime() <= Date.now();
  }

  // 'status' es el campo fuente de verdad para saber si un partido va en
  // vivo o ya terminó. Los partidos guardados antes de que existiera este
  // campo no lo tienen, así que si falta se infiere del marcador (como se
  // hacía antes): con marcador ya es 'finished', sin marcador es 'scheduled'.
  function matchStatus(m){
    if(m.status==='live' || m.status==='finished' || m.status==='scheduled') return m.status;
    if(!(m.homeScore===null || m.homeScore===undefined)) return 'finished';
    return 'scheduled';
  }
  function hasLiveMatches(){
    return state.matches.some(function(m){ return matchStatus(m)==='live'; });
  }

  // Competencia de un equipo/partido: 'fpc' (Liga BetPlay, la real) o
  // 'mundial' (Copa Mundial 2026, datos de prueba para probar que el
  // rastreo automático también funciona con otra liga de API-Football).
  // Los equipos/partidos guardados antes de que existiera este campo no lo
  // tienen — se tratan como 'fpc', que es lo que ya eran.
  function teamCompetition(t){ return t.competition==='mundial' ? 'mundial' : 'fpc'; }
  function matchCompetition(m){ return m.competition==='mundial' ? 'mundial' : 'fpc'; }

  // Datos por fase: etiqueta, clase CSS del badge y puntos por acertar
  // resultado/marcador exacto. Único lugar donde viven estos números.
  function phaseInfo(phase){
    if(phase==='final') return { label:'Final', cssClass:'phase-final', exactPts:8, resultPts:4 };
    if(phase==='cuadrangulares') return { label:'Cuadrangulares', cssClass:'phase-cuadrangulares', exactPts:5, resultPts:2 };
    return { label:'Regular', cssClass:'phase-regular', exactPts:3, resultPts:1 };
  }

  function pointsForPrediction(match, pred){
    if(!pred || pred.home===''||pred.home===undefined||pred.away===''||pred.away===undefined) return 0;
    var ph = parseInt(pred.home), pa = parseInt(pred.away);
    var rh = match.homeScore, ra = match.awayScore;
    if(isNaN(ph)||isNaN(pa)) return 0;
    var info = phaseInfo(match.phase);
    if(ph===rh && pa===ra) return info.exactPts;
    var predOutcome = ph>pa?'H':(ph<pa?'A':'D');
    var realOutcome = rh>ra?'H':(rh<ra?'A':'D');
    if(predOutcome===realOutcome) return info.resultPts;
    return 0;
  }

  // Predicción "efectiva" de una persona para un partido: la suya si la puso,
  // o si el partido ya cerró (llegó la hora de kickoff) y no predijo, la del
  // perfil bot "Carlos Antonio Vélez" copiada automáticamente. No se escribe
  // en Firestore — se calcula al vuelo para que siempre refleje el estado
  // real de los partidos sin depender de un disparador exacto a la hora de cierre.
  function effectivePrediction(match, profileId){
    var direct = (state.predictions[match.id] || {})[profileId];
    if(direct) return { pred: direct, auto: false };
    var botId = getBotProfileId();
    if(!botId || profileId === botId) return null;
    if(!isLocked(match)) return null;
    var botPred = (state.predictions[match.id] || {})[botId];
    if(!botPred) return null;
    return { pred: botPred, auto: true };
  }

  function computeStandings(){
    var totals = {};
    state.profiles.forEach(function(p){ totals[p.id] = 0; });
    state.matches.forEach(function(m){
      // TEMPORAL (2026-07-18): se comentó el filtro de competencia para
      // poder probar la tabla y los puntos en vivo con el partido de
      // prueba del Mundial (Francia vs Inglaterra, 4pm). Antes de este
      // cambio la tabla daba 0 puntos con toda razón — no había ningún bug,
      // simplemente no había partidos FPC jugados todavía y este filtro
      // los aislaba correctamente. HAY QUE DESCOMENTAR la línea de abajo
      // después de la prueba de hoy: si se deja así, cualquier partido real
      // de Mundial futuro también sumaría para siempre a la tabla del FPC.
      // if(matchCompetition(m)!=='fpc') return;
      if(m.homeScore===null||m.homeScore===undefined) return;
      state.profiles.forEach(function(p){
        var eff = effectivePrediction(m, p.id);
        if(!eff) return;
        if(!(p.id in totals)) totals[p.id]=0;
        totals[p.id] += pointsForPrediction(m, eff.pred);
      });
    });
    if(state.preseason.result){
      var res = state.preseason.result;
      var scorerCorrectIds = res.scorerCorrectIds || [];
      Object.keys(state.preseason.picks).forEach(function(pid){
        var pick = state.preseason.picks[pid];
        if(!(pid in totals)) totals[pid]=0;
        if(res.championTeamId && pick.championTeamId===res.championTeamId) totals[pid]+=12;
        if(scorerCorrectIds.indexOf(pid)>=0) totals[pid]+=12;
      });
    }
    var rows = state.profiles.map(function(p){ return {profile:p, points: totals[p.id]||0}; });
    rows.sort(function(a,b){ return b.points-a.points; });
    return rows;
  }

  /* ---------- LOGIN ---------- */
  function renderLogin(){
    var el = document.getElementById('login-view');
    var html = '<div class="brand-mark" style="width:56px;height:56px;font-size:20px;margin:0 auto 16px;">FPC</div>';
    html += '<div class="login-title display">Los Profetas del FPC</div>';
    html += '<div class="login-sub">Elige tu perfil o crea uno nuevo para empezar a jugar</div>';
    var humanProfiles = state.profiles.filter(function(p){ return !p.isBot; });
    if(humanProfiles.length){
      html += '<div class="profile-grid">';
      humanProfiles.forEach(function(p){
        html += '<div class="profile-tile" data-select-profile="'+p.id+'">'+avatarHtml(p,56)+'<div class="profile-tile-name">'+escapeHtml(p.name)+'</div></div>';
      });
      html += '</div>';
    }
    html += '<div class="new-profile-form">';
    html += '<label class="photo-input-label" id="photo-picker"><span id="photo-placeholder">Foto</span><input type="file" accept="image/*" id="photo-file" style="display:none;"></label>';
    html += '<input type="text" id="new-name" placeholder="Tu nombre">';
    html += '<input type="text" id="new-pin" class="pin-input" placeholder="Crea un PIN de 4 dígitos" maxlength="4" inputmode="numeric">';
    html += '<button class="btn btn-gold" id="create-profile-btn">Crear perfil y entrar</button>';
    html += '</div>';
    el.innerHTML = html;
    el.classList.remove('hidden');

    el.querySelectorAll('[data-select-profile]').forEach(function(node){
      node.addEventListener('click', async function(){
        var pid = node.getAttribute('data-select-profile');
        var profile = profileById(pid);
        var pin = prompt('Ingresa tu PIN de 4 dígitos para entrar como '+profile.name+':');
        if(pin === null) return;
        if(!/^\d{4}$/.test(pin)){ alert('El PIN debe ser de 4 dígitos'); return; }
        try{
          var resp = await fetch('/api/profile-login', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ mode:'login', profileId:pid, pin:pin })
          });
          var data = await resp.json();
          if(!resp.ok){ alert(data.error || 'PIN incorrecto.'); return; }
          await signInWithCustomToken(auth, data.token);
          // Vuelve a suscribir las predicciones con el uid nuevo — la
          // consulta de "mis predicciones" quedó armada con el uid anónimo
          // de antes de iniciar sesión (ver comentario en loadAll()).
          await loadAll();
          state.myId = pid;
          showMain();
        }catch(e){
          alert('No se pudo iniciar sesión. Revisa tu conexión.');
        }
      });
    });

    var pendingPhoto = null;
    document.getElementById('photo-picker').addEventListener('click', function(){
      document.getElementById('photo-file').click();
    });
    document.getElementById('photo-file').addEventListener('change', function(e){
      var f = e.target.files[0];
      if(!f) return;
      var placeholder = document.getElementById('photo-placeholder');
      if(placeholder) placeholder.textContent = 'Procesando...';
      resizeImageToDataUrl(f, 150).then(function(dataUrl){
        pendingPhoto = dataUrl;
        document.getElementById('photo-picker').innerHTML = '<img src="'+pendingPhoto+'">';
      }).catch(function(){
        alert('No se pudo procesar la imagen.');
        if(placeholder) placeholder.textContent = 'Foto';
      });
    });
    document.getElementById('create-profile-btn').addEventListener('click', async function(){
      var btn = this;
      var name = document.getElementById('new-name').value.trim();
      var pin = document.getElementById('new-pin').value.trim();
      if(!name){ alert('Escribe tu nombre'); return; }
      if(!/^\d{4}$/.test(pin)){ alert('El PIN debe ser de 4 dígitos'); return; }
      btn.disabled = true;
      btn.textContent = 'Creando...';
      try{
        var resp = await fetch('/api/profile-login', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ mode:'create', name:name, pin:pin })
        });
        var data = await resp.json();
        if(!resp.ok){
          alert(data.error || 'No se pudo crear el perfil.');
          btn.disabled = false; btn.textContent = 'Crear perfil y entrar';
          return;
        }
        await signInWithCustomToken(auth, data.token);
        await loadAll();
        var newP = { id: data.profileId, name: name, photo: pendingPhoto, ownerUid: data.profileId };
        await saveProfile(newP);
        state.myId = newP.id;
        showMain();
      }catch(e){
        alert('No se pudo crear el perfil. Revisa tu conexión.');
        btn.disabled = false; btn.textContent = 'Crear perfil y entrar';
      }
    });
  }

  /* ---------- SHELL ---------- */
  var TABS = [
    {id:'predicciones', label:'Predicciones'},
    {id:'finalizados', label:'Finalizados'},
    {id:'tabla', label:'Tabla'},
    {id:'pretemporada', label:'Pre-temporada'},
    {id:'reglas', label:'Reglas'},
    {id:'perfil', label:'Mi perfil'},
    {id:'gestionar', label:'Gestionar'}
  ];

  function renderShell(){
    var me = profileById(state.myId);
    document.getElementById('me-box').innerHTML = avatarHtml(me,34) + '<span class="me-name">'+escapeHtml(me?me.name:'')+'</span>';
    var tabsEl = document.getElementById('tabs');
    tabsEl.innerHTML = TABS.map(function(t){
      return '<button class="tab'+(state.tab===t.id?' active':'')+'" data-tab="'+t.id+'">'+t.label+'</button>';
    }).join('');
    tabsEl.querySelectorAll('[data-tab]').forEach(function(btn){
      btn.addEventListener('click', function(){
        state.tab = btn.getAttribute('data-tab');
        renderShell();
        renderView();
      });
    });
  }

  function renderView(){
    var el = document.getElementById('view');
    if(state.tab==='predicciones') return renderPredicciones(el);
    if(state.tab==='finalizados') return renderFinalizados(el);
    if(state.tab==='tabla') return renderTabla(el);
    if(state.tab==='pretemporada') return renderPretemporada(el);
    if(state.tab==='reglas') return renderReglas(el);
    if(state.tab==='perfil') return renderPerfil(el);
    if(state.tab==='gestionar'){
      if(!state.adminUnlocked) return renderGestionarGate(el);
      return renderGestionar(el);
    }
  }

  /* ---------- PREDICCIONES ---------- */
  function renderPredicciones(el){
    var upcoming = state.matches.filter(function(m){ return matchStatus(m)==='scheduled' && !isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    var lockedNoResult = state.matches.filter(function(m){ return matchStatus(m)==='scheduled' && isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    var live = state.matches.filter(function(m){ return matchStatus(m)==='live'; })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });

    var html = '';
    if(live.length){
      html += '<div class="section-title">🔴 En vivo</div>';
      live.forEach(function(m){ html += matchCardHtml(m, false, 'live'); });
    }
    html += '<div class="section-title"'+(live.length?' style="margin-top:22px;"':'')+'>Por jugar</div>';
    if(!upcoming.length){
      html += '<div class="empty">No hay partidos abiertos para predecir.</div>';
    } else {
      upcoming.forEach(function(m){ html += matchCardHtml(m, true); });
    }
    if(lockedNoResult.length){
      html += '<div class="section-title" style="margin-top:22px;">Cerrados, esperando resultado</div>';
      lockedNoResult.forEach(function(m){ html += matchCardHtml(m, false, true); });
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-save-pred]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-save-pred');
        var homeInput = el.querySelector('[data-pred-home="'+mid+'"]');
        var awayInput = el.querySelector('[data-pred-away="'+mid+'"]');
        var h = homeInput.value, a = awayInput.value;
        if(h===''||a===''){ alert('Completa ambos marcadores'); return; }
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        if(!state.predictions[mid]) state.predictions[mid] = {};
        var pred = { home:h, away:a, ownerUid: state.myId };
        state.predictions[mid][state.myId] = pred;
        await savePrediction(mid, state.myId, pred);
        renderPredicciones(el);
      });
    });

    el.querySelectorAll('[data-show-match-preds]').forEach(function(btn){
      btn.addEventListener('click', function(){
        showMatchPredictionsModal(btn.getAttribute('data-show-match-preds'));
      });
    });
  }

  /* ---------- FINALIZADOS ---------- */
  // Aparte de "Predicciones" para que esa pestaña cargue liviana — una
  // temporada completa del FPC puede acumular muchísimos partidos jugados,
  // así que aquí se pintan de a poco (state.finalizadosVisibleCount, que
  // vive en el state global y no se resetea solo con re-renders normales
  // por Firestore, solo crece con "Cargar más").
  function renderFinalizados(el){
    var finished = state.matches.filter(function(m){ return matchStatus(m)==='finished'; })
      .sort(function(a,b){ return new Date(b.kickoff||0)-new Date(a.kickoff||0); });

    var html = '<div class="section-title">Finalizados</div>';
    if(!finished.length){
      html += '<div class="empty">Todavía no hay resultados cargados.</div>';
    } else {
      var visibleCount = Math.min(state.finalizadosVisibleCount, finished.length);
      finished.slice(0, visibleCount).forEach(function(m){ html += matchCardHtml(m, false); });
      if(visibleCount < finished.length){
        html += '<button class="btn" id="finalizados-load-more" style="width:100%;margin-top:10px;">Cargar más ('+(finished.length-visibleCount)+' restantes)</button>';
      }
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-show-match-preds]').forEach(function(btn){
      btn.addEventListener('click', function(){
        showMatchPredictionsModal(btn.getAttribute('data-show-match-preds'));
      });
    });

    var loadMoreBtn = document.getElementById('finalizados-load-more');
    if(loadMoreBtn){
      loadMoreBtn.addEventListener('click', function(){
        state.finalizadosVisibleCount += 10;
        renderFinalizados(el);
      });
    }
  }

  // Lista de goles (equipo + minuto) ordenada, usada tanto en la tarjeta de
  // un partido en vivo/finalizado como en el modal de predicciones. Los
  // goles pueden venir de API-Football (live-updates) o cargados a mano en
  // Gestionar — para efectos de mostrarlos da igual el origen.
  function goalsListHtml(m, home, away){
    if(!m.goals || !m.goals.length) return '';
    var sorted = m.goals.slice().sort(function(a,b){ return (a.minute||0)-(b.minute||0); });
    var items = sorted.map(function(g){
      var t = g.team==='home' ? home : away;
      return '<div class="goal-row">⚽ <b>'+(g.minute!=null?g.minute+'\'':'')+'</b> '+escapeHtml(t?t.name:'?')+'</div>';
    }).join('');
    return '<div class="goals-list">'+items+'</div>';
  }

  function matchCardHtml(m, editable, waitingResult){
    var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
    var phaseClass = phaseInfo(m.phase).cssClass;
    var phaseLabel = phaseInfo(m.phase).label;
    var isLive = waitingResult === 'live';
    var myPred = (state.predictions[m.id]||{})[state.myId] || {home:'',away:''};
    var kickoffLabel = m.kickoff ? new Date(m.kickoff).toLocaleString('es-CO', {weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}) : ('Fecha '+(m.matchday||'-'));

    var html = '<div class="card match-card">';
    html += '<div class="match-top"><span class="phase-badge '+phaseClass+'">'+phaseLabel+'</span>'+(matchCompetition(m)==='mundial'?'<span class="phase-badge" style="background:rgba(58,107,139,0.25);color:#7fb3d5;">🌎 Mundial</span>':'')+(isLive?'<span class="live-badge"><span class="live-dot"></span>EN VIVO</span>':'')+'<span class="match-meta">'+kickoffLabel+'</span></div>';
    html += '<div class="match-teams">';
    html += '<div class="team">'+shieldHtml(home)+'<span class="team-name">'+escapeHtml(home?home.name:'?')+'</span></div>';

    if(editable){
      html += '<div class="score-inputs">';
      html += '<input type="number" min="0" data-pred-home="'+m.id+'" value="'+escapeHtml(myPred.home)+'">';
      html += '<span class="vs-label">–</span>';
      html += '<input type="number" min="0" data-pred-away="'+m.id+'" value="'+escapeHtml(myPred.away)+'">';
      html += '</div>';
    } else if(waitingResult === true){
      html += '<div class="score-inputs"><span class="vs-label">vs</span></div>';
    } else {
      html += '<div class="score-inputs"><span class="result-final">'+m.homeScore+'</span><span class="vs-label">–</span><span class="result-final">'+m.awayScore+'</span></div>';
    }

    html += '<div class="team">'+shieldHtml(away)+'<span class="team-name">'+escapeHtml(away?away.name:'?')+'</span></div>';
    html += '</div>';
    if(isLive){ html += goalsListHtml(m, home, away); }

    if(editable){
      html += '<div class="match-actions"><button class="btn btn-gold" data-save-pred="'+m.id+'">Guardar predicción</button></div>';
    } else if(waitingResult === true){
      var effW = effectivePrediction(m, state.myId);
      html += '<div class="match-actions"><span class="locked-tag">Predicción cerrada</span>';
      if(effW){
        var labelW = effW.auto ? ('🤖 Predicción automática (Carlos Antonio Vélez): '+escapeHtml(effW.pred.home)+'-'+escapeHtml(effW.pred.away)) : ('Tu predicción: '+escapeHtml(effW.pred.home)+'-'+escapeHtml(effW.pred.away));
        html += '<span class="points-pill">'+labelW+'</span>';
      }
      html += '<button class="btn" data-show-match-preds="'+m.id+'">Ver predicciones</button>';
      html += '</div>';
    } else {
      var eff = effectivePrediction(m, state.myId);
      var pts = eff ? pointsForPrediction(m, eff.pred) : null;
      html += '<div class="match-actions">';
      if(eff){
        var label = eff.auto ? ('🤖 Predicción automática (Carlos Antonio Vélez): '+escapeHtml(eff.pred.home)+'-'+escapeHtml(eff.pred.away)) : ('Tu predicción '+escapeHtml(eff.pred.home)+'-'+escapeHtml(eff.pred.away));
        html += '<span class="points-pill'+(pts===0?' zero':'')+'">'+label+' · '+pts+(isLive?' pts (provisional)':' pts')+'</span>';
      } else {
        html += '<span class="points-pill zero">No predijiste este partido</span>';
      }
      html += '<button class="btn" data-show-match-preds="'+m.id+'">Ver predicciones</button>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  /* ---------- TABLA ---------- */
  function renderTabla(el){
    var html = '<div class="tabs" style="position:static; padding:0 0 10px; margin-bottom:6px;">';
    html += '<button class="tab'+(state.tablaSub==='apuesta'?' active':'')+'" data-sub="apuesta">Nuestra apuesta</button>';
    html += '<button class="tab'+(state.tablaSub==='real'?' active':'')+'" data-sub="real">Liga real</button>';
    html += '</div>';

    if(state.tablaSub==='apuesta'){
      if(hasLiveMatches()){
        html += '<div class="live-banner"><span class="live-badge"><span class="live-dot"></span>EN VIVO</span> Hay partidos en curso — estos puntos son provisionales y pueden cambiar.</div>';
      }
      // Si hay más de un partido en vivo a la vez (puede pasar en la última
      // fecha del FPC), se destaca el que arrancó primero — es una decisión
      // arbitraria pero razonable para un caso que hoy no se da (solo hay
      // un partido de prueba en vivo).
      var liveMatchesForTabla = state.matches.filter(function(m){ return matchStatus(m)==='live'; })
        .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
      var featuredLive = liveMatchesForTabla[0] || null;
      var featuredHome = featuredLive ? teamById(featuredLive.homeTeamId) : null;
      var featuredAway = featuredLive ? teamById(featuredLive.awayTeamId) : null;

      var rows = computeStandings();
      if(!rows.length){
        html += '<div class="empty">Todavía no hay jugadores.</div>';
      } else {
        html += '<div style="font-size:9px; color:var(--muted); display:flex; align-items:center; padding:0 14px; margin-bottom:4px; gap:12px;">';
        html += '<span style="width:28px;"></span><span style="width:38px;"></span><span style="flex:1;"></span>';
        if(featuredLive){
          html += '<span style="width:100px;text-align:center;" title="Predicción en vivo: '+escapeHtml(featuredHome?featuredHome.name:'?')+' vs '+escapeHtml(featuredAway?featuredAway.name:'?')+'">🔴 '+escapeHtml(featuredHome?featuredHome.code:'?')+'-'+escapeHtml(featuredAway?featuredAway.code:'?')+'</span>';
        } else {
          html += '<span style="width:52px;text-align:center;">Goleador</span><span style="width:42px;text-align:center;">Campeón</span>';
        }
        html += '<span style="width:60px;"></span>';
        html += '</div>';
        rows.forEach(function(r, i){
          var rankClass = i===0?'r1':(i===1?'r2':(i===2?'r3':''));
          html += '<div class="board-row'+(i===0?' top1':'')+'" data-profile-detail="'+r.profile.id+'" style="cursor:pointer;">';
          html += '<div class="rank '+rankClass+'">'+(i+1)+'</div>';
          html += avatarHtml(r.profile, 38);
          html += '<div class="board-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">'+escapeHtml(r.profile.name)+'</div>';
          if(featuredLive){
            var effLive = effectivePrediction(featuredLive, r.profile.id);
            html += '<div style="width:100px;text-align:center;">';
            if(effLive){
              var liveCls = predictionPillClass(featuredLive, effLive.pred);
              html += '<span class="mini-pill '+liveCls+'">'+escapeHtml(effLive.pred.home)+'-'+escapeHtml(effLive.pred.away)+'</span>';
            } else {
              html += '<span class="mini-pill pill-neutral">No predijo</span>';
            }
            html += '</div>';
          } else {
            var pick = state.preseason.picks[r.profile.id];
            var champT = pick ? teamById(pick.championTeamId) : null;
            var scorerName = pick && pick.scorerName ? pick.scorerName : '';
            var res = state.preseason.result;
            // Antes de que se cierre y califique la pre-temporada (ver
            // Gestionar), se muestra dorado/neutro (pill-yellow) porque
            // todavía no hay veredicto de acierto o error.
            var scorerCls = 'pill-yellow', champCls = 'pill-yellow';
            if(res){
              scorerCls = (res.scorerCorrectIds||[]).indexOf(r.profile.id)>=0 ? 'pill-green' : 'pill-red';
              champCls = (res.championTeamId && pick && pick.championTeamId===res.championTeamId) ? 'pill-green' : 'pill-red';
            }
            html += '<div style="width:52px;text-align:center;">'+(scorerName ? '<span class="mini-pill '+scorerCls+'" title="'+escapeHtml(scorerName)+'">'+escapeHtml(scorerName)+'</span>' : '<span style="color:var(--muted);font-size:12px;">-</span>')+'</div>';
            html += '<div style="width:42px;text-align:center;">'+(champT ? '<span class="mini-pill '+champCls+'">'+escapeHtml(champT.code)+'</span>' : '<span style="color:var(--muted);font-size:12px;">-</span>')+'</div>';
          }
          html += '<div style="width:60px;"><div class="board-points">'+r.points+'</div><span class="board-points-label">Puntos</span></div>';
          html += '</div>';
        });
      }
    } else {
      var teamRows = state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; }).map(function(t){
        var s = state.realStandings[t.id] || {pj:0,pg:0,pe:0,pp:0,gf:0,gc:0};
        var pts = (s.pg||0)*3 + (s.pe||0);
        var dg = (s.gf||0) - (s.gc||0);
        return {team:t, s:s, pts:pts, dg:dg};
      });
      var anyData = teamRows.some(function(r){ return r.s.pj>0; });
      if(!anyData){
        html += '<div class="empty">Todavía no se ha cargado la tabla real de la liga.<br>Se actualiza desde Gestionar.</div>';
      } else {
        teamRows.sort(function(a,b){ return b.pts-a.pts || b.dg-a.dg; });
        html += '<div style="font-size:10px; color:var(--muted); display:flex; padding:0 14px; margin-bottom:4px;">';
        html += '<span style="width:28px;"></span><span style="flex:1;"></span><span style="width:28px;text-align:center;">PJ</span><span style="width:34px;text-align:center;">DG</span><span style="width:34px;text-align:center;">PTS</span></div>';
        teamRows.forEach(function(r, i){
          var rankClass = i===0?'r1':(i===1?'r2':(i===2?'r3':''));
          html += '<div class="board-row">';
          html += '<div class="rank '+rankClass+'" style="font-size:14px;">'+(i+1)+'</div>';
          html += shieldHtml(r.team, 30);
          html += '<div class="board-name" style="font-size:13px;">'+escapeHtml(r.team.name)+'</div>';
          html += '<span class="tabular" style="width:28px;text-align:center;font-size:13px;">'+(r.s.pj||0)+'</span>';
          html += '<span class="tabular" style="width:34px;text-align:center;font-size:13px;">'+(r.dg>0?'+':'')+r.dg+'</span>';
          html += '<span class="tabular" style="width:34px;text-align:center;font-size:15px;color:var(--gold);">'+r.pts+'</span>';
          html += '</div>';
        });
      }
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-sub]').forEach(function(btn){
      btn.addEventListener('click', function(){
        state.tablaSub = btn.getAttribute('data-sub');
        renderTabla(el);
      });
    });
    el.querySelectorAll('[data-profile-detail]').forEach(function(row){
      row.addEventListener('click', function(){
        showProfileDetailModal(row.getAttribute('data-profile-detail'));
      });
    });
  }

  function closeModal(){
    document.querySelectorAll('.modal-overlay').forEach(function(m){ m.remove(); });
  }

  function showProfileDetailModal(profileId){
    closeModal();
    var profile = profileById(profileId);
    if(!profile) return;

    var predictedMatches = state.matches.filter(function(m){
      return effectivePrediction(m, profileId) !== null;
    }).sort(function(a,b){ return new Date(b.kickoff||0) - new Date(a.kickoff||0); });

    var html = '<div class="modal-overlay" id="profile-detail-modal">';
    html += '<div class="modal-box">';
    html += '<div class="modal-header">'+avatarHtml(profile,40)+'<div class="modal-title">'+escapeHtml(profile.name)+'</div><button class="btn" id="close-profile-detail">Cerrar</button></div>';

    html += '<div class="section-title" style="margin-top:14px;">Predicciones de partidos</div>';
    if(!predictedMatches.length){
      html += '<div class="empty">Todavía no ha predicho ningún partido.</div>';
    } else {
      predictedMatches.forEach(function(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        // Las predicciones ajenas de partidos que todavía no arrancan quedan
        // ocultas para que nadie pueda copiarse antes del pitazo inicial —
        // las propias sí se muestran siempre, ya que uno ya sabe qué predijo.
        var showScore = isLocked(m) || profileId === state.myId;
        html += '<div class="team-list-item" style="flex-wrap:wrap;">';
        html += '<div style="width:100%;font-size:13px;">'+escapeHtml(home?home.name:'?')+' vs '+escapeHtml(away?away.name:'?')+'</div>';
        html += '<div style="width:100%;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);margin-top:4px;">';
        if(!showScore){
          html += '<span>🔒 Oculto hasta que inicie el partido</span>';
        } else {
          var eff = effectivePrediction(m, profileId);
          var pred = eff.pred;
          var hasResult = !(m.homeScore===null || m.homeScore===undefined);
          var pts = hasResult ? pointsForPrediction(m, pred) : null;
          var mIsLive = matchStatus(m)==='live';
          var predLabel = eff.auto ? '🤖 Predicción automática (Carlos Antonio Vélez)' : 'Predijo';
          html += '<span>'+predLabel+': <b style="color:var(--white);">'+escapeHtml(pred.home)+'-'+escapeHtml(pred.away)+'</b></span>';
          if(hasResult){
            html += '<span>'+(mIsLive?'🔴 En vivo':'Real')+': <b style="color:var(--white);">'+m.homeScore+'-'+m.awayScore+'</b></span>';
            html += '<span class="points-pill'+(pts===0?' zero':'')+'">'+pts+(mIsLive?' pts (prov.)':' pts')+'</span>';
          } else {
            html += '<span>Sin resultado todavía</span>';
          }
        }
        html += '</div></div>';
      });
    }

    var pick = state.preseason.picks[profileId];
    if(pick){
      html += '<div class="section-title" style="margin-top:16px;">Pronóstico de pre-temporada</div>';
      var champT = teamById(pick.championTeamId);
      var res = state.preseason.result;
      html += '<div class="card" style="margin-bottom:0;">';
      html += '<div style="font-size:13px;">Campeón: <b>'+escapeHtml(champT?champT.name:'-')+'</b>';
      if(res && res.locked){
        var champOk = res.championTeamId && pick.championTeamId===res.championTeamId;
        html += champOk ? ' <span class="points-pill">✔ +12 pts</span>' : ' <span class="points-pill zero">✘</span>';
      }
      html += '</div>';
      html += '<div style="font-size:13px;margin-top:6px;">Goleador: <b>'+escapeHtml(pick.scorerName||'-')+'</b>';
      if(res && res.locked){
        var scorerOk = (res.scorerCorrectIds||[]).indexOf(profileId)>=0;
        html += scorerOk ? ' <span class="points-pill">✔ +12 pts</span>' : ' <span class="points-pill zero">✘</span>';
      }
      html += '</div>';
      html += '</div>';
    }

    html += '</div></div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstChild);

    document.getElementById('close-profile-detail').addEventListener('click', closeModal);
    document.getElementById('profile-detail-modal').addEventListener('click', function(e){
      if(e.target.id === 'profile-detail-modal') closeModal();
    });
  }

  function predictionPillClass(match, pred){
    var ph = parseInt(pred.home), pa = parseInt(pred.away);
    if(isNaN(ph) || isNaN(pa)) return 'pill-neutral';
    var pts = pointsForPrediction(match, pred);
    var exactPts = phaseInfo(match.phase).exactPts;
    if(pts === exactPts) return 'pill-green';
    if(pts > 0) return 'pill-yellow';
    return 'pill-red';
  }

  function showMatchPredictionsModal(matchId){
    closeModal();
    var match = state.matches.find(function(m){ return m.id === matchId; });
    if(!match) return;
    var home = teamById(match.homeTeamId), away = teamById(match.awayTeamId);
    var hasResult = !(match.homeScore===null || match.homeScore===undefined);
    var isLive = matchStatus(match)==='live';

    var html = '<div class="modal-overlay" id="match-predictions-modal">';
    html += '<div class="modal-box">';
    html += '<div class="modal-header"><div class="modal-title">'+escapeHtml(home?home.name:'?')+' vs '+escapeHtml(away?away.name:'?')+'</div><button class="btn" id="close-match-predictions">Cerrar</button></div>';
    if(isLive){ html += '<div style="text-align:center;margin-top:6px;"><span class="live-badge"><span class="live-dot"></span>EN VIVO</span></div>'; }
    if(hasResult){
      html += '<div style="text-align:center;font-family:\'Oswald\',sans-serif;font-size:24px;font-weight:700;margin:10px 0;color:var(--gold);">'+match.homeScore+' - '+match.awayScore+'</div>';
      if(isLive){ html += '<div style="text-align:center;font-size:11px;color:var(--muted);margin-top:-6px;margin-bottom:10px;">Marcador y puntos provisionales</div>'; }
      html += goalsListHtml(match, home, away);
    } else {
      html += '<div style="text-align:center;font-size:12px;color:var(--muted);margin:10px 0;">Todavía no hay resultado cargado</div>';
    }
    html += '<div class="section-title" style="margin-top:6px;">Predicciones de todos</div>';

    state.profiles.forEach(function(p){
      var eff = effectivePrediction(match, p.id);
      html += '<div class="team-list-item">';
      html += avatarHtml(p, 30);
      html += '<div style="flex:1;font-size:13px;">'+escapeHtml(p.name);
      if(eff && eff.auto){ html += '<div style="font-size:10px;color:var(--muted);">🤖 Predicción automática (Carlos Antonio Vélez)</div>'; }
      html += '</div>';
      if(eff){
        var cls = hasResult ? predictionPillClass(match, eff.pred) : 'pill-neutral';
        html += '<span class="pred-pill '+cls+'">'+escapeHtml(eff.pred.home)+'-'+escapeHtml(eff.pred.away)+'</span>';
      } else {
        html += '<span class="pred-pill pill-neutral">No predijo</span>';
      }
      html += '</div>';
    });

    html += '</div></div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstChild);

    document.getElementById('close-match-predictions').addEventListener('click', closeModal);
    document.getElementById('match-predictions-modal').addEventListener('click', function(e){
      if(e.target.id === 'match-predictions-modal') closeModal();
    });
  }

  /* ---------- PRETEMPORADA ---------- */
  function renderPretemporada(el){
    var locked = !!(state.preseason.picksLocked || (state.preseason.result && state.preseason.result.locked));
    var myPick = state.preseason.picks[state.myId] || {championTeamId:'', scorerName:''};

    var html = '<div class="card">';
    html += '<div class="section-title">Tu pronóstico antes de que arranque la liga</div>';
    html += '<div class="pick-row"><span class="pick-label">Campeón</span>';
    html += '<select id="pick-champion" '+(locked?'disabled':'')+'>';
    html += '<option value="">Selecciona un equipo</option>';
    state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; }).forEach(function(t){
      html += '<option value="'+t.id+'"'+(myPick.championTeamId===t.id?' selected':'')+'>'+escapeHtml(t.name)+'</option>';
    });
    html += '</select></div>';
    html += '<div class="pick-row"><span class="pick-label">Goleador</span>';
    html += '<input type="text" id="pick-scorer" placeholder="Nombre del jugador" value="'+escapeHtml(myPick.scorerName||'')+'" '+(locked?'disabled':'')+'>';
    html += '</div>';
    if(!locked){
      html += '<button class="btn btn-gold" id="save-preseason">Guardar pronóstico (12 pts c/u si aciertas)</button>';
    } else {
      html += '<div class="locked-note">Las predicciones de pre-temporada ya están cerradas.</div>';
    }
    html += '</div>';

    if(state.preseason.result && state.preseason.result.locked){
      var champ = teamById(state.preseason.result.championTeamId);
      html += '<div class="card"><div class="section-title">Resultado real</div>';
      html += '<div style="font-size:14px;">Campeón: <b>'+escapeHtml(champ?champ.name:'-')+'</b></div>';
      html += '<div style="font-size:14px;margin-top:4px;">Goleador: <b>'+escapeHtml(state.preseason.result.scorerName||'-')+'</b></div></div>';
    }

    html += '<div class="section-title" style="margin-top:22px;">Pronósticos de todos</div>';
    var anyPicks = Object.keys(state.preseason.picks).length>0;
    if(!anyPicks){
      html += '<div class="empty">Nadie ha hecho su pronóstico todavía.</div>';
    } else {
      Object.keys(state.preseason.picks).forEach(function(pid){
        var p = profileById(pid); if(!p) return;
        var pick = state.preseason.picks[pid];
        var champT = teamById(pick.championTeamId);
        html += '<div class="board-row">'+avatarHtml(p,34)+'<div class="board-name">'+escapeHtml(p.name)+'<div style="font-size:11px;color:var(--muted);">'+escapeHtml(champT?champT.name:'-')+' · '+escapeHtml(pick.scorerName||'-')+'</div></div></div>';
      });
    }

    el.innerHTML = html;
    if(!locked){
      document.getElementById('save-preseason').addEventListener('click', async function(){
        var btn = this;
        var championTeamId = document.getElementById('pick-champion').value;
        var scorerName = document.getElementById('pick-scorer').value.trim();
        if(!championTeamId || !scorerName){ alert('Completa campeón y goleador'); return; }
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        state.preseason.picks[state.myId] = { championTeamId:championTeamId, scorerName:scorerName };
        await savePreseason();
        renderPretemporada(el);
      });
    }
  }

  /* ---------- REGLAS ---------- */
  function renderReglas(el){
    var html = '<div class="card">';
    html += '<div class="section-title">Cómo se juega Los Profetas del FPC</div>';
    html += '<p style="font-size:13px;line-height:1.5;color:var(--white);margin:0;">Cada partido de la Liga BetPlay lo predices antes de que empiece — puedes cambiar tu predicción las veces que quieras hasta el pitazo inicial, después queda cerrada.</p>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Puntos por fase</div>';
    html += '<div class="rules-phase-row"><span class="phase-badge phase-regular">Regular</span><span class="rules-phase-pts">1 punto por acertar el resultado (quién gana o empate) · 3 puntos por acertar el marcador exacto</span></div>';
    html += '<div class="rules-phase-row"><span class="phase-badge phase-cuadrangulares">Cuadrangulares</span><span class="rules-phase-pts">2 puntos por acertar el resultado · 5 puntos por acertar el marcador exacto</span></div>';
    html += '<div class="rules-phase-row"><span class="phase-badge phase-final">Final</span><span class="rules-phase-pts">4 puntos por acertar el resultado · 8 puntos por acertar el marcador exacto</span></div>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Pre-temporada</div>';
    html += '<p style="font-size:13px;line-height:1.5;color:var(--white);margin:0;">Antes de que arranque la liga, cada quien elige quién cree que será el campeón y quién el goleador de la temporada. Acertar cada uno da <b>12 puntos</b>.</p>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Si se te olvida predecir un partido</div>';
    html += '<p style="font-size:13px;line-height:1.5;color:var(--white);margin:0;">Automáticamente se usa la predicción de <b>Carlos Antonio Vélez</b> (nuestro "profeta" de respaldo) en tu lugar.</p>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Cambios de resultado</div>';
    html += '<p style="font-size:13px;line-height:1.5;color:var(--white);margin:0;">Si la Dimayor corrige oficialmente un resultado, el administrador lo actualiza y los puntos de todos se recalculan automáticamente.</p>';
    html += '</div>';

    el.innerHTML = html;
  }

  /* ---------- MI PERFIL ---------- */
  function renderPerfil(el){
    var me = profileById(state.myId);
    if(!me){ el.innerHTML = '<div class="empty">No se encontró tu perfil.</div>'; return; }

    var pendingPhoto = me.photo || null;

    var html = '<div class="card" style="max-width:360px;margin:0 auto;">';
    html += '<div class="section-title">Mi perfil</div>';
    html += '<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">';
    html += '<div id="perfil-photo-preview"></div>';
    html += '<label class="btn" style="cursor:pointer;"><span id="perfil-photo-btn-label">Cambiar foto</span><input type="file" accept="image/*" id="perfil-photo-file" style="display:none;"></label>';
    html += '</div>';
    html += '<div class="form-row"><label>Nombre</label><input type="text" id="perfil-name" value="'+escapeHtml(me.name)+'"></div>';
    html += '<div class="form-row"><label>PIN actual (para confirmar los cambios)</label><input type="text" id="perfil-current-pin" class="pin-input" maxlength="4" inputmode="numeric" placeholder="PIN actual"></div>';
    html += '<div class="form-row"><label>Nuevo PIN (déjalo vacío si no lo quieres cambiar)</label><input type="text" id="perfil-new-pin" class="pin-input" maxlength="4" inputmode="numeric" placeholder="Nuevo PIN de 4 dígitos"></div>';
    html += '<button class="btn btn-gold" id="save-perfil-btn" style="width:100%;margin-top:8px;">Guardar cambios</button>';
    html += '<div id="perfil-msg" style="font-size:12px;margin-top:8px;"></div>';
    html += '</div>';

    html += '<div class="card" style="max-width:360px;margin:0 auto;">';
    html += '<button class="btn" id="ver-mis-predicciones-btn" style="width:100%;">Ver mis predicciones</button>';
    html += '</div>';

    html += '<div class="card" style="max-width:360px;margin:0 auto;">';
    html += '<button class="btn btn-danger" id="logout-btn" style="width:100%;">Cerrar sesión</button>';
    html += '<div style="font-size:11px;color:var(--muted);margin-top:8px;text-align:center;">Solo cierra tu sesión en este navegador. Tus predicciones y las de todos siguen guardadas.</div>';
    html += '</div>';
    el.innerHTML = html;

    function renderPhotoPreview(){
      var previewEl = document.getElementById('perfil-photo-preview');
      if(pendingPhoto){
        previewEl.innerHTML = '<img class="avatar" src="'+pendingPhoto+'" style="width:64px;height:64px;">';
      } else {
        previewEl.innerHTML = '<div class="avatar-fallback" style="width:64px;height:64px;">'+escapeHtml(me.name.slice(0,2).toUpperCase())+'</div>';
      }
    }
    renderPhotoPreview();

    document.getElementById('perfil-photo-file').addEventListener('change', function(e){
      var f = e.target.files[0];
      if(!f) return;
      var labelSpan = document.getElementById('perfil-photo-btn-label');
      if(labelSpan) labelSpan.textContent = 'Procesando...';
      resizeImageToDataUrl(f, 150).then(function(dataUrl){
        pendingPhoto = dataUrl;
        renderPhotoPreview();
        if(labelSpan) labelSpan.textContent = 'Cambiar foto';
      }).catch(function(){
        alert('No se pudo procesar la imagen.');
        if(labelSpan) labelSpan.textContent = 'Cambiar foto';
      });
    });

    document.getElementById('save-perfil-btn').addEventListener('click', async function(){
      var btn = this;
      var msgEl = document.getElementById('perfil-msg');
      msgEl.textContent = '';
      var name = document.getElementById('perfil-name').value.trim();
      var currentPin = document.getElementById('perfil-current-pin').value.trim();
      var newPin = document.getElementById('perfil-new-pin').value.trim();
      if(!name){ alert('Escribe tu nombre'); return; }
      if(!/^\d{4}$/.test(currentPin)){
        msgEl.style.color = 'var(--danger)';
        msgEl.textContent = 'Ingresa tu PIN actual (4 dígitos) para confirmar.';
        return;
      }
      if(newPin && !/^\d{4}$/.test(newPin)){ alert('El nuevo PIN debe ser de 4 dígitos'); return; }
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      try{
        var idToken = await auth.currentUser.getIdToken();
        var resp = await fetch('/api/profile-login', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
          body: JSON.stringify({ mode:'changePin', profileId: me.id, currentPin: currentPin, newPin: newPin || null })
        });
        var data = await resp.json();
        if(!resp.ok){
          msgEl.style.color = 'var(--danger)';
          msgEl.textContent = data.error || 'El PIN actual no es correcto.';
          btn.disabled = false; btn.textContent = 'Guardar cambios';
          return;
        }
        me.name = name;
        me.photo = pendingPhoto;
        await saveProfile(me);
        renderShell();
        renderPerfil(el);
      }catch(e){
        alert('No se pudo guardar. Revisa tu conexión.');
        btn.disabled = false; btn.textContent = 'Guardar cambios';
      }
    });

    document.getElementById('ver-mis-predicciones-btn').addEventListener('click', function(){
      showProfileDetailModal(state.myId);
    });

    document.getElementById('logout-btn').addEventListener('click', async function(){
      if(!confirm('¿Cerrar sesión? Tendrás que volver a elegir tu perfil y escribir tu PIN para entrar de nuevo.')) return;
      await logout();
    });
  }

  /* ---------- PUERTA DE CONTRASEÑA ---------- */
  // La contraseña de administrador ya no vive en Firestore (donde cualquiera
  // con la app abierta podría leerla y falsificarla) — se verifica en
  // /api/admin-login contra un hash bcrypt guardado como variable de entorno
  // en Vercel. Si es correcta, el servidor entrega un custom token con el
  // claim admin:true, que las reglas de Firestore exigen para cualquier
  // escritura de administrador.
  function renderGestionarGate(el){
    var html = '<div class="card" style="max-width:320px;margin:20px auto;text-align:center;">';
    html += '<div class="section-title">Área de administrador</div>';
    html += '<input type="password" id="gate-pass" placeholder="Contraseña" style="width:100%;margin-bottom:10px;">';
    html += '<button class="btn btn-gold" id="gate-enter-btn" style="width:100%;">Entrar</button>';
    html += '<div id="gate-error" style="color:var(--danger);font-size:12px;margin-top:8px;"></div>';
    html += '</div>';
    el.innerHTML = html;

    var tryEnter = async function(){
      var btn = document.getElementById('gate-enter-btn');
      var errEl = document.getElementById('gate-error');
      var p = document.getElementById('gate-pass').value;
      if(!p) return;
      errEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Entrando...';
      try{
        var resp = await fetch('/api/admin-login', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ password:p, profileId: state.myId })
        });
        var data = await resp.json();
        if(!resp.ok){
          errEl.textContent = data.error || 'Contraseña incorrecta';
          btn.disabled = false; btn.textContent = 'Entrar';
          return;
        }
        await signInWithCustomToken(auth, data.token);
        await loadAll();
        state.adminUnlocked = true;
        renderGestionar(el);
      }catch(e){
        errEl.textContent = 'No se pudo conectar. Revisa tu conexión.';
        btn.disabled = false; btn.textContent = 'Entrar';
      }
    };
    document.getElementById('gate-enter-btn').addEventListener('click', tryEnter);
    document.getElementById('gate-pass').addEventListener('keydown', function(e){ if(e.key==='Enter') tryEnter(); });
  }

  /* ---------- RECORDATORIO WHATSAPP ---------- */
  function buildReminderText(){
    var upcoming = state.matches.filter(function(m){ return (m.homeScore===null||m.homeScore===undefined) && !isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    if(!upcoming.length) return 'No hay partidos abiertos para predecir en este momento.';
    var next = upcoming[0];
    var home = teamById(next.homeTeamId), away = teamById(next.awayTeamId);
    var missing = state.profiles.filter(function(p){
      if(p.isBot) return false;
      var pred = (state.predictions[next.id]||{})[p.id];
      return !pred;
    });
    var kickoffLabel = next.kickoff ? new Date(next.kickoff).toLocaleString('es-CO', {weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit'}) : 'Próximamente';
    var txt = '⚽ Recordatorio Los Profetas del FPC\n';
    txt += escapeHtml(home?home.name:'?') + ' vs ' + escapeHtml(away?away.name:'?') + ' - ' + escapeHtml(kickoffLabel) + '\n\n';
    if(missing.length){
      txt += 'Faltan por predecir:\n';
      missing.forEach(function(p){ txt += '- '+escapeHtml(p.name)+'\n'; });
      txt += '\n¡No se queden sin puntos! 🔮';
    } else {
      txt += '¡Todos ya predijeron este partido! 🎉';
    }
    return txt;
  }

  /* ---------- GESTIONAR ---------- */
  function renderGestionar(el){
    // Solo una sesión de administrador puede crear el perfil del bot o
    // escribir sus predicciones (ver comentarios en ensureBotProfile /
    // fillMissingBotPredictions) — se dispara aquí, no en loadAll(), para
    // que nunca lo intente una sesión anónima o de un perfil normal.
    ensureBotProfile()
      .then(function(){ return fillMissingBotPredictions(); })
      .catch(function(e){ console.error('bot setup error', e); });

    var html = '';

    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;">';
    html += '<button class="btn" id="lock-admin-btn">Salir del modo administrador</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Recordatorio para WhatsApp</div>';
    html += '<div class="reminder-box" id="reminder-text">'+buildReminderText()+'</div>';
    html += '<button class="btn btn-gold" id="copy-reminder-btn">Copiar recordatorio</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Agregar partido</div>';
    html += '<div class="form-grid">';
    html += '<div class="form-row"><label>Competencia</label><select id="m-competition"><option value="fpc">FPC</option><option value="mundial">Mundial</option></select></div>';
    html += '<div class="form-row"><label>Fase</label><select id="m-phase"><option value="regular">Regular</option><option value="cuadrangulares">Cuadrangulares</option><option value="final">Final</option></select></div>';
    html += '<div class="form-row"><label>Local</label><select id="m-home">'+teamOptions('fpc')+'</select></div>';
    html += '<div class="form-row"><label>Visitante</label><select id="m-away">'+teamOptions('fpc')+'</select></div>';
    html += '<div class="form-row"><label>Fecha y hora de inicio</label><input type="datetime-local" id="m-kickoff"></div>';
    html += '</div>';
    html += '<button class="btn btn-gold" id="add-match-btn">Agregar partido</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Cargar resultados</div>';
    html += '<div class="auto-fetch-row">';
    html += '<button class="btn" id="auto-fetch-btn">Buscar resultados automáticos (API)</button>';
    html += '<span id="auto-fetch-status" style="font-size:11px;color:var(--muted);"></span>';
    html += '</div>';
    var pending = state.matches.filter(function(m){ return matchStatus(m)==='scheduled'; });
    if(!pending.length){
      html += '<div class="empty" style="padding:14px 0;">No hay partidos pendientes de resultado.</div>';
    } else {
      pending.forEach(function(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        html += '<div class="team-list-item" style="flex-wrap:wrap;">';
        html += '<div style="flex:1;font-size:13px;">'+(matchCompetition(m)==='mundial'?'🌎 ':'')+escapeHtml(home?home.name:'?')+' vs '+escapeHtml(away?away.name:'?')+'<div style="font-size:11px;color:var(--muted);">'+(m.kickoff ? new Date(m.kickoff).toLocaleString('es-CO') : 'Sin hora')+' · '+phaseInfo(m.phase).label+'</div></div>';
        html += '<input type="number" min="0" style="width:44px;" data-res-home="'+m.id+'">';
        html += '<span class="vs-label">-</span>';
        html += '<input type="number" min="0" style="width:44px;" data-res-away="'+m.id+'">';
        html += '<button class="btn btn-gold" data-save-result="'+m.id+'">Guardar</button>';
        html += '<button class="btn btn-danger" data-del-match="'+m.id+'">Eliminar</button>';
        if(isLocked(m)){
          html += '<div style="width:100%;margin-top:6px;"><button class="btn" data-mark-live="'+m.id+'">🔴 Marcar en vivo ahora</button></div>';
        }
        html += '</div>';
      });
    }
    html += '</div>';

    var liveMatchesGestionar = state.matches.filter(function(m){ return matchStatus(m)==='live'; });
    if(liveMatchesGestionar.length){
      html += '<div class="card">';
      html += '<div class="section-title">🔴 Partidos en vivo</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">El marcador se actualiza solo cada 5 minutos (API-Football). Si la API falla o se retrasa, edítalo aquí a mano — nunca se queda bloqueado esperándola.</div>';
      liveMatchesGestionar.forEach(function(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        html += '<div class="team-list-item" style="flex-wrap:wrap;">';
        html += '<div style="width:100%;font-size:13px;">'+(matchCompetition(m)==='mundial'?'🌎 ':'')+escapeHtml(home?home.name:'?')+' vs '+escapeHtml(away?away.name:'?')+'</div>';
        html += '<input type="number" min="0" style="width:44px;" data-live-home="'+m.id+'" value="'+(m.homeScore==null?0:m.homeScore)+'">';
        html += '<span class="vs-label">-</span>';
        html += '<input type="number" min="0" style="width:44px;" data-live-away="'+m.id+'" value="'+(m.awayScore==null?0:m.awayScore)+'">';
        html += '<button class="btn" data-live-score="'+m.id+'">Actualizar marcador</button>';
        html += '<button class="btn btn-gold" data-finish-match="'+m.id+'">Finalizar partido</button>';
        html += '<button class="btn btn-danger" data-del-match="'+m.id+'">Eliminar</button>';
        html += '<div style="width:100%;margin-top:8px;">';
        (m.goals||[]).forEach(function(g, idx){
          var t = g.team==='home'?home:away;
          html += '<div class="goal-row"><span style="flex:1;">⚽ '+(g.minute!=null?g.minute+'\'':'')+' '+escapeHtml(t?t.name:'?')+'</span><button class="btn btn-danger" style="padding:4px 8px;" data-del-goal="'+m.id+'|'+idx+'">Quitar</button></div>';
        });
        html += '</div>';
        html += '<div style="width:100%;display:flex;gap:6px;align-items:flex-end;margin-top:6px;">';
        html += '<div class="form-row" style="margin-bottom:0;flex:1;"><label>Gol de</label><select data-goal-team="'+m.id+'"><option value="home">'+escapeHtml(home?home.name:'Local')+'</option><option value="away">'+escapeHtml(away?away.name:'Visitante')+'</option></select></div>';
        html += '<div class="form-row" style="margin-bottom:0;width:64px;"><label>Minuto</label><input type="number" min="0" max="130" data-goal-minute="'+m.id+'"></div>';
        html += '<button class="btn" data-add-goal="'+m.id+'">Agregar gol</button>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    var finishedMatches = state.matches.filter(function(m){ return matchStatus(m)==='finished'; });
    if(finishedMatches.length){
      html += '<div class="card">';
      html += '<div class="section-title">Editar resultados ya cargados</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Úsalo si la Dimayor cambia un resultado por reglamento — los puntos de todos se recalculan solos.</div>';
      function finishedRowHtml(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        var row = '<div class="team-list-item">';
        row += '<div style="flex:1;font-size:13px;">'+(matchCompetition(m)==='mundial'?'🌎 ':'')+escapeHtml(home?home.name:'?')+' vs '+escapeHtml(away?away.name:'?')+'</div>';
        row += '<input type="number" min="0" style="width:44px;" data-edit-home="'+m.id+'" value="'+m.homeScore+'">';
        row += '<span class="vs-label">-</span>';
        row += '<input type="number" min="0" style="width:44px;" data-edit-away="'+m.id+'" value="'+m.awayScore+'">';
        row += '<button class="btn" data-edit-result="'+m.id+'">Actualizar</button>';
        row += '<button class="btn btn-danger" data-del-match="'+m.id+'">Eliminar</button>';
        row += '</div>';
        return row;
      }
      // Solo cambia qué se dibuja en pantalla por defecto — no borra ni deja
      // de leer nada de Firestore (state.matches ya trae todo). Los
      // partidos finalizados hace más de 7 días quedan colapsados detrás de
      // un botón para no renderizar decenas de filas de golpe cada vez que
      // se abre Gestionar, que era lo que lo hacía sentir lento.
      var sevenDaysAgoMs = Date.now() - 7*24*3600*1000;
      var recentFinished = finishedMatches.filter(function(m){ return !m.kickoff || m.kickoff >= sevenDaysAgoMs; });
      var olderFinished = finishedMatches.filter(function(m){ return m.kickoff && m.kickoff < sevenDaysAgoMs; });
      recentFinished.forEach(function(m){ html += finishedRowHtml(m); });
      if(olderFinished.length){
        if(state.showOldFinishedMatches){
          html += '<button class="btn" id="toggle-old-finished" style="margin:10px 0;">Ocultar partidos finalizados anteriores ▴</button>';
          olderFinished.forEach(function(m){ html += finishedRowHtml(m); });
        } else {
          html += '<button class="btn" id="toggle-old-finished" style="margin:10px 0;">Ver partidos finalizados anteriores ▾ ('+olderFinished.length+')</button>';
        }
      }
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<div class="section-title">Equipos FPC</div>';
    var fpcTeamsGestionar = state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; });
    if(!fpcTeamsGestionar.length){ html += '<div class="empty" style="padding:10px 0;">Todavía no hay equipos de la FPC.</div>'; }
    fpcTeamsGestionar.forEach(function(t){
      html += '<div class="team-list-item" style="flex-wrap:wrap;">';
      html += '<div style="width:100%;display:flex;align-items:center;gap:8px;">'+shieldHtml(t,32)+'<div style="flex:1;font-size:13px;">'+escapeHtml(t.name)+'</div><button class="btn btn-danger" data-del-team="'+t.id+'">Eliminar</button></div>';
      html += '<div style="width:100%;margin-top:6px;"><label class="btn" style="display:inline-block;cursor:pointer;"><span data-logo-label="'+t.id+'">Subir escudo</span><input type="file" accept="image/*" data-logo-file="'+t.id+'" style="display:none;"></label></div>';
      html += '</div>';
    });
    html += '</div>';

    var mundialTeamsGestionar = state.teams.filter(function(t){ return teamCompetition(t)==='mundial'; });
    if(mundialTeamsGestionar.length){
      html += '<div class="card">';
      html += '<div class="section-title">🌎 Equipos Mundial</div>';
      mundialTeamsGestionar.forEach(function(t){
        html += '<div class="team-list-item" style="flex-wrap:wrap;">';
        html += '<div style="width:100%;display:flex;align-items:center;gap:8px;">'+shieldHtml(t,32)+'<div style="flex:1;font-size:13px;">'+escapeHtml(t.name)+'</div><button class="btn btn-danger" data-del-team="'+t.id+'">Eliminar</button></div>';
        html += '<div style="width:100%;margin-top:6px;"><label class="btn" style="display:inline-block;cursor:pointer;"><span data-logo-label="'+t.id+'">Subir escudo</span><input type="file" accept="image/*" data-logo-file="'+t.id+'" style="display:none;"></label></div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<div class="section-title">Agregar equipo</div>';
    html += '<div class="form-grid">';
    html += '<div class="form-row"><label>Competencia</label><select id="t-competition"><option value="fpc">FPC</option><option value="mundial">Mundial</option></select></div>';
    html += '<div class="form-row"><label>Nombre</label><input type="text" id="t-name" placeholder="Nombre del equipo"></div>';
    html += '<div class="form-row"><label>Código (3-4 letras)</label><input type="text" id="t-code" maxlength="4" placeholder="EQU"></div>';
    html += '<div class="form-row"><label>Color</label><input type="color" id="t-color" value="#E8592B" style="height:36px;padding:2px;"></div>';
    html += '</div>';
    html += '<button class="btn btn-gold" id="add-team-btn">Agregar equipo</button>';
    html += '</div>';

    var mundialMatchesGestionar = state.matches.filter(function(m){ return matchCompetition(m)==='mundial'; });
    if(mundialTeamsGestionar.length || mundialMatchesGestionar.length){
      html += '<div class="card">';
      html += '<div class="section-title">🌎 Zona de pruebas — Mundial</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Borra de una vez '+mundialMatchesGestionar.length+' partido(s) (con sus predicciones) y '+mundialTeamsGestionar.length+' equipo(s) marcados como Mundial — para cuando termines de probar que el rastreo automático funciona con esa competencia.</div>';
      html += '<button class="btn btn-danger" id="del-mundial-test-data-btn">Borrar datos de prueba del Mundial</button>';
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<div class="section-title">Perfiles</div>';
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">El PIN de cada quien se guarda cifrado — ya no se puede ver, pero sí resetear a uno nuevo si alguien lo olvida.</div>';
    var humanProfilesGestionar = state.profiles.filter(function(p){ return !p.isBot; });
    humanProfilesGestionar.forEach(function(p){
      html += '<div class="admin-profile-row">'+avatarHtml(p,32)+'<div style="flex:1;font-size:13px;">'+escapeHtml(p.name)+'</div><button class="btn" data-reset-pin="'+p.id+'">Resetear PIN</button><button class="btn btn-danger" data-del-profile="'+p.id+'">Eliminar</button></div>';
    });
    if(!humanProfilesGestionar.length){ html += '<div class="empty" style="padding:14px 0;">Todavía no hay perfiles creados.</div>'; }
    html += '</div>';

    var bot = getBotProfile();
    if(bot){
      html += '<div class="card">';
      html += '<div class="section-title">Carlos Antonio Vélez (predicción automática)</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Este perfil le genera un marcador aleatorio a cada partido nuevo, y se lo copia automáticamente a quien no haya predicho cuando el partido cierra. Aquí le pones foto y su pronóstico de pre-temporada.</div>';
      html += '<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">';
      html += '<div id="bot-photo-preview">'+avatarHtml(bot,56)+'</div>';
      html += '<label class="btn" style="cursor:pointer;"><span id="bot-photo-btn-label">Subir foto</span><input type="file" accept="image/*" id="bot-photo-file" style="display:none;"></label>';
      html += '</div>';
      html += '<div class="auto-fetch-row">';
      html += '<button class="btn" id="fill-bot-preds-btn">Generar predicciones faltantes de Carlos Antonio Vélez</button>';
      html += '</div>';
      var botPick = state.preseason.picks[bot.id] || {championTeamId:'', scorerName:''};
      html += '<div class="form-row"><label>Campeón (pronóstico del bot)</label><select id="bot-champion">';
      html += '<option value="">Selecciona un equipo</option>';
      state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; }).forEach(function(t){
        html += '<option value="'+t.id+'"'+(botPick.championTeamId===t.id?' selected':'')+'>'+escapeHtml(t.name)+'</option>';
      });
      html += '</select></div>';
      html += '<div class="form-row"><label>Goleador (pronóstico del bot)</label><input type="text" id="bot-scorer" placeholder="Nombre del jugador" value="'+escapeHtml(botPick.scorerName||'')+'"></div>';
      html += '<button class="btn btn-gold" id="save-bot-preseason-btn">Guardar pronóstico del bot</button>';
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<div class="section-title">Tabla real de la liga</div>';
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Actualiza esto manualmente después de cada fecha con los datos oficiales.</div>';
    state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; }).forEach(function(t){
      var s = state.realStandings[t.id] || {pj:0,pg:0,pe:0,pp:0,gf:0,gc:0};
      html += '<div class="team-list-item" style="flex-wrap:wrap;">';
      html += '<div style="width:100%;display:flex;align-items:center;gap:8px;margin-bottom:6px;">'+shieldHtml(t,26)+'<span style="font-size:13px;">'+escapeHtml(t.name)+'</span></div>';
      html += '<div style="display:flex;gap:6px;width:100%;">';
      ['pj','pg','pe','pp','gf','gc'].forEach(function(field){
        var labels = {pj:'PJ',pg:'PG',pe:'PE',pp:'PP',gf:'GF',gc:'GC'};
        html += '<div style="flex:1;"><label style="font-size:9px;color:var(--muted);display:block;text-align:center;">'+labels[field]+'</label><input type="number" min="0" style="width:100%;padding:6px 2px;font-size:12px;" data-real="'+t.id+'" data-field="'+field+'" value="'+(s[field]||0)+'"></div>';
      });
      html += '</div></div>';
    });
    html += '<button class="btn btn-gold" id="save-real-standings" style="margin-top:12px;">Guardar tabla real</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Pre-temporada</div>';
    var picksLocked = !!state.preseason.picksLocked;
    var resultLocked = !!(state.preseason.result && state.preseason.result.locked);
    if(resultLocked){
      html += '<div class="locked-note">Ya se cerró y se calificó la pre-temporada.</div>';
      html += '<button class="btn" id="reopen-preseason" style="margin-top:10px;">Reabrir pronósticos</button>';
    } else if(!picksLocked){
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Bloquea los pronósticos de campeón y goleador de todos para que nadie los siga cambiando. Hazlo cuando la liga esté por arrancar; después podrás calificar con el resultado real.</div>';
      html += '<button class="btn btn-gold" id="lock-picks-btn">Cerrar predicciones de pre-temporada</button>';
    } else {
      html += '<div class="locked-note">Las predicciones ya están bloqueadas. Cuando sepas el resultado real, califica aquí.</div>';
      html += '<div class="form-row" style="margin-top:10px;"><label>Campeón real</label><select id="ps-champion">'+teamOptions('fpc')+'</select></div>';
      html += '<div class="form-row"><label>Goleador real (solo informativo — no califica automático)</label><input type="text" id="ps-scorer" placeholder="Nombre del jugador"></div>';
      html += '<div class="section-title" style="margin-top:14px;">¿Quién acertó el goleador?</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Marca a cada persona cuyo goleador fue el correcto — puede haber más de una si lo escribieron distinto pero es la misma persona.</div>';
      var picksEntries = Object.keys(state.preseason.picks);
      if(!picksEntries.length){
        html += '<div class="empty" style="padding:14px 0;">Nadie hizo su pronóstico de pre-temporada.</div>';
      } else {
        picksEntries.forEach(function(pid){
          var p = profileById(pid); if(!p) return;
          var pick = state.preseason.picks[pid];
          html += '<label class="scorer-check-row">';
          html += '<input type="checkbox" data-scorer-correct="'+pid+'">';
          html += '<span style="flex:1;">'+escapeHtml(p.name)+'</span>';
          html += '<span style="color:var(--muted);">'+escapeHtml(pick.scorerName||'-')+'</span>';
          html += '</label>';
        });
      }
      html += '<button class="btn btn-gold" id="lock-preseason-btn" style="margin-top:12px;">Cerrar y calificar</button>';
    }
    html += '</div>';

    el.innerHTML = html;

    document.getElementById('lock-admin-btn').addEventListener('click', function(){
      state.adminUnlocked = false;
      renderGestionarGate(el);
    });

    var toggleOldFinishedBtn = document.getElementById('toggle-old-finished');
    if(toggleOldFinishedBtn){
      toggleOldFinishedBtn.addEventListener('click', function(){
        state.showOldFinishedMatches = !state.showOldFinishedMatches;
        renderGestionar(el);
      });
    }

    document.getElementById('copy-reminder-btn').addEventListener('click', function(){
      var txt = document.getElementById('reminder-text').textContent;
      navigator.clipboard.writeText(txt).then(function(){
        var btn = document.getElementById('copy-reminder-btn');
        var original = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(function(){ btn.textContent = original; }, 1500);
      }).catch(function(){ alert('No se pudo copiar. Selecciona el texto manualmente.'); });
    });

    // Los equipos de Local/Visitante dependen de qué competencia se elija —
    // un partido del Mundial no puede armarse con equipos de la FPC.
    document.getElementById('m-competition').addEventListener('change', function(){
      var competition = this.value;
      document.getElementById('m-home').innerHTML = teamOptions(competition);
      document.getElementById('m-away').innerHTML = teamOptions(competition);
    });

    document.getElementById('add-match-btn').addEventListener('click', async function(){
      var btn = this;
      var competition = document.getElementById('m-competition').value;
      var home = document.getElementById('m-home').value;
      var away = document.getElementById('m-away').value;
      var kickoff = document.getElementById('m-kickoff').value;
      var phase = document.getElementById('m-phase').value;
      if(!home || !away || home===away){ alert('Elige dos equipos distintos'); return; }
      btn.disabled = true;
      btn.textContent = 'Agregando...';
      // kickoff se guarda como milisegundos (no como texto) para que las
      // reglas de Firestore puedan comparar "¿ya pasó la hora?" al decidir
      // si las predicciones ajenas de este partido ya se pueden leer.
      var kickoffMs = kickoff ? new Date(kickoff).getTime() : null;
      var newMatch = { id:uid(), homeTeamId:home, awayTeamId:away, kickoff: kickoffMs, phase:phase, homeScore:null, awayScore:null, status:'scheduled', goals:[], competition:competition };
      state.matches.push(newMatch);
      await saveMatch(newMatch);
      var botId = getBotProfileId();
      if(botId){
        var botScore = randomBotScore();
        var botPred = { home: String(botScore.home), away: String(botScore.away), ownerUid: botId };
        if(!state.predictions[newMatch.id]) state.predictions[newMatch.id] = {};
        state.predictions[newMatch.id][botId] = botPred;
        await savePrediction(newMatch.id, botId, botPred);
      }
      renderGestionar(el);
    });

    document.getElementById('auto-fetch-btn').addEventListener('click', async function(){
      var statusEl = document.getElementById('auto-fetch-status');
      var pendingMatches = state.matches.filter(function(m){ return matchStatus(m)==='scheduled'; });
      if(!pendingMatches.length){ statusEl.textContent = 'No hay partidos pendientes.'; return; }
      statusEl.innerHTML = '<span class="spinner"></span> Buscando...';
      var dates = Array.from(new Set(pendingMatches.filter(function(m){return m.kickoff;}).map(function(m){ return bogotaDateStr(m.kickoff); })));
      if(!dates.length){ statusEl.textContent = 'Agrega fecha/hora a los partidos para poder buscarlos.'; return; }
      var found = 0;
      for(var i=0;i<dates.length;i++){
        try{
          var resp = await fetch('/api/resultados?date='+dates[i]);
          var data = await resp.json();
          if(data.error){ continue; }
          (data.fixtures||[]).forEach(function(fx){
            if(fx.status!=='FT') return;
            pendingMatches.forEach(function(m){
              var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
              if(!home||!away) return;
              var homeMatches = fx.homeTeam.toLowerCase().indexOf(home.name.toLowerCase().split(' ')[0])>=0;
              var awayMatches = fx.awayTeam.toLowerCase().indexOf(away.name.toLowerCase().split(' ')[0])>=0;
              if(homeMatches && awayMatches){
                var hInput = el.querySelector('[data-res-home="'+m.id+'"]');
                var aInput = el.querySelector('[data-res-away="'+m.id+'"]');
                if(hInput && !hInput.value){ hInput.value = fx.homeScore; found++; }
                if(aInput && !aInput.value){ aInput.value = fx.awayScore; }
              }
            });
          });
        }catch(e){ /* seguimos con las demás fechas */ }
      }
      statusEl.textContent = found ? ('Se encontraron '+found+' resultado(s). Revisa y dale Guardar.') : 'No se encontraron resultados nuevos todavía.';
    });

    el.querySelectorAll('[data-save-result]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-save-result');
        var h = el.querySelector('[data-res-home="'+mid+'"]').value;
        var a = el.querySelector('[data-res-away="'+mid+'"]').value;
        if(h===''||a===''){ alert('Ingresa el marcador completo'); return; }
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        var m = state.matches.find(function(x){return x.id===mid;});
        m.homeScore = parseInt(h); m.awayScore = parseInt(a); m.status = 'finished';
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-edit-result]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-edit-result');
        var h = el.querySelector('[data-edit-home="'+mid+'"]').value;
        var a = el.querySelector('[data-edit-away="'+mid+'"]').value;
        if(h===''||a===''){ alert('Ingresa el marcador completo'); return; }
        if(!confirm('¿Confirmas actualizar este resultado? Los puntos de todos se recalcularán automáticamente.')) return;
        btn.disabled = true;
        btn.textContent = 'Actualizando...';
        var m = state.matches.find(function(x){return x.id===mid;});
        m.homeScore = parseInt(h); m.awayScore = parseInt(a); m.status = 'finished';
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    // Respaldo manual del marcador en vivo: nunca depende de que el cron de
    // /api/live-updates ande a tiempo ni de que API-Football responda.
    el.querySelectorAll('[data-mark-live]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-mark-live');
        btn.disabled = true;
        var m = state.matches.find(function(x){return x.id===mid;});
        m.status = 'live';
        if(m.homeScore==null) m.homeScore = 0;
        if(m.awayScore==null) m.awayScore = 0;
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-live-score]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-live-score');
        var h = el.querySelector('[data-live-home="'+mid+'"]').value;
        var a = el.querySelector('[data-live-away="'+mid+'"]').value;
        if(h===''||a===''){ alert('Ingresa el marcador completo'); return; }
        btn.disabled = true;
        btn.textContent = 'Actualizando...';
        var m = state.matches.find(function(x){return x.id===mid;});
        m.homeScore = parseInt(h); m.awayScore = parseInt(a);
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-add-goal]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-add-goal');
        var team = el.querySelector('[data-goal-team="'+mid+'"]').value;
        var minuteVal = el.querySelector('[data-goal-minute="'+mid+'"]').value;
        var minute = minuteVal===''? null : parseInt(minuteVal);
        if(minuteVal!=='' && (isNaN(minute) || minute<0)){ alert('El minuto no es válido'); return; }
        btn.disabled = true;
        var m = state.matches.find(function(x){return x.id===mid;});
        if(!m.goals) m.goals = [];
        m.goals.push({ team: team, minute: minute });
        if(team==='home'){ m.homeScore = (m.homeScore||0) + 1; } else { m.awayScore = (m.awayScore||0) + 1; }
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-del-goal]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var parts = btn.getAttribute('data-del-goal').split('|');
        var mid = parts[0], idx = parseInt(parts[1]);
        if(!confirm('¿Quitar este gol? El marcador se ajusta automáticamente.')) return;
        btn.disabled = true;
        var m = state.matches.find(function(x){return x.id===mid;});
        var goal = (m.goals||[])[idx];
        if(!goal) return;
        m.goals.splice(idx, 1);
        if(goal.team==='home'){ m.homeScore = Math.max(0, (m.homeScore||0) - 1); } else { m.awayScore = Math.max(0, (m.awayScore||0) - 1); }
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-finish-match]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-finish-match');
        if(!confirm('¿Finalizar este partido con el marcador actual? Quedará como resultado oficial.')) return;
        btn.disabled = true;
        btn.textContent = 'Finalizando...';
        var m = state.matches.find(function(x){return x.id===mid;});
        m.status = 'finished';
        await saveMatch(m);
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-del-match]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-del-match');
        if(!confirm('¿Eliminar este partido? También se borrarán las predicciones asociadas a él.')) return;
        btn.disabled = true;
        btn.textContent = 'Eliminando...';
        // deleteMatchDoc necesita leer state.predictions[mid] para borrar
        // también sus predicciones, así que se llama ANTES de limpiar el
        // estado local — si no, no sabría cuáles documentos borrar.
        await deleteMatchDoc(mid);
        state.matches = state.matches.filter(function(m){return m.id!==mid;});
        delete state.predictions[mid];
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-del-profile]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var pid = btn.getAttribute('data-del-profile');
        if(!confirm('¿Eliminar este perfil? También se borrarán sus predicciones y su pronóstico de pre-temporada.')) return;
        btn.disabled = true;
        btn.textContent = 'Eliminando...';
        var matchesWithPred = Object.keys(state.predictions).filter(function(mid){
          return state.predictions[mid] && (pid in state.predictions[mid]);
        });
        if(state.preseason.picks[pid]) delete state.preseason.picks[pid];
        await Promise.all(
          [deleteProfileDoc(pid), savePreseason()].concat(
            matchesWithPred.map(function(mid){ return deletePrediction(mid, pid); })
          )
        );
        state.profiles = state.profiles.filter(function(p){return p.id!==pid;});
        matchesWithPred.forEach(function(mid){ delete state.predictions[mid][pid]; });
        if(state.myId === pid){ await logout(); return; }
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-reset-pin]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var pid = btn.getAttribute('data-reset-pin');
        var newPin = prompt('Escribe el PIN nuevo de 4 dígitos para esta persona:');
        if(newPin === null) return;
        if(!/^\d{4}$/.test(newPin)){ alert('El PIN debe ser de 4 dígitos'); return; }
        btn.disabled = true;
        btn.textContent = 'Reseteando...';
        try{
          var idToken = await auth.currentUser.getIdToken();
          var resp = await fetch('/api/profile-login', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
            body: JSON.stringify({ mode:'adminReset', profileId:pid, newPin:newPin })
          });
          var data = await resp.json();
          if(!resp.ok){ alert(data.error || 'No se pudo resetear el PIN.'); }
          else { alert('Listo. Avísale a la persona su nuevo PIN.'); }
        }catch(e){
          alert('No se pudo conectar. Revisa tu conexión.');
        }
        btn.disabled = false;
        btn.textContent = 'Resetear PIN';
      });
    });

    el.querySelectorAll('[data-logo-file]').forEach(function(input){
      input.addEventListener('change', function(e){
        var tid = input.getAttribute('data-logo-file');
        var f = e.target.files[0];
        if(!f) return;
        var label = el.querySelector('[data-logo-label="'+tid+'"]');
        input.disabled = true;
        if(label) label.textContent = 'Subiendo...';
        resizeImageToDataUrl(f, 150).then(async function(dataUrl){
          var t = teamById(tid);
          if(!t) return;
          t.logoUrl = dataUrl;
          await saveTeam(t);
          renderGestionar(el);
        }).catch(function(){
          alert('No se pudo procesar la imagen.');
          input.disabled = false;
          if(label) label.textContent = 'Subir escudo';
        });
      });
    });

    var botPhotoFile = document.getElementById('bot-photo-file');
    if(botPhotoFile){
      botPhotoFile.addEventListener('change', function(e){
        var f = e.target.files[0];
        if(!f) return;
        var labelSpan = document.getElementById('bot-photo-btn-label');
        botPhotoFile.disabled = true;
        if(labelSpan) labelSpan.textContent = 'Procesando...';
        resizeImageToDataUrl(f, 150).then(async function(dataUrl){
          var bot = getBotProfile();
          if(!bot) return;
          bot.photo = dataUrl;
          await saveProfile(bot);
          renderGestionar(el);
        }).catch(function(){
          alert('No se pudo procesar la imagen.');
          botPhotoFile.disabled = false;
          if(labelSpan) labelSpan.textContent = 'Subir foto';
        });
      });
    }

    var fillBotPredsBtn = document.getElementById('fill-bot-preds-btn');
    if(fillBotPredsBtn){
      fillBotPredsBtn.addEventListener('click', async function(){
        var btn = this;
        btn.disabled = true;
        btn.textContent = 'Generando...';
        var filled = await fillMissingBotPredictions();
        // Usamos alert() (no un span de estado) porque si se generó algo,
        // el guardado dispara el listener en tiempo real de 'matches', que
        // repinta Gestionar solo — un texto de estado normal se borraría
        // en esa carrera. El alert() siempre se alcanza a ver.
        btn.disabled = false;
        btn.textContent = 'Generar predicciones faltantes de Carlos Antonio Vélez';
        alert(filled ? ('Se generaron '+filled+' predicción(es) nueva(s) de Carlos Antonio Vélez.') : 'Ya tenía predicción en todos los partidos.');
      });
    }

    var saveBotPreseasonBtn = document.getElementById('save-bot-preseason-btn');
    if(saveBotPreseasonBtn){
      saveBotPreseasonBtn.addEventListener('click', async function(){
        var btn = this;
        var championTeamId = document.getElementById('bot-champion').value;
        var scorerName = document.getElementById('bot-scorer').value.trim();
        if(!championTeamId || !scorerName){ alert('Completa campeón y goleador'); return; }
        var bot = getBotProfile();
        if(!bot) return;
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        state.preseason.picks[bot.id] = { championTeamId:championTeamId, scorerName:scorerName };
        await savePreseason();
        renderGestionar(el);
      });
    }

    document.getElementById('add-team-btn').addEventListener('click', async function(){
      var btn = this;
      var competition = document.getElementById('t-competition').value;
      var name = document.getElementById('t-name').value.trim();
      var code = document.getElementById('t-code').value.trim().toUpperCase();
      var color = document.getElementById('t-color').value;
      if(!name || !code){ alert('Completa nombre y código'); return; }
      btn.disabled = true;
      btn.textContent = 'Agregando...';
      var newTeam = { id:uid(), name:name, code:code, color:color, competition:competition };
      state.teams.push(newTeam);
      await saveTeam(newTeam);
      renderGestionar(el);
    });

    el.querySelectorAll('[data-del-team]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var tid = btn.getAttribute('data-del-team');
        if(!confirm('¿Eliminar este equipo?')) return;
        btn.disabled = true;
        btn.textContent = 'Eliminando...';
        state.teams = state.teams.filter(function(t){return t.id!==tid;});
        await deleteTeamDoc(tid);
        renderGestionar(el);
      });
    });

    var delMundialBtn = document.getElementById('del-mundial-test-data-btn');
    if(delMundialBtn){
      delMundialBtn.addEventListener('click', async function(){
        var btn = this;
        var mundialMatchIds = state.matches.filter(function(m){ return matchCompetition(m)==='mundial'; }).map(function(m){ return m.id; });
        var mundialTeamIds = state.teams.filter(function(t){ return teamCompetition(t)==='mundial'; }).map(function(t){ return t.id; });
        if(!confirm('¿Borrar '+mundialMatchIds.length+' partido(s) (con sus predicciones) y '+mundialTeamIds.length+' equipo(s) del Mundial? Esta acción no se puede deshacer.')) return;
        btn.disabled = true;
        btn.textContent = 'Borrando...';
        // deleteMatchDoc necesita leer state.predictions[matchId] para saber
        // qué predicciones borrar, así que corre ANTES de limpiar el estado local.
        for(var i=0;i<mundialMatchIds.length;i++){
          await deleteMatchDoc(mundialMatchIds[i]);
          delete state.predictions[mundialMatchIds[i]];
        }
        state.matches = state.matches.filter(function(m){ return matchCompetition(m)!=='mundial'; });
        for(var j=0;j<mundialTeamIds.length;j++){
          await deleteTeamDoc(mundialTeamIds[j]);
        }
        state.teams = state.teams.filter(function(t){ return teamCompetition(t)!=='mundial'; });
        renderGestionar(el);
      });
    }

    var saveRealBtn = document.getElementById('save-real-standings');
    if(saveRealBtn){
      saveRealBtn.addEventListener('click', async function(){
        var btn = this;
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        state.teams.filter(function(t){ return teamCompetition(t)==='fpc'; }).forEach(function(t){
          var row = state.realStandings[t.id] || {};
          ['pj','pg','pe','pp','gf','gc'].forEach(function(field){
            var input = el.querySelector('[data-real="'+t.id+'"][data-field="'+field+'"]');
            row[field] = parseInt(input.value) || 0;
          });
          state.realStandings[t.id] = row;
        });
        await saveRealStandings();
        renderGestionar(el);
      });
    }

    var lockPicksBtn = document.getElementById('lock-picks-btn');
    if(lockPicksBtn){
      lockPicksBtn.addEventListener('click', async function(){
        var btn = this;
        if(!confirm('¿Bloquear las predicciones de pre-temporada? Nadie podrá cambiarlas después.')) return;
        btn.disabled = true;
        btn.textContent = 'Bloqueando...';
        state.preseason.picksLocked = true;
        await savePreseason();
        renderGestionar(el);
      });
    }
    var lockBtn = document.getElementById('lock-preseason-btn');
    if(lockBtn){
      lockBtn.addEventListener('click', async function(){
        var btn = this;
        var championTeamId = document.getElementById('ps-champion').value;
        var scorerName = document.getElementById('ps-scorer').value.trim();
        if(!championTeamId){ alert('Selecciona el campeón real'); return; }
        var scorerCorrectIds = [];
        el.querySelectorAll('[data-scorer-correct]').forEach(function(cb){
          if(cb.checked) scorerCorrectIds.push(cb.getAttribute('data-scorer-correct'));
        });
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        state.preseason.picksLocked = true;
        state.preseason.result = { championTeamId:championTeamId, scorerName:scorerName, scorerCorrectIds:scorerCorrectIds, locked:true };
        await savePreseason();
        renderGestionar(el);
      });
    }
    var reopenBtn = document.getElementById('reopen-preseason');
    if(reopenBtn){
      reopenBtn.addEventListener('click', async function(){
        var btn = this;
        if(!confirm('¿Reabrir los pronósticos de pre-temporada? Se perderá la calificación del goleador y todos podrán volver a editar su pronóstico.')) return;
        btn.disabled = true;
        btn.textContent = 'Reabriendo...';
        state.preseason.result = null;
        state.preseason.picksLocked = false;
        await savePreseason();
        renderGestionar(el);
      });
    }
  }

  function teamOptions(competition){
    var teams = competition ? state.teams.filter(function(t){ return teamCompetition(t)===competition; }) : state.teams;
    return '<option value="">Selecciona</option>' + teams.map(function(t){
      return '<option value="'+t.id+'">'+escapeHtml(t.name)+'</option>';
    }).join('');
  }

  /* ---------- BOOT ---------- */
  async function showMain(){
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('main-shell').classList.remove('hidden');
    renderShell();
    renderView();
  }

  // Cierra la sesión real de Firebase Auth (perfil o admin) y vuelve a
  // entrar anónimo, para que la pantalla de login pueda seguir leyendo
  // Firestore. No toca nada en Firestore — todos los datos siguen intactos,
  // esto solo cambia qué perfil está "activo" en este navegador.
  async function logout(){
    await signOut(auth);
    state.myId = null;
    state.adminUnlocked = false;
    state.tab = 'predicciones';
    document.getElementById('main-shell').classList.add('hidden');
    await ensureAuth();
    // El nuevo uid anónimo es distinto al de antes — vuelve a suscribir las
    // predicciones para que "mis predicciones" quede armado con ese uid.
    await loadAll();
    renderLogin();
  }

  async function boot(){
    try{
      await ensureAuth();
      await loadAll();
      hideBootLoading();
      // El uid de la sesión actual (perfil o admin) es la fuente de verdad
      // de quién soy — no un valor guardado a mano en localStorage, que
      // cualquiera podría editar sin haber probado ningún PIN.
      var user = auth.currentUser;
      var myProfile = user ? profileById(user.uid) : null;
      if(myProfile){
        state.myId = myProfile.id;
        showMain();
      } else {
        renderLogin();
      }
    }catch(err){
      showFatalError(err);
    }
  }

  boot().catch(showFatalError);
})();
