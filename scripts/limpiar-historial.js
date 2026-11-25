// Borra el ranking y el historial de VS, y pone en cero el contador de uso de las preguntas.
// NO borra las preguntas. Sirve para empezar limpio antes de la exposición (por ejemplo, tras probar con la simulación).
// Uso: npm run limpiar -- --si
const { clearStats, getRanking, DB_PATH } = require('../server/db');

if (!process.argv.includes('--si')) {
  const { total } = getRanking();
  console.log(`Base de datos: ${DB_PATH}`);
  console.log(`Esto borraría ${total} partida(s) del historial y todo el ranking. No se puede deshacer.`);
  console.log('Para confirmar ejecuta: npm run limpiar -- --si');
  process.exit(0);
}
const borradas = clearStats();
console.log(`Listo: se borraron ${borradas} partida(s) y el contador de uso de las preguntas volvió a cero.`);
