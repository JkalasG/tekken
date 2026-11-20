'use strict';
/**
 * Ascensor Vilaseca — servidor de juego en tiempo real.
 * Una sola sala: 2 jugadores (slot 0 y 1) + espectadores ilimitados.
 * El servidor es la autoridad: tiempo, puntos, pisos y preguntas.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const empleados = require('../data/empleados.json');
const preguntas = require('../data/preguntas.json');

// ---------- Reglas del juego (ajustables) ----------
const CFG = {
  START_FLOOR: 1,          // piso donde empiezan
  TARGET_FLOOR: 7,         // piso de la Agencia Vilaseca S.A.
  POINTS_PER_FLOOR: 20,    // cada 20 puntos suben un piso
  QUESTION_POINTS: 20,     // valor máximo de una pregunta
  FULL_POINTS_SECONDS: 5,  // responde dentro de este tiempo = puntos completos
  MAX_QUESTIONS: Number(process.env.MAX_QUESTIONS) || 12, // máximo de preguntas por jugador; si nadie llega al piso 7 gana quien tenga más puntos
  END_DELAY_MS: 1300,      // pausa final para ver llegar la cabina / el último resultado antes de mostrar al ganador
  THINK_EMOTE_MS: 10000,   // si no responde en 10 s aparece 🤔
  MIN_POINTS: 5,           // mínimo si responde correcto a destiempo
  WRONG_PENALTY: 5,        // puntos que se quitan al fallar
  QUESTION_SECONDS: Number(process.env.QUESTION_SECONDS) || 20,    // tiempo por pregunta; si se acaba, otra pregunta
  FEEDBACK_MS: 1600,       // pausa para mostrar si acertó o no
  VS_MS: 4500,             // duración de la pantalla VS
  COUNTDOWN_MS: 3500,      // 3, 2, 1, ¡YA!
  FINISHED_RESET_MS: 25000,// vuelve a selección después de terminar
  RECONNECT_GRACE_MS: 15000,
  VS_DELAY_MS: 1500,       // pausa tras elegir los dos (aún pueden cambiar) antes de la pantalla VS
  RANDOM_SPIN_MS: 4300,    // duración del giro estilo tragamonedas (lo anima el cliente)
  RANDOM_TOTAL_MS: 5000    // el servidor fija el personaje a los 5 s
};
const ADMIN_KEY = process.env.ADMIN_KEY || 'vilaseca';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 5000, pingTimeout: 8000 });

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Identificador de versión de la página (fecha del archivo más nuevo de public/).
// Si una pestaña abierta se reconecta y la versión cambió, se recarga sola.
function buildId() {
  let max = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else max = Math.max(max, fs.statSync(p).mtimeMs);
    }
  };
  try { walk(PUBLIC_DIR); } catch (_) { /* ignorar */ }
  return String(Math.round(max));
}
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- Utilidades ----------
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const floorOf = (points) =>
  Math.min(CFG.TARGET_FLOOR, CFG.START_FLOOR + Math.floor(points / CFG.POINTS_PER_FLOOR));

// ---------- Estado de la sala ----------
const usedOf = (p) => p.answered + p.timeouts; // preguntas ya gastadas (respondidas o agotadas)

const newPlayer = (slot) => ({
  slot,
  token: null,
  socketId: null,
  connected: false,
  graceTimer: null,
  cursor: slot === 0 ? 1 : empleados.length, // índice de casilla (0 y N+1 son las casillas '?')
  locked: false,
  charIdx: null,
  randoming: false,
  randomTarget: null,
  randomTimer: null,
  points: 0,
  floor: CFG.START_FLOOR,
  answered: 0,
  correct: 0,
  wrong: 0,
  timeouts: 0,
  timeSum: 0,        // segundos totales que tardó en responder (desempate)
  streak: 0,         // aciertos seguidos
  wrongStreak: 0,    // errores seguidos
  thinkTimer: null,
  deck: [],
  current: null,     // { id, q, startedAt }
  qTimer: null,
  nextTimer: null,
  lastResult: null
});

