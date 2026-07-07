import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

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
    adminPassword: null,
    adminUnlocked: false,
    myId: null,
    tab: 'predicciones',
    tablaSub: 'apuesta'
  };

  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  function randomPin(){ return String(Math.floor(1000 + Math.random()*9000)); }

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

  function localGet(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
  function localSet(key, val){ try{ localStorage.setItem(key, val); }catch(e){} }

  async function loadAll(){
    var profilesDoc = await loadDoc('profiles', {list:[]});
    state.profiles = profilesDoc.list || [];

    var teamsDoc = await loadDoc('teams', null);
    if(teamsDoc && teamsDoc.list && teamsDoc.list.length){
      state.teams = teamsDoc.list;
    } else {
      state.teams = DEFAULT_TEAMS.map(function(t){ return {id:uid(), name:t[0], code:t[1], color:t[2]}; });
      await saveDoc('teams', { list: state.teams });
    }

    var matchesDoc = await loadDoc('matches', {matches:[], predictions:{}});
    state.matches = matchesDoc.matches || [];
    state.predictions = matchesDoc.predictions || {};

    var psDoc = await loadDoc('preseason', { picks:{}, result:null });
    state.preseason = psDoc;

    var rsDoc = await loadDoc('realStandings', { data:{} });
    state.realStandings = rsDoc.data || {};

    var adminDoc = await loadDoc('admin', { password:null });
    state.adminPassword = adminDoc.password;

    state.myId = localGet('profetas-my-id');
  }

  async function saveTeams(){ await saveDoc('teams', { list: state.teams }); }
  async function saveProfiles(){ await saveDoc('profiles', { list: state.profiles }); }
  async function saveMatchesAndPredictions(){ await saveDoc('matches', { matches: state.matches, predictions: state.predictions }); }
  async function savePreseason(){ await saveDoc('preseason', state.preseason); }
  async function saveRealStandings(){ await saveDoc('realStandings', { data: state.realStandings }); }
  async function saveAdminPassword(){ await saveDoc('admin', { password: state.adminPassword }); }
  function saveMyId(){ localSet('profetas-my-id', state.myId); }

  function teamById(id){ return state.teams.find(function(t){return t.id===id;}); }
  function profileById(id){ return state.profiles.find(function(p){return p.id===id;}); }

  function shieldHtml(team, size){
    size = size || 44;
    if(!team) return '<div class="shield" style="background:#444;width:'+size+'px;height:'+size+'px;">?</div>';
    if(team.logoUrl){
      return '<img class="shield" src="'+team.logoUrl+'" alt="'+team.name+'" style="width:'+size+'px;height:'+size+'px;">';
    }
    return '<div class="shield" style="background:'+team.color+';width:'+size+'px;height:'+size+'px;font-size:'+(size*0.32)+'px;">'+team.code+'</div>';
  }

  function avatarHtml(profile, size){
    size = size || 34;
    if(profile && profile.photo){
      return '<img class="avatar" src="'+profile.photo+'" style="width:'+size+'px;height:'+size+'px;">';
    }
    var initials = profile ? profile.name.slice(0,2).toUpperCase() : '?';
    return '<div class="avatar-fallback" style="width:'+size+'px;height:'+size+'px;">'+initials+'</div>';
  }

  function isLocked(match){
    if(!match.kickoff) return false;
    return new Date(match.kickoff).getTime() <= Date.now();
  }

  function pointsForPrediction(match, pred){
    if(!pred || pred.home===''||pred.home===undefined||pred.away===''||pred.away===undefined) return 0;
    var ph = parseInt(pred.home), pa = parseInt(pred.away);
    var rh = match.homeScore, ra = match.awayScore;
    if(isNaN(ph)||isNaN(pa)) return 0;
    var exactPts = match.phase==='cuadrangulares' ? 5 : 3;
    var resultPts = match.phase==='cuadrangulares' ? 2 : 1;
    if(ph===rh && pa===ra) return exactPts;
    var predOutcome = ph>pa?'H':(ph<pa?'A':'D');
    var realOutcome = rh>ra?'H':(rh<ra?'A':'D');
    if(predOutcome===realOutcome) return resultPts;
    return 0;
  }

  function computeStandings(){
    var totals = {};
    state.profiles.forEach(function(p){ totals[p.id] = 0; });
    state.matches.forEach(function(m){
      if(m.homeScore===null||m.homeScore===undefined) return;
      var predsForMatch = state.predictions[m.id] || {};
      Object.keys(predsForMatch).forEach(function(pid){
        if(!(pid in totals)) totals[pid]=0;
        totals[pid] += pointsForPrediction(m, predsForMatch[pid]);
      });
    });
    if(state.preseason.result){
      var res = state.preseason.result;
      Object.keys(state.preseason.picks).forEach(function(pid){
        var pick = state.preseason.picks[pid];
        if(!(pid in totals)) totals[pid]=0;
        if(res.championTeamId && pick.championTeamId===res.championTeamId) totals[pid]+=12;
        if(res.scorerName && pick.scorerName && pick.scorerName.trim().toLowerCase()===res.scorerName.trim().toLowerCase()) totals[pid]+=12;
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
    if(state.profiles.length){
      html += '<div class="profile-grid">';
      state.profiles.forEach(function(p){
        html += '<div class="profile-tile" data-select-profile="'+p.id+'">'+avatarHtml(p,56)+'<div class="profile-tile-name">'+p.name+'</div></div>';
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
      node.addEventListener('click', function(){
        var pid = node.getAttribute('data-select-profile');
        var profile = profileById(pid);
        var pin = prompt('Ingresa tu PIN de 4 dígitos para entrar como '+profile.name+':');
        if(pin === null) return;
        if(pin !== profile.pin){ alert('PIN incorrecto.'); return; }
        state.myId = pid;
        saveMyId();
        showMain();
      });
    });

    var pendingPhoto = null;
    document.getElementById('photo-picker').addEventListener('click', function(){
      document.getElementById('photo-file').click();
    });
    document.getElementById('photo-file').addEventListener('change', function(e){
      var f = e.target.files[0];
      if(!f) return;
      var reader = new FileReader();
      reader.onload = function(ev){
        pendingPhoto = ev.target.result;
        document.getElementById('photo-picker').innerHTML = '<img src="'+pendingPhoto+'">';
      };
      reader.readAsDataURL(f);
    });
    document.getElementById('create-profile-btn').addEventListener('click', async function(){
      var name = document.getElementById('new-name').value.trim();
      var pin = document.getElementById('new-pin').value.trim();
      if(!name){ alert('Escribe tu nombre'); return; }
      if(!/^\d{4}$/.test(pin)){ alert('El PIN debe ser de 4 dígitos'); return; }
      var newP = { id: uid(), name: name, photo: pendingPhoto, pin: pin };
      state.profiles.push(newP);
      await saveProfiles();
      state.myId = newP.id;
      saveMyId();
      showMain();
    });
  }

  /* ---------- SHELL ---------- */
  var TABS = [
    {id:'predicciones', label:'Predicciones'},
    {id:'tabla', label:'Tabla'},
    {id:'pretemporada', label:'Pre-temporada'},
    {id:'gestionar', label:'Gestionar'}
  ];

  function renderShell(){
    var me = profileById(state.myId);
    document.getElementById('me-box').innerHTML = avatarHtml(me,34) + '<span class="me-name">'+(me?me.name:'')+'</span>';
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
    if(state.tab==='tabla') return renderTabla(el);
    if(state.tab==='pretemporada') return renderPretemporada(el);
    if(state.tab==='gestionar'){
      if(!state.adminUnlocked) return renderGestionarGate(el);
      return renderGestionar(el);
    }
  }

  /* ---------- PREDICCIONES ---------- */
  function renderPredicciones(el){
    var upcoming = state.matches.filter(function(m){ return (m.homeScore===null || m.homeScore===undefined) && !isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    var lockedNoResult = state.matches.filter(function(m){ return (m.homeScore===null || m.homeScore===undefined) && isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    var finished = state.matches.filter(function(m){ return !(m.homeScore===null || m.homeScore===undefined); })
      .sort(function(a,b){ return new Date(b.kickoff||0)-new Date(a.kickoff||0); });

    var html = '';
    html += '<div class="section-title">Por jugar</div>';
    if(!upcoming.length){
      html += '<div class="empty">No hay partidos abiertos para predecir.</div>';
    } else {
      upcoming.forEach(function(m){ html += matchCardHtml(m, true); });
    }
    if(lockedNoResult.length){
      html += '<div class="section-title" style="margin-top:22px;">Cerrados, esperando resultado</div>';
      lockedNoResult.forEach(function(m){ html += matchCardHtml(m, false, true); });
    }
    html += '<div class="section-title" style="margin-top:22px;">Finalizados</div>';
    if(!finished.length){
      html += '<div class="empty">Todavía no hay resultados cargados.</div>';
    } else {
      finished.forEach(function(m){ html += matchCardHtml(m, false); });
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-save-pred]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-save-pred');
        var homeInput = el.querySelector('[data-pred-home="'+mid+'"]');
        var awayInput = el.querySelector('[data-pred-away="'+mid+'"]');
        var h = homeInput.value, a = awayInput.value;
        if(h===''||a===''){ alert('Completa ambos marcadores'); return; }
        if(!state.predictions[mid]) state.predictions[mid] = {};
        state.predictions[mid][state.myId] = { home:h, away:a };
        await saveMatchesAndPredictions();
        renderPredicciones(el);
      });
    });
  }

  function matchCardHtml(m, editable, waitingResult){
    var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
    var phaseClass = m.phase==='cuadrangulares' ? 'phase-cuadrangulares' : 'phase-regular';
    var phaseLabel = m.phase==='cuadrangulares' ? 'Cuadrangulares' : 'Regular';
    var myPred = (state.predictions[m.id]||{})[state.myId] || {home:'',away:''};
    var kickoffLabel = m.kickoff ? new Date(m.kickoff).toLocaleString('es-CO', {weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}) : ('Fecha '+(m.matchday||'-'));

    var html = '<div class="card match-card">';
    html += '<div class="match-top"><span class="phase-badge '+phaseClass+'">'+phaseLabel+'</span><span class="match-meta">'+kickoffLabel+'</span></div>';
    html += '<div class="match-teams">';
    html += '<div class="team">'+shieldHtml(home)+'<span class="team-name">'+(home?home.name:'?')+'</span></div>';

    if(editable){
      html += '<div class="score-inputs">';
      html += '<input type="number" min="0" data-pred-home="'+m.id+'" value="'+myPred.home+'">';
      html += '<span class="vs-label">–</span>';
      html += '<input type="number" min="0" data-pred-away="'+m.id+'" value="'+myPred.away+'">';
      html += '</div>';
    } else if(waitingResult){
      html += '<div class="score-inputs"><span class="vs-label">vs</span></div>';
    } else {
      html += '<div class="score-inputs"><span class="result-final">'+m.homeScore+'</span><span class="vs-label">–</span><span class="result-final">'+m.awayScore+'</span></div>';
    }

    html += '<div class="team">'+shieldHtml(away)+'<span class="team-name">'+(away?away.name:'?')+'</span></div>';
    html += '</div>';

    if(editable){
      html += '<div class="match-actions"><button class="btn btn-gold" data-save-pred="'+m.id+'">Guardar predicción</button></div>';
    } else if(waitingResult){
      var predW = (state.predictions[m.id]||{})[state.myId];
      html += '<div class="match-actions"><span class="locked-tag">Predicción cerrada</span>';
      if(predW){ html += '<span class="points-pill" style="margin-left:8px;">Tu predicción: '+predW.home+'-'+predW.away+'</span>'; }
      html += '</div>';
    } else {
      var pred = (state.predictions[m.id]||{})[state.myId];
      var pts = pred ? pointsForPrediction(m, pred) : null;
      html += '<div class="match-actions">';
      if(pred){
        html += '<span class="points-pill'+(pts===0?' zero':'')+'">Tu predicción '+pred.home+'-'+pred.away+' · '+pts+' pts</span>';
      } else {
        html += '<span class="points-pill zero">No predijiste este partido</span>';
      }
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
      var rows = computeStandings();
      if(!rows.length){
        html += '<div class="empty">Todavía no hay jugadores.</div>';
      } else {
        rows.forEach(function(r, i){
          var rankClass = i===0?'r1':(i===1?'r2':(i===2?'r3':''));
          html += '<div class="board-row'+(i===0?' top1':'')+'">';
          html += '<div class="rank '+rankClass+'">'+(i+1)+'</div>';
          html += avatarHtml(r.profile, 38);
          html += '<div class="board-name">'+r.profile.name+'</div>';
          html += '<div><div class="board-points">'+r.points+'</div><span class="board-points-label">Puntos</span></div>';
          html += '</div>';
        });
      }
    } else {
      var teamRows = state.teams.map(function(t){
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
          html += '<div class="board-name" style="font-size:13px;">'+r.team.name+'</div>';
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
  }

  /* ---------- PRETEMPORADA ---------- */
  function renderPretemporada(el){
    var locked = !!(state.preseason.result && state.preseason.result.locked);
    var myPick = state.preseason.picks[state.myId] || {championTeamId:'', scorerName:''};

    var html = '<div class="card">';
    html += '<div class="section-title">Tu pronóstico antes de que arranque la liga</div>';
    html += '<div class="pick-row"><span class="pick-label">Campeón</span>';
    html += '<select id="pick-champion" '+(locked?'disabled':'')+'>';
    html += '<option value="">Selecciona un equipo</option>';
    state.teams.forEach(function(t){
      html += '<option value="'+t.id+'"'+(myPick.championTeamId===t.id?' selected':'')+'>'+t.name+'</option>';
    });
    html += '</select></div>';
    html += '<div class="pick-row"><span class="pick-label">Goleador</span>';
    html += '<input type="text" id="pick-scorer" placeholder="Nombre del jugador" value="'+(myPick.scorerName||'').replace(/"/g,'&quot;')+'" '+(locked?'disabled':'')+'>';
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
      html += '<div style="font-size:14px;">Campeón: <b>'+(champ?champ.name:'-')+'</b></div>';
      html += '<div style="font-size:14px;margin-top:4px;">Goleador: <b>'+(state.preseason.result.scorerName||'-')+'</b></div></div>';
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
        html += '<div class="board-row">'+avatarHtml(p,34)+'<div class="board-name">'+p.name+'<div style="font-size:11px;color:var(--muted);">'+(champT?champT.name:'-')+' · '+(pick.scorerName||'-')+'</div></div></div>';
      });
    }

    el.innerHTML = html;
    if(!locked){
      document.getElementById('save-preseason').addEventListener('click', async function(){
        var championTeamId = document.getElementById('pick-champion').value;
        var scorerName = document.getElementById('pick-scorer').value.trim();
        if(!championTeamId || !scorerName){ alert('Completa campeón y goleador'); return; }
        state.preseason.picks[state.myId] = { championTeamId:championTeamId, scorerName:scorerName };
        await savePreseason();
        renderPretemporada(el);
      });
    }
  }

  /* ---------- PUERTA DE CONTRASEÑA ---------- */
  function renderGestionarGate(el){
    var isFirstTime = !state.adminPassword;
    var html = '<div class="card" style="max-width:320px;margin:20px auto;text-align:center;">';
    if(isFirstTime){
      html += '<div class="section-title">Crea tu contraseña de administrador</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Solo tú deberías conocerla. Se usará para gestionar partidos, equipos y resultados.</div>';
      html += '<input type="password" id="gate-pass1" placeholder="Nueva contraseña" style="width:100%;margin-bottom:8px;">';
      html += '<input type="password" id="gate-pass2" placeholder="Repite la contraseña" style="width:100%;margin-bottom:12px;">';
      html += '<button class="btn btn-gold" id="gate-create-btn" style="width:100%;">Crear contraseña</button>';
    } else {
      html += '<div class="section-title">Área de administrador</div>';
      html += '<input type="password" id="gate-pass" placeholder="Contraseña" style="width:100%;margin-bottom:10px;">';
      html += '<button class="btn btn-gold" id="gate-enter-btn" style="width:100%;">Entrar</button>';
      html += '<div id="gate-error" style="color:var(--danger);font-size:12px;margin-top:8px;"></div>';
    }
    html += '</div>';
    el.innerHTML = html;

    if(isFirstTime){
      document.getElementById('gate-create-btn').addEventListener('click', async function(){
        var p1 = document.getElementById('gate-pass1').value;
        var p2 = document.getElementById('gate-pass2').value;
        if(!p1 || p1.length<4){ alert('Usa al menos 4 caracteres'); return; }
        if(p1!==p2){ alert('Las contraseñas no coinciden'); return; }
        state.adminPassword = p1;
        await saveAdminPassword();
        state.adminUnlocked = true;
        renderGestionar(el);
      });
    } else {
      var tryEnter = async function(){
        var p = document.getElementById('gate-pass').value;
        if(p===state.adminPassword){
          state.adminUnlocked = true;
          renderGestionar(el);
        } else {
          document.getElementById('gate-error').textContent = 'Contraseña incorrecta';
        }
      };
      document.getElementById('gate-enter-btn').addEventListener('click', tryEnter);
      document.getElementById('gate-pass').addEventListener('keydown', function(e){ if(e.key==='Enter') tryEnter(); });
    }
  }

  /* ---------- RECORDATORIO WHATSAPP ---------- */
  function buildReminderText(){
    var upcoming = state.matches.filter(function(m){ return (m.homeScore===null||m.homeScore===undefined) && !isLocked(m); })
      .sort(function(a,b){ return new Date(a.kickoff||0)-new Date(b.kickoff||0); });
    if(!upcoming.length) return 'No hay partidos abiertos para predecir en este momento.';
    var next = upcoming[0];
    var home = teamById(next.homeTeamId), away = teamById(next.awayTeamId);
    var missing = state.profiles.filter(function(p){
      var pred = (state.predictions[next.id]||{})[p.id];
      return !pred;
    });
    var kickoffLabel = next.kickoff ? new Date(next.kickoff).toLocaleString('es-CO', {weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit'}) : 'Próximamente';
    var txt = '⚽ Recordatorio Los Profetas del FPC\n';
    txt += (home?home.name:'?') + ' vs ' + (away?away.name:'?') + ' - ' + kickoffLabel + '\n\n';
    if(missing.length){
      txt += 'Faltan por predecir:\n';
      missing.forEach(function(p){ txt += '- '+p.name+'\n'; });
      txt += '\n¡No se queden sin puntos! 🔮';
    } else {
      txt += '¡Todos ya predijeron este partido! 🎉';
    }
    return txt;
  }

  /* ---------- GESTIONAR ---------- */
  function renderGestionar(el){
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
    html += '<div class="form-row"><label>Local</label><select id="m-home">'+teamOptions()+'</select></div>';
    html += '<div class="form-row"><label>Visitante</label><select id="m-away">'+teamOptions()+'</select></div>';
    html += '<div class="form-row"><label>Fecha y hora de inicio</label><input type="datetime-local" id="m-kickoff"></div>';
    html += '<div class="form-row"><label>Fase</label><select id="m-phase"><option value="regular">Regular</option><option value="cuadrangulares">Cuadrangulares</option></select></div>';
    html += '</div>';
    html += '<button class="btn btn-gold" id="add-match-btn">Agregar partido</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Cargar resultados</div>';
    html += '<div class="auto-fetch-row">';
    html += '<button class="btn" id="auto-fetch-btn">Buscar resultados automáticos (API)</button>';
    html += '<span id="auto-fetch-status" style="font-size:11px;color:var(--muted);"></span>';
    html += '</div>';
    var pending = state.matches.filter(function(m){ return m.homeScore===null||m.homeScore===undefined; });
    if(!pending.length){
      html += '<div class="empty" style="padding:14px 0;">No hay partidos pendientes de resultado.</div>';
    } else {
      pending.forEach(function(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        html += '<div class="team-list-item">';
        html += '<div style="flex:1;font-size:13px;">'+(home?home.name:'?')+' vs '+(away?away.name:'?')+'<div style="font-size:11px;color:var(--muted);">'+(m.kickoff ? new Date(m.kickoff).toLocaleString('es-CO') : 'Sin hora')+' · '+(m.phase==='cuadrangulares'?'Cuadrangulares':'Regular')+'</div></div>';
        html += '<input type="number" min="0" style="width:44px;" data-res-home="'+m.id+'">';
        html += '<span class="vs-label">-</span>';
        html += '<input type="number" min="0" style="width:44px;" data-res-away="'+m.id+'">';
        html += '<button class="btn btn-gold" data-save-result="'+m.id+'">Guardar</button>';
        html += '<button class="btn btn-danger" data-del-match="'+m.id+'">Eliminar</button>';
        html += '</div>';
      });
    }
    html += '</div>';

    var finishedMatches = state.matches.filter(function(m){ return !(m.homeScore===null||m.homeScore===undefined); });
    if(finishedMatches.length){
      html += '<div class="card">';
      html += '<div class="section-title">Editar resultados ya cargados</div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Úsalo si la Dimayor cambia un resultado por reglamento — los puntos de todos se recalculan solos.</div>';
      finishedMatches.forEach(function(m){
        var home = teamById(m.homeTeamId), away = teamById(m.awayTeamId);
        html += '<div class="team-list-item">';
        html += '<div style="flex:1;font-size:13px;">'+(home?home.name:'?')+' vs '+(away?away.name:'?')+'</div>';
        html += '<input type="number" min="0" style="width:44px;" data-edit-home="'+m.id+'" value="'+m.homeScore+'">';
        html += '<span class="vs-label">-</span>';
        html += '<input type="number" min="0" style="width:44px;" data-edit-away="'+m.id+'" value="'+m.awayScore+'">';
        html += '<button class="btn" data-edit-result="'+m.id+'">Actualizar</button>';
        html += '<button class="btn btn-danger" data-del-match="'+m.id+'">Eliminar</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<div class="section-title">Equipos</div>';
    html += '<div class="auto-fetch-row">';
    html += '<button class="btn" id="fetch-shields-btn">Actualizar escudos desde API-Football</button>';
    html += '<span id="fetch-shields-status" style="font-size:11px;color:var(--muted);"></span>';
    html += '</div>';
    state.teams.forEach(function(t){
      html += '<div class="team-list-item">'+shieldHtml(t,32)+'<div style="flex:1;font-size:13px;">'+t.name+'</div><button class="btn btn-danger" data-del-team="'+t.id+'">Eliminar</button></div>';
    });
    html += '<div class="form-grid" style="margin-top:12px;">';
    html += '<div class="form-row"><label>Nombre</label><input type="text" id="t-name" placeholder="Nombre del equipo"></div>';
    html += '<div class="form-row"><label>Código (3-4 letras)</label><input type="text" id="t-code" maxlength="4" placeholder="EQU"></div>';
    html += '<div class="form-row"><label>Color</label><input type="color" id="t-color" value="#E8592B" style="height:36px;padding:2px;"></div>';
    html += '</div>';
    html += '<button class="btn btn-gold" id="add-team-btn">Agregar equipo</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Perfiles y PIN (por si alguien lo olvida)</div>';
    state.profiles.forEach(function(p){
      html += '<div class="admin-profile-row">'+avatarHtml(p,32)+'<div style="flex:1;font-size:13px;">'+p.name+'</div><span class="pin-pill">'+p.pin+'</span></div>';
    });
    if(!state.profiles.length){ html += '<div class="empty" style="padding:14px 0;">Todavía no hay perfiles creados.</div>'; }
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="section-title">Tabla real de la liga</div>';
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Actualiza esto manualmente después de cada fecha con los datos oficiales.</div>';
    state.teams.forEach(function(t){
      var s = state.realStandings[t.id] || {pj:0,pg:0,pe:0,pp:0,gf:0,gc:0};
      html += '<div class="team-list-item" style="flex-wrap:wrap;">';
      html += '<div style="width:100%;display:flex;align-items:center;gap:8px;margin-bottom:6px;">'+shieldHtml(t,26)+'<span style="font-size:13px;">'+t.name+'</span></div>';
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
    html += '<div class="section-title">Cerrar pre-temporada</div>';
    var locked = state.preseason.result && state.preseason.result.locked;
    if(locked){
      html += '<div class="locked-note">Ya se cerró y se cargó el resultado de pre-temporada.</div>';
      html += '<button class="btn" id="reopen-preseason" style="margin-top:10px;">Reabrir pronósticos</button>';
    } else {
      html += '<div class="form-row"><label>Campeón real</label><select id="ps-champion">'+teamOptions()+'</select></div>';
      html += '<div class="form-row"><label>Goleador real</label><input type="text" id="ps-scorer" placeholder="Nombre del jugador"></div>';
      html += '<button class="btn btn-gold" id="lock-preseason-btn">Cerrar y calificar (12 pts c/u)</button>';
    }
    html += '</div>';

    el.innerHTML = html;

    document.getElementById('lock-admin-btn').addEventListener('click', function(){
      state.adminUnlocked = false;
      renderGestionarGate(el);
    });

    document.getElementById('copy-reminder-btn').addEventListener('click', function(){
      var txt = document.getElementById('reminder-text').textContent;
      navigator.clipboard.writeText(txt).then(function(){
        var btn = document.getElementById('copy-reminder-btn');
        var original = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(function(){ btn.textContent = original; }, 1500);
      }).catch(function(){ alert('No se pudo copiar. Selecciona el texto manualmente.'); });
    });

    document.getElementById('add-match-btn').addEventListener('click', async function(){
      var home = document.getElementById('m-home').value;
      var away = document.getElementById('m-away').value;
      var kickoff = document.getElementById('m-kickoff').value;
      var phase = document.getElementById('m-phase').value;
      if(!home || !away || home===away){ alert('Elige dos equipos distintos'); return; }
      state.matches.push({ id:uid(), homeTeamId:home, awayTeamId:away, kickoff: kickoff || null, phase:phase, homeScore:null, awayScore:null });
      await saveMatchesAndPredictions();
      renderGestionar(el);
    });

    document.getElementById('auto-fetch-btn').addEventListener('click', async function(){
      var statusEl = document.getElementById('auto-fetch-status');
      var pendingMatches = state.matches.filter(function(m){ return m.homeScore===null||m.homeScore===undefined; });
      if(!pendingMatches.length){ statusEl.textContent = 'No hay partidos pendientes.'; return; }
      statusEl.innerHTML = '<span class="spinner"></span> Buscando...';
      var dates = Array.from(new Set(pendingMatches.filter(function(m){return m.kickoff;}).map(function(m){ return m.kickoff.slice(0,10); })));
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
        var m = state.matches.find(function(x){return x.id===mid;});
        m.homeScore = parseInt(h); m.awayScore = parseInt(a);
        await saveMatchesAndPredictions();
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
        var m = state.matches.find(function(x){return x.id===mid;});
        m.homeScore = parseInt(h); m.awayScore = parseInt(a);
        await saveMatchesAndPredictions();
        renderGestionar(el);
      });
    });

    el.querySelectorAll('[data-del-match]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var mid = btn.getAttribute('data-del-match');
        if(!confirm('¿Eliminar este partido? También se borrarán las predicciones asociadas a él.')) return;
        state.matches = state.matches.filter(function(m){return m.id!==mid;});
        delete state.predictions[mid];
        await saveMatchesAndPredictions();
        renderGestionar(el);
      });
    });

    document.getElementById('fetch-shields-btn').addEventListener('click', async function(){
      var statusEl = document.getElementById('fetch-shields-status');
      statusEl.innerHTML = '<span class="spinner"></span> Buscando escudos...';
      try{
        var resp = await fetch('/api/equipos');
        var data = await resp.json();
        if(data.error){ statusEl.textContent = data.error; return; }
        var apiTeams = data.teams || [];
        var updated = 0;
        state.teams.forEach(function(t){
          var tName = t.name.toLowerCase();
          var match = apiTeams.find(function(at){
            var aName = (at.name||'').toLowerCase();
            return aName===tName || aName.indexOf(tName.split(' ')[0])>=0 || tName.indexOf(aName.split(' ')[0])>=0;
          });
          if(match && match.logo){ t.logoUrl = match.logo; updated++; }
        });
        await saveTeams();
        statusEl.textContent = 'Se actualizaron '+updated+' escudo(s).';
        renderGestionar(el);
      }catch(e){
        statusEl.textContent = 'Error consultando la API.';
      }
    });

    document.getElementById('add-team-btn').addEventListener('click', async function(){
      var name = document.getElementById('t-name').value.trim();
      var code = document.getElementById('t-code').value.trim().toUpperCase();
      var color = document.getElementById('t-color').value;
      if(!name || !code){ alert('Completa nombre y código'); return; }
      state.teams.push({ id:uid(), name:name, code:code, color:color });
      await saveTeams();
      renderGestionar(el);
    });

    el.querySelectorAll('[data-del-team]').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var tid = btn.getAttribute('data-del-team');
        if(!confirm('¿Eliminar este equipo?')) return;
        state.teams = state.teams.filter(function(t){return t.id!==tid;});
        await saveTeams();
        renderGestionar(el);
      });
    });

    var saveRealBtn = document.getElementById('save-real-standings');
    if(saveRealBtn){
      saveRealBtn.addEventListener('click', async function(){
        state.teams.forEach(function(t){
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

    var lockBtn = document.getElementById('lock-preseason-btn');
    if(lockBtn){
      lockBtn.addEventListener('click', async function(){
        var championTeamId = document.getElementById('ps-champion').value;
        var scorerName = document.getElementById('ps-scorer').value.trim();
        if(!championTeamId || !scorerName){ alert('Completa campeón y goleador reales'); return; }
        state.preseason.result = { championTeamId:championTeamId, scorerName:scorerName, locked:true };
        await savePreseason();
        renderGestionar(el);
      });
    }
    var reopenBtn = document.getElementById('reopen-preseason');
    if(reopenBtn){
      reopenBtn.addEventListener('click', async function(){
        state.preseason.result = null;
        await savePreseason();
        renderGestionar(el);
      });
    }
  }

  function teamOptions(){
    return '<option value="">Selecciona</option>' + state.teams.map(function(t){
      return '<option value="'+t.id+'">'+t.name+'</option>';
    }).join('');
  }

  /* ---------- BOOT ---------- */
  async function showMain(){
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('main-shell').classList.remove('hidden');
    renderShell();
    renderView();
  }

  async function boot(){
    await loadAll();
    if(state.myId && profileById(state.myId)){
      showMain();
    } else {
      renderLogin();
    }
  }

  boot();
})();
