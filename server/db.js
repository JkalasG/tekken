'use strict';
/**
 * Base de datos SQLite del juego (better-sqlite3, archivo data/ascensor.db).
 *
 *  preguntas          banco de preguntas. Se carga desde data/preguntas.json la primera vez
 *                     (o con `npm run seed`). `veces_usada` hace que se muestren primero las
 *                     menos usadas, así no se repiten hasta agotar todo el banco.
 *  partidas           una fila por cada VS terminado (historial).
 *  empleados          los personajes (con su nombre), copiados de data/empleados.json al arrancar.
 *  partida_jugadores  los dos jugadores de cada partida (empleado elegido, puntos, aciertos...). El ranking se calcula desde aquí.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ascensor.db');
const SEED_PATH = path.join(__dirname, '..', 'data', 'preguntas.json');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS preguntas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tema        TEXT    NOT NULL DEFAULT 'General',
  texto       TEXT    NOT NULL UNIQUE,
  opcion_a    TEXT    NOT NULL,
  opcion_b    TEXT    NOT NULL,
  opcion_c    TEXT    NOT NULL,
  opcion_d    TEXT    NOT NULL,
  correcta    INTEGER NOT NULL CHECK (correcta BETWEEN 0 AND 3),  -- 0=A 1=B 2=C 3=D
  activa      INTEGER NOT NULL DEFAULT 1,                         -- 0 = no se usa en el juego
  veces_usada INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS empleados (
  id     TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  cargo  TEXT,
  color  TEXT
);

CREATE TABLE IF NOT EXISTS partidas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  jugada_en     TEXT    NOT NULL,                 -- fecha y hora ISO (UTC)
  duracion_s    INTEGER NOT NULL,
  motivo        TEXT    NOT NULL,                 -- floor = llegó al piso meta | limit = se acabaron las preguntas | catchup = el rival ya no podía alcanzarlo
  ganador_slot  INTEGER CHECK (ganador_slot IN (0, 1)),  -- NULL = empate
  max_preguntas INTEGER NOT NULL,
  piso_meta     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS partida_jugadores (
  partida_id  INTEGER NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  slot        INTEGER NOT NULL CHECK (slot IN (0, 1)),
  empleado_id TEXT    NOT NULL,                 -- empleado elegido (ver tabla empleados)
  nombre      TEXT    NOT NULL,                 -- su nombre en el momento de la partida
  puntos      INTEGER NOT NULL,
  piso        INTEGER NOT NULL,
  aciertos    INTEGER NOT NULL,
  errores     INTEGER NOT NULL,
  agotadas    INTEGER NOT NULL,                   -- preguntas que se quedó sin responder (se acabó el tiempo)
  resultado   TEXT    NOT NULL CHECK (resultado IN ('gano', 'perdio', 'empato')),
  PRIMARY KEY (partida_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_pj_empleado ON partida_jugadores (empleado_id);
`);

// Los empleados (personajes) se copian a la base en cada arranque: así sus nombres quedan guardados junto al ranking.
const EMPLEADOS_PATH = path.join(__dirname, '..', 'data', 'empleados.json');
const upsertEmployee = db.prepare(
  `INSERT INTO empleados (id, nombre, cargo, color) VALUES (?, ?, ?, ?)
   ON CONFLICT (id) DO UPDATE SET nombre = excluded.nombre, cargo = excluded.cargo, color = excluded.color`
);
function syncEmployees() {
  const lista = JSON.parse(fs.readFileSync(EMPLEADOS_PATH, 'utf8'));
  db.transaction(() => { for (const e of lista) upsertEmployee.run(e.id, e.nombre, e.cargo || null, e.color || null); })();
  return lista.length;
}
syncEmployees();

// ---------- Preguntas ----------

function validarPregunta(p, i) {
  const err = (m) => { throw new Error(`preguntas.json, pregunta #${i + 1}: ${m}`); };
  if (!p || typeof p.q !== 'string' || !p.q.trim()) err('falta el texto "q"');
  if (!Array.isArray(p.o) || p.o.length !== 4 || p.o.some((o) => typeof o !== 'string' || !o.trim())) err('"o" debe tener exactamente 4 opciones con texto');
  if (new Set(p.o.map((o) => o.trim())).size !== 4) err('hay opciones repetidas');
  if (!Number.isInteger(p.c) || p.c < 0 || p.c > 3) err('"c" debe ser 0, 1, 2 o 3');
}

const insertQuestion = db.prepare(
  `INSERT OR IGNORE INTO preguntas (tema, texto, opcion_a, opcion_b, opcion_c, opcion_d, correcta)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

/** Agrega a la base las preguntas de data/preguntas.json que todavía no estén (compara por texto). Devuelve cuántas agregó. */
function seedQuestions() {
  const items = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  items.forEach(validarPregunta);
  let added = 0;
  db.transaction(() => {
    for (const p of items) {
      added += insertQuestion.run(p.t || 'General', p.q.trim(), p.o[0].trim(), p.o[1].trim(), p.o[2].trim(), p.o[3].trim(), p.c).changes;
    }
  })();
  return added;
}

const countStmt = db.prepare('SELECT COUNT(*) AS n FROM preguntas');
const countActiveStmt = db.prepare('SELECT COUNT(*) AS n FROM preguntas WHERE activa = 1');
const countQuestions = () => countStmt.get().n;
const countActiveQuestions = () => countActiveStmt.get().n;