const room = {
  phase: 'select',   // select | vs | countdown | playing | finished
  players: [newPlayer(0), newPlayer(1)],
  winner: null,
  endReason: null,   // 'floor' (llegó al piso 7) | 'limit' (se acabaron las preguntas)
  ending: false,     // la partida ya está decidida y solo falta mostrar el último resultado
  endInfo: null,     // si terminó porque el rival ya no podía alcanzarlo: { finisher, other, ... } para explicarlo
  message: '',
  phaseTimer: null,
  vsTimer: null,
  gameTimers: [],
  qCounter: 0,
  decks: [[], []]
};

const bySocket = new Map(); // socket.id -> { token, slot|null }

function clearPlayerTimers(p) {
  clearTimeout(p.qTimer);
  clearTimeout(p.nextTimer);
  clearTimeout(p.randomTimer);
  clearTimeout(p.thinkTimer);
  p.qTimer = p.nextTimer = p.randomTimer = p.thinkTimer = null;
}

function resetPlayerGameState(p) {
  clearPlayerTimers(p);
  Object.assign(p, {
    locked: false, charIdx: null, randoming: false, randomTarget: null,
    points: 0, floor: CFG.START_FLOOR, answered: 0, correct: 0, wrong: 0, timeouts: 0, timeSum: 0, streak: 0, wrongStreak: 0,
    current: null, lastResult: null
  });
}

function publicPlayer(p) {
  return {
    slot: p.slot,
    taken: !!p.token,
    connected: p.connected,
    cursor: p.cursor,
    locked: p.locked,
    charIdx: p.charIdx,
    randoming: p.randoming,
    randomTarget: p.randoming ? p.randomTarget : null,
    points: p.points,
    floor: p.floor,
    answered: p.answered,
    correct: p.correct,
    wrong: p.wrong,
    timeouts: p.timeouts,
    used: usedOf(p),
    streak: p.streak,
    thinking: !!p.current
  };
}

function publicState() {
  return {
    phase: room.phase,
    players: room.players.map(publicPlayer),
    winner: room.winner,
    endReason: room.endReason,
    endInfo: room.endInfo,
    ending: room.ending,
    message: room.message,
    spectators: [...bySocket.values()].filter((s) => s.slot === null).length,
    phaseMs: room.phaseMs || 0
  };
}

function broadcast() {
  io.emit('state', publicState());
}

function setPhase(phase, ms) {
  clearTimeout(room.phaseTimer);
  room.phase = phase;
  room.phaseMs = ms || 0;
}

// ---------- Selección ----------
function toSelect(message) {
  clearTimeout(room.phaseTimer);
  clearTimeout(room.vsTimer);
  room.vsTimer = null;
  room.gameTimers.forEach(clearTimeout);
  room.gameTimers = [];
  room.players.forEach(resetPlayerGameState);
  room.winner = null;
  room.endReason = null;
  room.endInfo = null;
  room.ending = false;
  room.message = message || '';
  setPhase('select');
  broadcast();
}

// Cuando los dos eligieron hay una pausa corta (todavía pueden cambiar) y empieza el VS.
function maybeStartVs() {
  clearTimeout(room.vsTimer);
  room.vsTimer = null;
  if (room.phase !== 'select') return;
  if (!room.players.every((p) => p.token && p.locked)) return;
  room.vsTimer = setTimeout(() => {
    room.vsTimer = null;
    if (room.phase !== 'select' || !room.players.every((p) => p.token && p.locked)) return;
    setPhase('vs', CFG.VS_MS);
    room.message = '';
    broadcast();
    room.phaseTimer = setTimeout(startCountdown, CFG.VS_MS);
  }, CFG.VS_DELAY_MS);
}

function startCountdown() {
  setPhase('countdown', CFG.COUNTDOWN_MS);
  broadcast();
  room.phaseTimer = setTimeout(startPlaying, CFG.COUNTDOWN_MS);
}

// ---------- Elección de personaje ----------
// Un empleado no está disponible si el rival lo eligió o lo tiene reservado por el azar.
const takenByOther = (p, idx) => room.players.some(
  (o) => o !== p && ((o.locked && o.charIdx === idx) || (o.randoming && o.randomTarget === idx))
);

function lockCharacter(p, idx) {
  clearTimeout(p.randomTimer);
  p.randomTimer = null;
  p.charIdx = idx;
  p.cursor = idx + 1;
  p.locked = true;
  p.randoming = false;
  p.randomTarget = null;
  broadcast();
  maybeStartVs();
}

