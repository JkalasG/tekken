// Simulación de una partida completa con 2 bots + 1 espectador que inicia la ronda (prueba de humo).
// Uso: node scripts/simulacion.js [url]
// Los bots toman las respuestas correctas de data/preguntas.json.
const { io } = require('socket.io-client');
const preguntas = require('../data/preguntas.json');
const url = process.argv[2] || 'http://localhost:3000';
const correctOf = new Map(preguntas.map((p) => [p.q, p.o[p.c]]));

function bot(slot, accuracy) {
  return new Promise((resolve) => {
    const s = io(url, { transports: ['websocket'] });
    const log = (...a) => console.log(`[J${slot + 1}]`, ...a);
    let state = null;
    s.on('connect', () => { s.emit('hello', { token: `bot-token-${slot}-${Date.now()}` }); setTimeout(() => s.emit('take', { slot }), 200); });
    s.on('role', ({ slot: r }) => { if (r === slot) setTimeout(() => (slot === 0 ? s.emit('random') : s.emit('lock', { index: 3 })), 400); });
    s.on('state', (st) => {
      state = st;
      if (st.phase === 'finished') { log('FIN. ganador:', st.winner + 1, st.players.map((p) => `${p.points}pts/piso${p.floor}`).join(' | ')); s.close(); resolve(st); }
    });
    s.on('question', (q) => {
      if (q.slot !== slot) return;
      const right = q.options.indexOf(correctOf.get(q.text));
      const choice = Math.random() < accuracy ? right : (right + 1) % 4;
      setTimeout(() => s.emit('answer', { id: q.id, choice }), 150 + Math.random() * 300);
    });
    s.on('result', (r) => { if (r.slot === slot) log(`${r.correct ? 'OK ' : r.timedOut ? 'T/O' : 'MAL'} delta=${r.delta} pts=${r.points} piso=${r.floor}`); });
  });
}

(async () => {
  const spec = io(url, { transports: ['websocket'] });
  let phases = [];
  spec.on('connect', () => spec.emit('watch')); // entra a mirar: es quien inicia la ronda
  spec.on('state', (st) => {
    if (phases[phases.length - 1] !== st.phase) { phases.push(st.phase); console.log('[ESP] fase ->', st.phase); }
    if (st.ready) spec.emit('start'); // los dos bots ya eligieron personaje
  });
  const seen = new Set();
  spec.on('question', (q) => seen.add(`${q.slot}:${q.text}`));
  const [a, b] = await Promise.all([bot(0, 0.9), bot(1, 0.6)]);
  const s0 = [...seen].filter((x) => x.startsWith('0:')).map((x) => x.slice(2));
  const s1 = new Set([...seen].filter((x) => x.startsWith('1:')).map((x) => x.slice(2)));
  const overlap = s0.filter((t) => s1.has(t));
  console.log('Preguntas repetidas entre jugadores:', overlap.length);
  console.log('Fases vistas por el espectador:', phases.join(' > '));
  console.log('Aviso: esta partida de prueba quedó guardada en el ranking e historial. Para dejarlos en cero: npm run limpiar -- --si');
  spec.close();
  process.exit(0);
})();
