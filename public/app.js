'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Estado del cliente ----------
  let CFG = null;
  let EMP = [];
  let S = null;            // estado público del servidor
  let ME = null;           // 0 | 1 | null (espectador)
  let entered = false;     // ya pasó el menú
  let lastPhase = null;
  const P = [newPanelState(), newPanelState()];
  const randCursor = [0, 0];
  const randTimers = [null, null];
  let phaseTimers = [];
  let gridBuilt = false;

  function newPanelState() { return { q: null, deadline: 0, total: 20000, locked: false, picked: null }; }

  // ---------- Token de sesión (por pestaña) ----------
  let token;
  try { token = sessionStorage.getItem('vil_token'); } catch (_) { /* ignorar */ }
  if (!token) {
    token = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    try { sessionStorage.setItem('vil_token', token); } catch (_) { /* ignorar */ }
  }

  const socket = io({ transports: ['websocket', 'polling'] });

  // ---------- Sonido ----------
  let actx = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem('vil_sound') !== '0'; } catch (_) { /* ignorar */ }
  function tone(freq, dur = 0.12, type = 'sine', vol = 0.12, delay = 0) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + delay;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (_) { /* ignorar */ }
  }
  const sfx = {
    tick: () => tone(660, 0.08, 'square', 0.06),
    go: () => { tone(880, 0.35, 'square', 0.1); tone(1320, 0.35, 'square', 0.06); },
    right: () => { tone(784, 0.1, 'triangle', 0.14); tone(1175, 0.18, 'triangle', 0.14, 0.09); },
    wrong: () => { tone(160, 0.28, 'sawtooth', 0.12); },
    timeout: () => { tone(220, 0.15, 'square', 0.08); tone(150, 0.25, 'square', 0.08, 0.14); },
    floor: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.12, i * 0.08)),
    select: () => tone(520, 0.06, 'square', 0.05),
    lock: () => { tone(440, 0.08, 'square', 0.1); tone(880, 0.18, 'square', 0.1, 0.08); },
    vs: () => { tone(110, 0.5, 'sawtooth', 0.15); tone(220, 0.5, 'square', 0.08, 0.05); },
    win: () => [523, 659, 784, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.18, 'triangle', 0.13, i * 0.12))
  };

  // ---------- Utilidades de UI ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  const avatar = (e) => (e.foto ? `<img src="fotos/${encodeURIComponent(e.foto)}" alt="">` : `<span class="emo">${e.emoji || '🙂'}</span>`);
  // figura completa recortada (sin fondo) para la pantalla de selección; si no hay, usa la foto/emoji
  const figure = (e) => (e.figura ? `<img class="figura" src="fotos/${encodeURIComponent(e.figura)}" alt="">` : avatar(e));
  // retrato alto para la franja de selección: la figura recortada (se ve la cabeza y el torso)
  const tile = (e) => (e.figura ? `<img src="fotos/${encodeURIComponent(e.figura)}" alt="">` : avatar(e));
  const portrait = (e, extra = '') => `<div class="portrait ${extra}" style="--c:${e ? e.color : '#555'}">${e ? avatar(e) : '?'}</div>`;
  const empOf = (slot) => {
    const p = S && S.players[slot];
    return p && p.charIdx !== null && p.charIdx !== undefined ? EMP[p.charIdx] : null;
  };
  let currentView = null;
  const showView = (id) => {
    $$('.view').forEach((v) => { v.hidden = v.id !== id; });
    if (id !== currentView) { currentView = id; $('#main').scrollTop = 0; }
  };
  const clearPhaseTimers = () => { phaseTimers.forEach(clearTimeout); phaseTimers = []; };

  // ---------- Conexión ----------
  socket.on('connect', () => {
    $('#reconnect').hidden = true;
    socket.emit('hello', { token });
  });
  socket.on('disconnect', () => { $('#reconnect').hidden = false; });
  socket.on('init', (d) => {
    CFG = d.cfg; EMP = d.empleados;
    buildGrid();
    buildBuilding();
  });
  socket.on('role', ({ slot }) => {
    ME = slot;
    if (slot !== null) entered = true;
    render();
  });
  socket.on('toast', toast);
  socket.on('state', (st) => { S = st; render(); });

  socket.on('question', (q) => {
    const p = P[q.slot];
    p.q = q;
    p.total = q.ms;
    p.deadline = performance.now() + q.ms;
    p.locked = false;
    p.picked = null;
    renderQuestion(q.slot);
  });

  socket.on('result', (r) => {
    P[r.slot].deadline = 0;
    showResult(r);
    const mine = ME === r.slot;
    if (mine || ME === null) {
      if (r.floorDelta > 0) setTimeout(sfx.floor, 350);
      else if (r.timedOut) sfx.timeout();
      else if (r.correct) sfx.right();
      else sfx.wrong();
    }
  });

  // ---------- Barra superior ----------
  function updateTopbar() {
    const slots = $('#slots');
    slots.innerHTML = S.players.map((p, i) => {
      const cls = !p.taken ? '' : (p.connected ? 'on' : 'off');
      const label = !p.taken ? 'libre' : (p.connected ? 'conectado' : 'reconectando…');
      const canTake = entered && ME === null && !p.taken && S.phase === 'select';
      return `<div class="slot-chip s${i} ${cls}"><i></i><b>J${i + 1}</b><span>${label}</span>${canTake ? `<button data-take="${i}">Entrar</button>` : ''}</div>`;
    }).join('');
    const chip = $('#me-chip');
    if (ME === null) {
      chip.className = 'chip';
      chip.textContent = `👀 Espectador${S.spectators > 1 ? ` · ${S.spectators} mirando` : ''}`;
    } else {
      chip.className = `chip p${ME}`;
      chip.textContent = `Eres el Jugador ${ME + 1}`;
    }
    $('#btn-leave').hidden = ME === null;
    $('#btn-sound').textContent = soundOn ? '🔊' : '🔇';
  }

  document.addEventListener('click', (e) => {
    const take = e.target.closest('[data-take]');
    if (take) {
      sfx.select();
      entered = true;
      socket.emit('take', { slot: Number(take.dataset.take) });
      render();
    }
  });
  $('#m-spec').addEventListener('click', () => { entered = true; render(); });
  $('#btn-leave').addEventListener('click', () => { socket.emit('leave'); });
  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('vil_sound', soundOn ? '1' : '0'); } catch (_) { /* ignorar */ }
    if (soundOn) sfx.select();
    updateTopbar();
  });
  $('#btn-admin').addEventListener('click', () => {
    const key = window.prompt('Clave de administrador para reiniciar la sala:');
    if (key) socket.emit('admin-reset', { key });
  });

  // ---------- Render general ----------
  function render() {
    if (!S || !CFG) return;
    updateTopbar();

    let view;
    if (!entered) view = 'v-menu';
    else if (S.phase === 'select') view = 'v-select';
    else if (S.phase === 'vs') view = 'v-vs';
    else view = 'v-game';
    showView(view);

    // Los avisos del servidor solo se muestran cuando cambian (no al entrar por primera vez)
    if (render.lastMsg !== undefined && S.message && S.message !== render.lastMsg) toast(S.message);
    render.lastMsg = S.message;

    if (view === 'v-menu') renderMenu();
    if (view === 'v-select') renderSelect();
    if (view === 'v-vs') renderVs();
    if (view === 'v-game') renderGame();

    if (S.phase !== lastPhase) onPhaseChange(S.phase, lastPhase);
    lastPhase = S.phase;
    // Pantalla final (también para quien entra a mirar cuando ya terminó)
    if (view === 'v-game' && S.phase === 'finished' && $('#endscreen').hidden) showEnd();
  }

  function onPhaseChange(phase, prev) {
    clearPhaseTimers();
    $('#countdown').hidden = true;
    $('#endscreen').hidden = true;
    if (phase === 'select') {
      P.forEach((p, i) => { P[i] = newPanelState(); });
    }
    if (phase === 'vs') sfx.vs();
    if (phase === 'countdown') {
      P.forEach((p, i) => { P[i] = newPanelState(); });
      if (S.phase === 'countdown') resetGameUi();
      runCountdown();
    }
  }

  // ---------- Menú ----------
  function renderMenu() {
    [0, 1].forEach((i) => {
      const btn = $(`[data-take="${i}"]`, $('#v-menu'));
      const p = S.players[i];
      const free = !p.taken && S.phase === 'select';
      btn.disabled = !free;
      $(`#m-s${i}`).textContent = free ? 'Disponible' : (p.taken ? 'Ocupado' : 'Partida en curso');
    });
    $('#menu-note').textContent = S.phase !== 'select'
      ? 'Hay una partida en curso. Puedes mirarla como espectador.'
      : (S.players.every((p) => p.taken) ? 'Ya hay 2 jugadores. Entra como espectador para mirar.' : '');
  }

  // ---------- Selección de personajes (estilo Tekken) ----------
  // Casillas: 0 = "?", 1..N = empleados, N+1 = "?". El servidor guarda el índice de casilla del cursor.
  const isRandomCell = (c) => c === 0 || c === EMP.length + 1;
  const randAnim = [null, null];

  function cellHTML(c) {
    if (isRandomCell(c)) {
      return `<div class="cell rnd" data-c="${c}" title="Al azar"><div class="face"><span class="q">?</span></div></div>`;
    }
    const e = EMP[c - 1];
    return `<div class="cell" data-c="${c}" style="--c:${e.color}" title="${esc(e.nombre)}"><div class="face">${tile(e)}</div><span class="nm">${esc(e.nombre)}</span></div>`;
  }

  function buildGrid() {
    if (gridBuilt) return;
    gridBuilt = true;
    const N = EMP.length;
    // dos filas como en Tekken: "?" al inicio de la primera y "?" al final de la segunda
    const total = N + 2;
    const per = Math.ceil(total / 2);
    const rows = [0, 1].map((r) => {
      const cells = [];
      for (let c = r * per; c < Math.min(total, (r + 1) * per); c++) cells.push(c);
      return `<div class="grow">${cells.map(cellHTML).join('')}</div>`;
    });
    const g = $('#grid');
    g.innerHTML = rows.join('');
    g.addEventListener('mouseover', (ev) => {
      const c = ev.target.closest('.cell');
      if (!c || ME === null || !S || S.phase !== 'select') return;
      moveCursorTo(Number(c.dataset.c));
    });
    g.addEventListener('click', (ev) => {
      const c = ev.target.closest('.cell');
      if (!c) return;
      if (ME === null) return toast('Entra como Jugador 1 o 2 para elegir.');
      const i = Number(c.dataset.c);
      const me = S.players[ME];
      if (me.randoming) return;
      if (me.locked) {
        // ya había elegido: un clic en otro empleado (o en "?") cambia la elección
        if (!isRandomCell(i) && me.charIdx === i - 1) return;
        return tryLock(i);
      }
      if (me.cursor === i) tryLock(i);
      else moveCursorTo(i); // en celular el primer toque marca y el segundo elige
    });
  }

  // Un empleado no está disponible si el rival lo eligió o lo tiene reservado por el azar
  const takenByOther = (empIdx) => S.players.some((p, s) => s !== ME && ((p.locked && p.charIdx === empIdx) || (p.randoming && p.randomTarget === empIdx)));

  function moveCursorTo(c) {
    const me = S.players[ME];
    if (!me || me.locked || me.randoming || me.cursor === c) return;
    me.cursor = c;
    socket.emit('cursor', { index: c });
    sfx.select();
    renderSelect();
  }

  function tryLock(c) {
    const me = S.players[ME];
    const cell = c === undefined ? me.cursor : c;
    if (isRandomCell(cell)) { sfx.select(); socket.emit('random'); return; }
    const idx = cell - 1;
    if (takenByOther(idx)) {
      const el = $(`.cell[data-c="${cell}"]`);
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      return toast('Ese empleado ya fue elegido por tu rival.');
    }
    sfx.lock();
    socket.emit('lock', { index: idx });
  }

  function displayCursor(slot) {
    const p = S.players[slot];
    return p.randoming && randCursor[slot] ? randCursor[slot] : p.cursor;
  }

  // ----- Efecto "tragamonedas" del azar -----
  // Recorre todos los empleados en el orden de la cuadrícula, al menos una vuelta completa,
  // va perdiendo velocidad y se detiene en el empleado que el servidor sorteó.
  function startRandomAnim(slot) {
    const p = S.players[slot];
    const order = $$('#grid .cell:not(.rnd)').map((e) => Number(e.dataset.c)); // orden visual
    const len = order.length;
    const target = order.indexOf(p.randomTarget + 1);
    if (!len || target < 0) return;
    let start = order.indexOf(p.cursor);
    if (start < 0) start = 0;
    const dist = (((target - start) % len) + len) % len;
    let steps = dist + len;            // siempre pasa por todos
    if (steps < 20) steps += len;      // y suficientes pasos para que se sienta la máquina
    const w = Array.from({ length: steps }, (_, k) => 1 + 11 * Math.pow((k + 1) / steps, 3));
    const sum = w.reduce((a, b) => a + b, 0);
    const delays = w.map((x) => (x / sum) * CFG.RANDOM_SPIN_MS);
    const anim = { timer: null };
    randAnim[slot] = anim;
    randCursor[slot] = order[start];
    let k = 0;
    const step = () => {
      k++;
      randCursor[slot] = order[(start + k) % len];
      if (S && S.phase === 'select') { updateGrid(); renderFighters(); }
      if (k < steps) {
        tone(300 + 25 * (k % 12), 0.05, 'square', 0.05);
        anim.timer = setTimeout(step, delays[k]);
      } else {
        sfx.lock();
      }
    };
    anim.timer = setTimeout(step, delays[0]);
  }

  function syncRandomAnimations() {
    [0, 1].forEach((slot) => {
      const p = S.players[slot];
      if (p.randoming && !randAnim[slot]) startRandomAnim(slot);
      else if (!p.randoming && randAnim[slot]) {
        clearTimeout(randAnim[slot].timer);
        randAnim[slot] = null;
        randCursor[slot] = 0;
      }
    });
  }

  function renderSelect() {
    syncRandomAnimations();
    updateGrid();
    renderFighters();
    renderControls();
  }

  function updateGrid() {
    $$('#grid .cell').forEach((cell) => {
      const c = Number(cell.dataset.c);
      const bits = [];
      [0, 1].forEach((s) => {
        const p = S.players[s];
        const cursorHere = p.taken && !p.locked && displayCursor(s) === c;
        const lockedHere = p.locked && !isRandomCell(c) && p.charIdx === c - 1;
        cell.classList.toggle(`c${s}`, cursorHere);
        cell.classList.toggle(`l${s}`, lockedHere);
        if (lockedHere) bits.push(`<span class="badge t${s}">P${s + 1}</span>`);
        else if (cursorHere) bits.push(`<span class="badge t${s}">${s + 1}P</span>`);
      });
      cell.querySelectorAll('.badge').forEach((n) => n.remove());
      cell.insertAdjacentHTML('beforeend', bits.join(''));
    });
  }

  function renderFighters() {
    [0, 1].forEach((s) => {
      const p = S.players[s];
      const cell = p.locked ? p.charIdx + 1 : displayCursor(s);
      const showRandom = p.taken && isRandomCell(cell);
      const e = p.taken && !showRandom ? EMP[cell - 1] : null;
      const canTake = ME === null && !p.taken && entered;

      let status = 'Esperando jugador…';
      if (p.taken) {
        if (!p.connected) status = 'Reconectando…';
        else if (p.locked) status = '<span class="ready">✔ ¡LISTO!</span>';
        else if (p.randoming) status = '<span class="rand">🎲 Eligiendo al azar…</span>';
        else status = 'Eligiendo…';
      }

      // Barra de nombre
      const nb = $(`#nb${s}`);
      const nbKey = `${p.taken}|${cell}|${p.locked}|${p.randoming}|${p.connected}`;
      if (nb.dataset.key !== nbKey) {
        nb.dataset.key = nbKey;
        nb.classList.toggle('is-locked', p.locked);
        nb.style.setProperty('--c', e ? e.color : '#c9a0ff');
        const name = e ? e.nombre : (showRandom ? '¿ AL AZAR ?' : (p.taken ? '' : `JUGADOR ${s + 1}`));
        nb.innerHTML = `<div class="nm1">${esc(name)}</div><div class="nm2">${e ? `${esc(e.cargo)} · ` : ''}${status}</div>`;
      }

      // Personaje grande (solo se redibuja si cambia algo, para no reiniciar la animación)
      const hero = $(`#f${s}`);
      const key = `${p.taken}|${cell}|${p.locked}|${p.randoming}|${ME}|${canTake}|${p.connected}`;
      if (hero.dataset.key === key) return;
      hero.dataset.key = key;
      hero.className = `hero h${s}${(!e) ? ' waiting' : ''}${p.locked ? ' locked' : ''}`;
      hero.style.setProperty('--c', e ? e.color : '#6f7aa8');
      hero.innerHTML = `
        <div class="aura"></div>
        <div class="fig">${e ? figure(e) : '<span class="emo">?</span>'}</div>
        ${p.locked ? '<div class="lockmark">¡LISTO!</div>' : ''}
        <div class="ptag"><span>P-${s + 1}</span>${ME === s ? '<span class="you">TÚ</span>' : ''}</div>
        ${canTake ? `<button class="btn take gold" data-take="${s}">ENTRAR COMO J${s + 1}</button>` : ''}`;
    });
  }

  function renderControls() {
    const c = $('#sel-controls');
    const hint = $('#sel-hint');
    if (ME === null) {
      c.innerHTML = '';
      c.dataset.key = '';
      hint.innerHTML = '👀 Estás mirando como espectador. Si hay un lugar libre, usa el botón <b>Entrar</b>.';
      return;
    }
    const me = S.players[ME];
    const bothLocked = S.players.every((p) => p.locked);
    const key = `${me.locked}|${me.randoming}|${S.players[1 - ME].taken}|${bothLocked}`;
    if (c.dataset.key === key) return;
    c.dataset.key = key;
    if (me.randoming) {
      c.innerHTML = '';
      hint.textContent = '🎲 Girando…';
    } else if (me.locked) {
      c.innerHTML = '<button class="btn" id="b-unlock">↩ CAMBIAR PERSONAJE</button><button class="btn" id="b-rand2">🎲 AL AZAR</button>';
      $('#b-unlock').onclick = () => socket.emit('unlock');
      $('#b-rand2').onclick = () => { sfx.select(); socket.emit('random'); };
      hint.textContent = bothLocked ? '¡Listos! Empezando…'
        : (S.players[1 - ME].taken ? 'Esperando que tu rival elija… (puedes cambiar haciendo clic en otro empleado)' : 'Esperando a que entre tu rival… (puedes cambiar haciendo clic en otro empleado)');
    } else {
      c.innerHTML = '<button class="btn" id="b-rand">🎲 AL AZAR</button><button class="btn gold" id="b-lock">✔ ELEGIR</button>';
      $('#b-rand').onclick = () => { sfx.select(); socket.emit('random'); };
      $('#b-lock').onclick = () => tryLock();
      hint.innerHTML = '<kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> mover · <kbd>Enter</kbd> o clic para elegir · <kbd>R</kbd> o casilla <b>?</b> al azar · <kbd>Esc</kbd> cambiar';
    }
  }

  // Movimiento del cursor con flechas: se calcula por posición real en pantalla
  function neighborCell(cur, dir) {
    const els = $$('#grid .cell');
    const curEl = els.find((e) => Number(e.dataset.c) === cur) || els[0];
    const r0 = curEl.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy = r0.top + r0.height / 2;
    const info = els.filter((e) => e !== curEl).map((e) => {
      const r = e.getBoundingClientRect();
      return { c: Number(e.dataset.c), dx: r.left + r.width / 2 - cx, dy: r.top + r.height / 2 - cy };
    });
    const sameRow = (o) => Math.abs(o.dy) < r0.height * 0.5;
    const horiz = dir === 'left' || dir === 'right';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;
    let cands;
    if (horiz) cands = info.filter((o) => sameRow(o) && o.dx * sign > 1).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx));
    else cands = info.filter((o) => o.dy * sign > r0.height * 0.5).sort((a, b) => (Math.abs(a.dy) + Math.abs(a.dx) * 1.6) - (Math.abs(b.dy) + Math.abs(b.dx) * 1.6));
    if (cands.length) return cands[0].c;
    // sin vecino: da la vuelta al otro extremo
    if (horiz) {
      const row = info.filter(sameRow).sort((a, b) => (a.dx - b.dx) * sign);
      return row.length ? row[0].c : cur;
    }
    const far = info.filter((o) => o.dy * sign < -r0.height * 0.5);
    if (!far.length) return cur;
    const extreme = far.reduce((m, o) => (Math.abs(o.dy) > Math.abs(m) ? o.dy : m), 0);
    return far.filter((o) => Math.abs(o.dy - extreme) < r0.height * 0.5).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))[0].c;
  }

  // ---------- VS ----------
  function renderVs() {
    [0, 1].forEach((s) => {
      const e = empOf(s);
      $(`#vs${s}`).innerHTML = `
        <div class="tagp">JUGADOR ${s + 1}</div>
        ${portrait(e)}
        <div class="cname" style="--c:${e ? e.color : '#c9a0ff'}">${e ? esc(e.nombre) : ''}</div>
        <div class="ccargo">${e ? esc(e.cargo) : ''}</div>`;
    });
  }

  // ---------- Edificio ----------
  function buildBuilding() {
    const rows = $('#rows');
    if (rows.dataset.built) return;
    rows.dataset.built = '1';
    let html = '';
    for (let f = 1; f <= CFG.TARGET_FLOOR; f++) {
      const top = f === CFG.TARGET_FLOOR;
      html += `<div class="rowf ${top ? 'top' : ''}"><span>${f}</span><span class="office">${top ? '🏆' : ''}</span><span>${f}</span></div>`;
    }
    rows.innerHTML = html;
  }

  function updateCabs() {
    [0, 1].forEach((s) => {
      const cab = $(`#cab-${s}`);
      const p = S.players[s];
      const e = empOf(s);
      if (!cab.dataset.char || cab.dataset.char !== String(p.charIdx)) {
        cab.dataset.char = String(p.charIdx);
        cab.innerHTML = `<span class="ctag">J${s + 1}</span>${e ? avatar(e) : ''}`;
        cab.style.background = e ? `linear-gradient(180deg, color-mix(in srgb, ${e.color} 55%, white), ${e.color})` : '';
      }
      const f = p.floor;
      const prev = Number(cab.style.getPropertyValue('--f')) || CFG.START_FLOOR;
      cab.style.setProperty('--f', f);
      cab.classList.toggle('arrived', f >= CFG.TARGET_FLOOR);
      cab.dataset.prev = prev;
    });
  }

  // ---------- Juego ----------
  function resetGameUi() {
    [0, 1].forEach((s) => {
      const cab = $(`#cab-${s}`);
      cab.style.setProperty('--f', CFG.START_FLOOR);
      cab.dataset.char = '';
    });
    buildPanels();
    renderGame();
  }

  function buildPanels() {
    [0, 1].forEach((s) => {
      const el = $(`#panel-${s}`);
      el.innerHTML = `
        <div class="ph">
          <div class="av"></div>
          <div class="pn"><b class="name">—</b><span class="role"></span></div>
          <div class="score"><b class="pts">0</b><small>PUNTOS</small></div>
        </div>
        <div class="pstats"><span class="fl">Piso 1</span><span class="ok">✔ 0</span><span class="ko">✖ 0</span></div>
        <div class="pbar" title="Progreso al siguiente piso"><i></i></div>
        <div class="qbox">
          <div class="qwrap">
            <div class="timer"><i></i><b>20</b></div>
            <div class="qn"></div>
            <div class="qtext"></div>
            <div class="opts"></div>
            <div class="fb"></div>
          </div>
          <div class="rival-status" hidden></div>
        </div>`;
    });
  }

  function renderGame() {
    if (!$(`#panel-0 .ph`)) {
      buildPanels();
      // espectador que entra tarde: dibuja las preguntas que ya estaban en curso
      [0, 1].forEach((s) => { if (P[s].q) renderQuestion(s); });
    }
    buildBuilding();
    updateCabs();
    [0, 1].forEach((s) => {
      const p = S.players[s];
      const e = empOf(s);
      const el = $(`#panel-${s}`);
      el.classList.toggle('mine', ME === s);
      el.classList.toggle('other', ME !== s);
      $('.av', el).innerHTML = portrait(e);
      $('.name', el).textContent = e ? e.nombre : '—';
      $('.name', el).style.setProperty('--c', e ? e.color : '#c9a0ff');
      $('.role', el).innerHTML = `<em>JUGADOR ${s + 1}</em> · ${e ? esc(e.cargo) : ''}${ME === s ? ' · TÚ' : ''}`;
      const ptsEl = $('.pts', el);
      if (ptsEl.textContent !== String(p.points)) {
        ptsEl.textContent = p.points;
        ptsEl.classList.remove('bump'); void ptsEl.offsetWidth; ptsEl.classList.add('bump');
      }
      $('.fl', el).textContent = `Piso ${p.floor} / ${CFG.TARGET_FLOOR}`;
      $('.ok', el).textContent = `✔ ${p.correct}`;
      $('.ko', el).textContent = `✖ ${p.wrong}${p.timeouts ? ` · ⏰ ${p.timeouts}` : ''}`;
      const prog = p.floor >= CFG.TARGET_FLOOR ? 100 : ((p.points % CFG.POINTS_PER_FLOOR) / CFG.POINTS_PER_FLOOR) * 100;
      $('.pbar i', el).style.width = `${prog}%`;

      // Un jugador no ve la pregunta de su rival: solo su estado.
      const hideQuestion = ME !== null && ME !== s;
      $('.qwrap', el).hidden = hideQuestion;
      const rs = $('.rival-status', el);
      rs.hidden = !hideQuestion;
      if (hideQuestion && !rs.dataset.locked) {
        rs.className = 'rival-status';
        rs.textContent = S.phase === 'playing' ? (p.thinking ? '🤔 Pensando la respuesta…' : '⏳ Cargando pregunta…') : '';
      }
    });
  }

  function renderQuestion(slot) {
    const p = P[slot];
    const el = $(`#panel-${slot}`);
    if (!el || !$('.qwrap', el)) return;
    const q = p.q;
    $('.qn', el).textContent = `PREGUNTA ${q.n}`;
    $('.qtext', el).textContent = q.text;
    const fb = $('.fb', el);
    fb.textContent = ''; fb.className = 'fb';
    const rs = $('.rival-status', el);
    delete rs.dataset.locked;
    const interactive = ME === slot;
    const letters = ['A', 'B', 'C', 'D'];
    $('.opts', el).innerHTML = q.options.map((o, i) =>
      `<button class="opt" data-i="${i}" ${interactive ? '' : 'disabled'}><span class="k">${letters[i]}</span><span>${esc(o)}</span></button>`
    ).join('');
    if (interactive) {
      $$('.opt', el).forEach((b) => b.addEventListener('click', () => choose(slot, Number(b.dataset.i))));
    }
    if (S && !$('#v-game').hidden) renderGame();
  }

  function choose(slot, i) {
    const p = P[slot];
    if (!p.q || p.locked || S.phase !== 'playing') return;
    p.locked = true;
    p.picked = i;
    const el = $(`#panel-${slot}`);
    $$('.opt', el).forEach((b, k) => { b.disabled = true; b.classList.toggle('picked', k === i); });
    socket.emit('answer', { id: p.q.id, choice: i });
  }

  function showResult(r) {
    const el = $(`#panel-${r.slot}`);
    if (!el) return;
    const opts = $$('.opt', el);
    opts.forEach((b, k) => {
      b.disabled = true;
      b.classList.remove('picked');
      if (k === r.correctIdx) b.classList.add('right');
      else if (k === r.choice) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const fb = $('.fb', el);
    let text, cls;
    if (r.timedOut) { text = '⏰ Tiempo agotado: nueva pregunta'; cls = 'to'; }
    else if (r.correct) { text = `✔ ¡Correcto! +${r.delta} pts (${r.seconds}s)`; cls = 'ok'; }
    else { text = r.delta ? `✖ Incorrecto ${r.delta} pts` : '✖ Incorrecto'; cls = 'ko'; }
    if (r.floorDelta > 0) text += ` · ¡Subes al piso ${r.floor}!`;
    if (r.floorDelta < 0) text += ` · Bajas al piso ${r.floor}`;
    fb.textContent = text; fb.className = `fb ${cls}`;

    // Estado visible para el rival
    const rs = $('.rival-status', el);
    rs.dataset.locked = '1';
    rs.className = `rival-status ${r.correct ? 'ok' : (r.timedOut ? '' : 'ko')}`;
    rs.textContent = r.timedOut ? '⏰ No alcanzó a responder' : (r.correct ? `✔ Acertó +${r.delta}` : `✖ Falló ${r.delta || ''}`);
    setTimeout(() => { if (rs.dataset.locked) delete rs.dataset.locked; }, CFG.FEEDBACK_MS - 100);

    // Burbuja flotante en el ascensor
    if (r.delta !== 0) {
      const cab = $(`#cab-${r.slot}`);
      const pop = document.createElement('span');
      pop.className = `pop ${r.delta > 0 ? 'up' : 'down'}`;
      pop.textContent = r.delta > 0 ? `+${r.delta}` : String(r.delta);
      cab.appendChild(pop);
      setTimeout(() => pop.remove(), 1400);
    }
  }

  // Temporizadores de las preguntas
  function tickTimers() {
    if (S && S.phase === 'playing') {
      [0, 1].forEach((s) => {
        const p = P[s];
        const el = $(`#panel-${s}`);
        if (!el) return;
        const t = $('.timer', el);
        if (!t) return;
        if (!p.deadline) { return; }
        const left = Math.max(0, p.deadline - performance.now());
        $('i', t).style.width = `${(left / p.total) * 100}%`;
        $('b', t).textContent = Math.ceil(left / 1000);
        t.classList.toggle('warn', left <= 10000 && left > 5000);
        t.classList.toggle('danger', left <= 5000);
      });
    }
    requestAnimationFrame(tickTimers);
  }
  requestAnimationFrame(tickTimers);

  // ---------- Cuenta regresiva y final ----------
  function runCountdown() {
    const ov = $('#countdown');
    const num = $('#cd-num');
    const seq = [['3', 0], ['2', 1000], ['1', 2000], ['¡YA!', 3000]];
    ov.hidden = false;
    seq.forEach(([txt, at]) => {
      phaseTimers.push(setTimeout(() => {
        num.textContent = txt;
        num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
        if (txt === '¡YA!') sfx.go(); else sfx.tick();
      }, at));
    });
    phaseTimers.push(setTimeout(() => { ov.hidden = true; }, 3400));
  }

  function showEnd() {
    const w = S.winner;
    const e = empOf(w);
    const wp = S.players[w];
    const lp = S.players[1 - w];
    const le = empOf(1 - w);
    const iWon = ME === w;
    const title = ME === null ? '¡LLEGÓ A LA AGENCIA VILASECA S.A.!' : (iWon ? '¡GANASTE! 🎉' : 'Perdiste esta vez');
    const stat = (p, ee, s) => `<div><b>J${s + 1} · ${ee ? esc(ee.nombre) : ''}</b>Piso ${p.floor} · ${p.points} pts<br>✔ ${p.correct} · ✖ ${p.wrong} · ⏰ ${p.timeouts}</div>`;
    const ov = $('#endscreen');
    ov.innerHTML = `
      <div class="end-card">
        <h2>${title}</h2>
        ${portrait(e)}
        <div class="winname">${e ? esc(e.nombre) : ''}</div>
        <div class="ccargo">Jugador ${w + 1} llegó primero al piso ${CFG.TARGET_FLOOR}</div>
        <div class="res">${stat(S.players[0], empOf(0), 0)}${stat(S.players[1], empOf(1), 1)}</div>
        ${ME !== null ? '<button class="btn gold" id="b-again">VOLVER A ELEGIR PERSONAJES</button>' : ''}
        <div class="auto">Nueva selección en <span id="auto-n">${Math.round(CFG.FINISHED_RESET_MS / 1000)}</span> s</div>
      </div>`;
    ov.hidden = false;
    const again = $('#b-again');
    if (again) again.onclick = () => socket.emit('again');
    let n = Math.round(CFG.FINISHED_RESET_MS / 1000);
    const iv = setInterval(() => {
      n--; const sp = $('#auto-n'); if (sp) sp.textContent = Math.max(0, n);
      if (n <= 0) clearInterval(iv);
    }, 1000);
    phaseTimers.push(setTimeout(() => clearInterval(iv), CFG.FINISHED_RESET_MS));
    for (let i = 0; i < 40; i++) {
      const c = document.createElement('span');
      c.className = 'confetti';
      c.textContent = ['🎉', '✨', '🏆', '⭐', '🎊'][i % 5];
      c.style.left = `${Math.random() * 100}%`;
      c.style.animationDuration = `${3 + Math.random() * 3}s`;
      c.style.animationDelay = `${Math.random() * 2}s`;
      ov.appendChild(c);
    }
    sfx.win();
  }

  // ---------- Teclado ----------
  document.addEventListener('keydown', (ev) => {
    if (!S || !entered || ME === null || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    if (S.phase === 'select') {
      const me = S.players[ME];
      let handled = true;
      const dirs = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
      if (me.locked) {
        if (k === 'Escape' || k === 'Backspace') socket.emit('unlock'); else handled = false;
      } else if (me.randoming) {
        handled = false;
      } else if (dirs[k]) moveCursorTo(neighborCell(me.cursor, dirs[k]));
      else if (k === 'Enter' || k === ' ') tryLock();
      else if (k === 'r' || k === 'R') { sfx.select(); socket.emit('random'); }
      else handled = false;
      if (handled) ev.preventDefault();
    } else if (S.phase === 'playing') {
      const map = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3, A: 0, B: 1, C: 2, D: 3 };
      if (k in map && P[ME].q) { choose(ME, map[k]); ev.preventDefault(); }
    } else if (S.phase === 'finished' && (k === 'Enter')) {
      socket.emit('again');
    }
  });
})();