// Sorteo estilo tragamonedas: el servidor decide al instante el resultado y lo reserva;
// los clientes animan el recorrido por todos los personajes hasta detenerse en él.
function startRandom(p) {
  if (room.phase !== 'select' || p.randoming) return;
  const free = empleados.map((_, i) => i).filter((i) => !takenByOther(p, i));
  if (!free.length) return;
  if (p.locked) { p.locked = false; p.charIdx = null; }
  p.randoming = true;
  p.randomTarget = free[Math.floor(Math.random() * free.length)];
  broadcast();
  maybeStartVs(); // cancela un VS pendiente si ya había elegido
  p.randomTimer = setTimeout(() => {
    p.randomTimer = null;
    if (room.phase !== 'select' || !p.token || !p.randoming) return;
    lockCharacter(p, p.randomTarget);
  }, CFG.RANDOM_TOTAL_MS);
}

// ---------- Reacciones con emoticones ----------
// Todo se decide aquí para que jugadores y espectadores vean lo mismo.
const EMOTES = {
  streak: { 2: ['😄', '😁', '😀'], 3: ['😎', '🤩', '😆'], 4: ['🔥', '🥳', '🤑'], 5: ['🚀', '🤯', '💪'], 6: ['👑', '🏆', '🦸', '🌟'] },
  fast: ['⚡', '😉', '👌'],
  floorUp: ['🎉', '🙌', '🆙'],
  shame: ['😳', '🙈', '😅', '🤭'],       // 1 error
  worry: ['😬', '😰', '🥴'],             // 2 errores seguidos
  cry: ['😭', '😭', '😢'],               // 3 o más errores seguidos
  floorDown: ['😱', '📉', '😵'],
  timeout: ['🥱', '😴', '⏰'],
  think: ['🤔', '🧐'],
  overtaken: ['😤', '😠', '😒'],         // el rival te pasó
  rivalNear: ['😰', '😨'],               // el rival está a un piso de ganar
  nearWin: ['🤞', '😏'],
  start: ['💪', '😤', '🤞']
};
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function emote(slot, pool, kind, level = 1) {
  if (room.phase !== 'playing') return;
  io.emit('emote', { slot, emoji: pickOne(pool), kind, level });
}

// Reacciones de una respuesta ya resuelta (p = quien respondió)
function emotesForResult(p, r, prevPoints, prevFloor) {
  const rival = room.players[1 - p.slot];
  if (r.timedOut) {
    p.streak = 0;
    emote(p.slot, EMOTES.timeout, 'timeout');
  } else if (r.correct) {
    p.streak++;
    p.wrongStreak = 0;
    if (p.streak >= 2) emote(p.slot, EMOTES.streak[Math.min(p.streak, 6)], 'joy', Math.min(p.streak - 1, 5));
    else if (r.floorDelta > 0) emote(p.slot, EMOTES.floorUp, 'joy', 2);
    else if (r.seconds <= 3) emote(p.slot, EMOTES.fast, 'fast');
  } else {
    p.streak = 0;
    p.wrongStreak++;
    if (p.wrongStreak >= 3) emote(p.slot, EMOTES.cry, 'cry', Math.min(p.wrongStreak - 2, 3));
    else if (r.floorDelta < 0) emote(p.slot, EMOTES.floorDown, 'down', 2);
    else if (p.wrongStreak === 2) emote(p.slot, EMOTES.worry, 'shame', 2);
    else emote(p.slot, EMOTES.shame, 'shame');
  }
  // Reacciones del rival ante lo que pasó
  const nearWin = p.floor === CFG.TARGET_FLOOR - 1 && prevFloor < CFG.TARGET_FLOOR - 1;
  if (nearWin) {
    emote(rival.slot, EMOTES.rivalNear, 'worry', 2);
  } else if (prevPoints <= rival.points && p.points > rival.points && rival.points > 0) {
    emote(rival.slot, EMOTES.overtaken, 'angry', 2);
  }
}

