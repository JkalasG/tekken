// Agrega a la base de datos las preguntas de data/preguntas.json que todavía no estén (compara por texto).
// No borra ni modifica las que ya existen. Uso: npm run seed
const { seedQuestions, initialSeeded, countQuestions, countActiveQuestions, DB_PATH } = require('../server/db');

const agregadas = initialSeeded + seedQuestions(); // initialSeeded: las que se cargaron al crear la base por primera vez
console.log(`Base de datos: ${DB_PATH}`);
console.log(`Preguntas nuevas agregadas: ${agregadas}`);
console.log(`Total en la base: ${countQuestions()} (activas: ${countActiveQuestions()})`);