// Primera vez (tabla vacía): se carga el banco inicial.
const initialSeeded = countQuestions() === 0 ? seedQuestions() : 0;

const loadStmt = db.prepare(
  `SELECT id, tema, texto, opcion_a, opcion_b, opcion_c, opcion_d, correcta
     FROM preguntas WHERE activa = 1
    ORDER BY veces_usada ASC, RANDOM()`
);

/** Preguntas activas, las menos usadas primero (empates al azar), listas para repartir en una partida. */
function loadQuestionsForGame() {
  return loadStmt.all().map((r) => ({
    id: r.id,
    tema: r.tema,
    q: r.texto,
    o: [r.opcion_a, r.opcion_b, r.opcion_c, r.opcion_d],
    c: r.correcta
  }));
}

const usedStmt = db.prepare('UPDATE preguntas SET veces_usada = veces_usada + 1 WHERE id = ?');
const markQuestionUsed = (id) => usedStmt.run(id);

// ---------- Historial y ranking ----------

const insertMatch = db.prepare(
  `INSERT INTO partidas (jugada_en, duracion_s, motivo, ganador_slot, max_preguntas, piso_meta)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const insertPlayer = db.prepare(
  `INSERT INTO partida_jugadores (partida_id, slot, empleado_id, nombre, puntos, piso, aciertos, errores, agotadas, resultado)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * Guarda un VS terminado.
 * m = { durationS, reason, winner (0|1|null), maxQuestions, targetFloor,
 *       players: [{ slot, empId, name, points, floor, correct, wrong, timeouts }] }
 */
const saveMatch = db.transaction((m) => {
  const id = insertMatch.run(new Date().toISOString(), m.durationS, m.reason, m.winner, m.maxQuestions, m.targetFloor).lastInsertRowid;
  for (const p of m.players) {
    const resultado = m.winner === null ? 'empato' : (m.winner === p.slot ? 'gano' : 'perdio');
    insertPlayer.run(id, p.slot, p.empId, p.name, p.points, p.floor, p.correct, p.wrong, p.timeouts, resultado);
  }
  return Number(id);
});

// Ranking por empleado (cada empleado es una persona). El nombre sale de la tabla empleados; si el empleado ya no
// existe en data/empleados.json se usa el nombre guardado en la partida.
const rankingStmt = db.prepare(
  `SELECT pj.empleado_id                    AS empleadoId,
          COALESCE(e.nombre, MAX(pj.nombre)) AS nombre,
          COUNT(*)                           AS partidas,
          SUM(pj.resultado = 'gano')         AS victorias,
          SUM(pj.resultado = 'perdio')       AS derrotas,
          SUM(pj.resultado = 'empato')       AS empates,
          SUM(pj.puntos)                     AS puntos,
          SUM(pj.aciertos)                   AS aciertos,
          SUM(pj.errores)                    AS errores
     FROM partida_jugadores pj
     LEFT JOIN empleados e ON e.id = pj.empleado_id
    GROUP BY pj.empleado_id
    ORDER BY victorias DESC, derrotas ASC, puntos DESC, nombre ASC`
);
const totalStmt = db.prepare('SELECT COUNT(*) AS n FROM partidas');

/** Ranking: más victorias primero; desempata menos derrotas y luego más puntos. */
function getRanking() {
  return { total: totalStmt.get().n, ranking: rankingStmt.all() };
}

const historyStmt = db.prepare(
  `SELECT p.id, p.jugada_en AS jugadaEn, p.duracion_s AS duracionS, p.motivo, p.ganador_slot AS ganador,
          pj.slot, pj.empleado_id AS empleadoId, COALESCE(e.nombre, pj.nombre) AS nombre, pj.puntos, pj.piso, pj.aciertos, pj.errores, pj.agotadas, pj.resultado
     FROM (SELECT * FROM partidas ORDER BY id DESC LIMIT ?) p
     JOIN partida_jugadores pj ON pj.partida_id = p.id
     LEFT JOIN empleados e ON e.id = pj.empleado_id
    ORDER BY p.id DESC, pj.slot ASC`
);

/** Últimas partidas (la más reciente primero), cada una con sus dos jugadores. */
function getHistory(limit = 50) {
  const out = [];
  const byId = new Map();
  for (const r of historyStmt.all(limit)) {
    let m = byId.get(r.id);
    if (!m) {
      m = { id: r.id, jugadaEn: r.jugadaEn, duracionS: r.duracionS, motivo: r.motivo, ganador: r.ganador, jugadores: [] };
      byId.set(r.id, m);
      out.push(m);
    }
    m.jugadores.push({
      slot: r.slot, empleadoId: r.empleadoId, nombre: r.nombre, puntos: r.puntos, piso: r.piso,
      aciertos: r.aciertos, errores: r.errores, agotadas: r.agotadas, resultado: r.resultado
    });
  }
  return out;
}

/** Borra ranking e historial y pone en cero el contador de uso de las preguntas (no borra las preguntas). */
const clearStats = db.transaction(() => {
  const partidas = totalStmt.get().n;
  db.exec('DELETE FROM partida_jugadores; DELETE FROM partidas; UPDATE preguntas SET veces_usada = 0;');
  return partidas;
});

module.exports = {
  DB_PATH, db, initialSeeded,
  syncEmployees, seedQuestions, countQuestions, countActiveQuestions, loadQuestionsForGame, markQuestionUsed,
  saveMatch, getRanking, getHistory, clearStats
};