// ---------- Juego ----------
function startPlaying() {
  room.ending = false;
  room.endReason = null;
  room.endInfo = null;
  setPhase('playing');
  room.decks = [[], []];
  // Mazos distintos: se baraja todo y se reparte alternado => nadie repite pregunta con el rival.
  const order = shuffle(preguntas.map((_, i) => i));
  order.forEach((qi, k) => room.decks[k % 2].push(qi));
  room.players.forEach((p) => { p.deck = room.decks[p.slot]; p.deckPos = 0; });
  broadcast();
  room.players.forEach(sendQuestion);
  room.players.forEach((p) => emote(p.slot, EMOTES.start, 'start'));
}

function nextQuestionFor(p) {
  if (p.deckPos >= p.deck.length) {
    p.deck = shuffle(p.deck);
    p.deckPos = 0;
  }
  const raw = preguntas[p.deck[p.deckPos++]];
  const opts = shuffle(raw.o.map((text, i) => ({ text, ok: i === raw.c })));
  return { text: raw.q, options: opts.map((o) => o.text), correctIdx: opts.findIndex((o) => o.ok) };
}

function emitToPlayerAndSpectators(p, event, payload) {
  if (p.socketId) io.to(p.socketId).emit(event, payload);
  io.to('spectators').emit(event, payload);
}

function sendQuestion(p) {
  if (room.phase !== 'playing' || room.ending || usedOf(p) >= CFG.MAX_QUESTIONS) return;
  const q = nextQuestionFor(p);
  const id = ++room.qCounter;
  const payload = {
    slot: p.slot,
    id,
    n: usedOf(p) + 1,
    max: CFG.MAX_QUESTIONS,
    text: q.text,
    options: q.options,
    ms: CFG.QUESTION_SECONDS * 1000
  };
  p.current = { id, correctIdx: q.correctIdx, startedAt: Date.now(), payload };
  emitToPlayerAndSpectators(p, 'question', payload);
  clearTimeout(p.qTimer);
  p.qTimer = setTimeout(() => resolveAnswer(p, id, null), CFG.QUESTION_SECONDS * 1000 + 250);
  clearTimeout(p.thinkTimer);
  p.thinkTimer = setTimeout(() => { if (p.current && p.current.id === id) emote(p.slot, EMOTES.think, 'think'); }, CFG.THINK_EMOTE_MS);
  broadcast();
}

function resolveAnswer(p, id, choice) {
  const cur = p.current;
  if (room.phase !== 'playing' || !cur || cur.id !== id) return;
  clearTimeout(p.qTimer);
  clearTimeout(p.thinkTimer);
  p.current = null;

  const elapsed = (Date.now() - cur.startedAt) / 1000;
  const timedOut = choice === null;
  const isCorrect = !timedOut && choice === cur.correctIdx;
  let delta = 0;

  if (timedOut) {
    p.timeouts++;
  } else if (isCorrect) {
    const slow = Math.max(0, Math.floor(elapsed - CFG.FULL_POINTS_SECONDS));
    delta = Math.max(CFG.MIN_POINTS, CFG.QUESTION_POINTS - slow);
    p.correct++;
    p.answered++;
    p.timeSum += elapsed;
  } else {
    delta = -Math.min(CFG.WRONG_PENALTY, p.points);
    p.wrong++;
    p.answered++;
    p.timeSum += elapsed;
  }

  const prevFloor = p.floor;
  const prevPoints = p.points;
  p.points = Math.max(0, p.points + delta);
  p.floor = floorOf(p.points);

  const result = {
    slot: p.slot,
    id,
    timedOut,
    correct: isCorrect,
    choice,
    correctIdx: cur.correctIdx,
    delta,
    points: p.points,
    floor: p.floor,
    floorDelta: p.floor - prevFloor,
    seconds: Math.round(elapsed * 10) / 10
  };
  p.lastResult = result;
  emitToPlayerAndSpectators(p, 'result', result);
  emotesForResult(p, result, prevPoints, prevFloor);

  if (p.floor >= CFG.TARGET_FLOOR) {
    scheduleEnd(() => p.slot, 'floor');
    return;
  }
  const end = evaluateEnd();
  if (end) {
    room.endInfo = end.info || null;
    scheduleEnd(end.decide, end.reason);
    return;
  }
  broadcast();
  if (usedOf(p) < CFG.MAX_QUESTIONS) p.nextTimer = setTimeout(() => sendQuestion(p), CFG.FEEDBACK_MS);
}

// ¿Terminó la partida? (aparte de llegar al piso 7)
//  - Si los dos gastaron sus preguntas: gana quien tenga más puntos ('limit').
//  - Si solo uno terminó, el otro sigue jugando mientras todavía pueda alcanzarlo: sus puntos + 20 por cada
//    pregunta que le queda (el mejor caso). Cuando esa suma ya no le da, la partida termina ('catchup').
function evaluateEnd() {
  const [a, b] = room.players;
  const M = CFG.MAX_QUESTIONS;
  const doneA = usedOf(a) >= M;
  const doneB = usedOf(b) >= M;
  if (doneA && doneB) return { decide: decideByLimit, reason: 'limit' };
  if (!doneA && !doneB) return null;
  const fin = doneA ? a : b;
  const other = doneA ? b : a;
  const remaining = M - usedOf(other);
  const best = other.points + remaining * CFG.QUESTION_POINTS;
  if (best >= fin.points) return null; // todavía puede alcanzarlo: sigue jugando
  return {
    decide: () => fin.slot,
    reason: 'catchup',
    info: { finisher: fin.slot, other: other.slot, finisherPoints: fin.points, otherPoints: other.points, remaining, best, perQuestion: CFG.QUESTION_POINTS }
  };
}

// Gana quien tenga más puntos; si empatan, quien tenga más aciertos; si siguen iguales, empate.
function decideByLimit() {
  const [a, b] = room.players;
  const key = (p) => [p.points, p.correct];
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i] ? 0 : 1;
  return null;
}

// La partida ya está decidida: se congela (nadie más puede responder) y, tras una pausa corta para ver
// la última respuesta, se muestra al ganador. `decide` devuelve el slot ganador (o null si hay empate).
function scheduleEnd(decide, reason) {
  if (room.ending) return;
  room.ending = true;
  room.players.forEach((q) => { clearPlayerTimers(q); q.current = null; });
  broadcast();
  room.gameTimers.push(setTimeout(() => {
    if (room.phase === 'playing') finishGame(decide(), reason);
  }, CFG.END_DELAY_MS));
}

function finishGame(winnerSlot, reason) {
  room.players.forEach(clearPlayerTimers);
  room.players.forEach((p) => { p.current = null; });
  room.winner = winnerSlot;
  room.endReason = reason || 'floor';
  setPhase('finished', CFG.FINISHED_RESET_MS);
  broadcast();
  room.phaseTimer = setTimeout(() => toSelect(''), CFG.FINISHED_RESET_MS);
}

// ---------- Conexiones ----------
function findPlayerByToken(token) {
  return room.players.find((p) => p.token && p.token === token) || null;
}

function releaseSlot(p, message) {
  clearTimeout(p.graceTimer);
  p.graceTimer = null;
  p.token = null;
  p.socketId = null;
  p.connected = false;
  if (room.phase === 'select') {
    resetPlayerGameState(p);
    p.cursor = p.slot === 0 ? 1 : empleados.length;
    broadcast();
    maybeStartVs();
  } else {
    // En cualquier otra fase, se cancela la partida y se vuelve a selección.
    p.token = null;
    toSelect(message || 'Un jugador salió. Se canceló la partida.');
  }
}

io.on('connection', (socket) => {
  const sess = { token: null, slot: null };
  bySocket.set(socket.id, sess);

  socket.emit('init', {
    cfg: CFG,
    empleados,
    build: buildId(),
    serverTime: Date.now()
  });
  socket.join('spectators');
  socket.emit('state', publicState());
  if (room.phase === 'playing') {
    room.players.forEach((p) => {
      if (!p.current) return;
      const left = CFG.QUESTION_SECONDS * 1000 - (Date.now() - p.current.startedAt);
      socket.emit('question', { ...p.current.payload, ms: Math.max(500, left) });
    });
  }

  const myPlayer = () => (sess.slot === null ? null : room.players[sess.slot]);

  const becomeSpectator = () => {
    sess.slot = null;
    socket.join('spectators');
    socket.emit('role', { slot: null });
  };
  const becomePlayer = (p) => {
    sess.slot = p.slot;
    p.socketId = socket.id;
    p.connected = true;
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    socket.leave('spectators');
    socket.emit('role', { slot: p.slot });
  };

  // El cliente se identifica con un token guardado en sessionStorage
  socket.on('hello', ({ token } = {}) => {
    if (typeof token !== 'string' || token.length < 8 || token.length > 64) return;
    sess.token = token;
    const p = findPlayerByToken(token);
    if (p) {
      // Reconexión: recupera su lugar (y su pregunta actual si la tiene)
      p.socketId = socket.id;
      becomePlayer(p);
      if (room.phase === 'playing' && p.current) {
        const left = CFG.QUESTION_SECONDS * 1000 - (Date.now() - p.current.startedAt);
        socket.emit('question', { ...p.current.payload, ms: Math.max(500, left) });
      }
      broadcast();
    } else {
      socket.emit('role', { slot: null });
      socket.emit('state', publicState());
    }
  });

  socket.on('take', ({ slot } = {}) => {
    if (!sess.token || sess.slot !== null) return;
    if (slot !== 0 && slot !== 1) return;
    const p = room.players[slot];
    if (room.phase !== 'select') return socket.emit('toast', 'Hay una partida en curso: mira como espectador.');
    if (p.token) return socket.emit('toast', `El Jugador ${slot + 1} ya está ocupado.`);
    p.token = sess.token;
    becomePlayer(p);
    room.message = '';
    broadcast();
  });

  socket.on('leave', () => {
    const p = myPlayer();
    if (!p) return;
    becomeSpectator();
    releaseSlot(p, `El Jugador ${p.slot + 1} abandonó la partida.`);
  });

  socket.on('cursor', ({ index } = {}) => {
    const p = myPlayer();
    if (!p || room.phase !== 'select' || p.locked || p.randoming) return;
    if (!Number.isInteger(index) || index < 0 || index >= empleados.length + 2) return;
    p.cursor = index;
    broadcast();
  });

  socket.on('lock', ({ index } = {}) => {
    const p = myPlayer();
    if (!p || room.phase !== 'select' || p.randoming) return;
    // index = número de empleado (0..N-1)
    if (!Number.isInteger(index) || index < 0 || index >= empleados.length) return;
    if (p.locked && p.charIdx === index) return;
    if (takenByOther(p, index)) return socket.emit('toast', 'Ese empleado ya fue elegido por tu rival.');
    lockCharacter(p, index);
  });

  socket.on('unlock', () => {
    const p = myPlayer();
    if (!p || room.phase !== 'select' || !p.locked) return;
    p.locked = false;
    p.charIdx = null;
    broadcast();
    maybeStartVs();
  });

  socket.on('random', () => {
    const p = myPlayer();
    if (!p || room.phase !== 'select') return;
    startRandom(p);
  });

  socket.on('answer', ({ id, choice } = {}) => {
    const p = myPlayer();
    if (!p || room.phase !== 'playing' || !p.current) return;
    if (id !== p.current.id) return;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    resolveAnswer(p, id, choice);
  });

  socket.on('again', () => {
    const p = myPlayer();
    if (!p || room.phase !== 'finished') return;
    toSelect('');
  });

  socket.on('admin-reset', ({ key } = {}) => {
    if (key !== ADMIN_KEY) return socket.emit('toast', 'Clave incorrecta.');
    room.players.forEach((p) => {
      if (p.socketId) io.to(p.socketId).emit('role', { slot: null });
      clearTimeout(p.graceTimer);
      p.token = null; p.socketId = null; p.connected = false;
    });
    for (const s of bySocket.values()) s.slot = null;
    io.sockets.sockets.forEach((s) => s.join('spectators'));
    toSelect('La sala fue reiniciada por el administrador.');
  });

  socket.on('ping-time', (cb) => { if (typeof cb === 'function') cb(Date.now()); });

  socket.on('disconnect', () => {
    bySocket.delete(socket.id);
    const p = sess.slot === null ? null : room.players[sess.slot];
    if (!p || p.socketId !== socket.id) { broadcast(); return; }
    p.connected = false;
    p.socketId = null;
    broadcast();
    clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(
      () => releaseSlot(p, `El Jugador ${p.slot + 1} se desconectó. Se canceló la partida.`),
      CFG.RECONNECT_GRACE_MS
    );
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ascensor Vilaseca escuchando en http://localhost:${PORT}`);
  console.log(`Clave de administrador (reiniciar sala): ${ADMIN_KEY}`);
});
