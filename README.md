# Ascensor Vilaseca

**Acciones para luchar contra la corrupción, contrabando y soborno** (título de la presentación, `presentacion.pdf`).

Juego en tiempo real para la exposición. Dos jugadores eligen un empleado (estilo Tekken Tag), se enfrentan en pantalla VS y suben en ascensor hasta el piso 7 (Agencia Vilaseca S.A.) respondiendo preguntas sobre la presentación. El resto de personas entra por el mismo enlace como espectador y ve la selección y la partida en vivo. Las preguntas, el ranking y el historial de VS se guardan en una base de datos SQLite.

## Cómo correrlo

```bash
npm install
npm start            # http://localhost:3000
```

> **Después de actualizar el código hay que reiniciar el servidor** (`Ctrl+C` y otra vez `npm start`): la página se actualiza sola, pero el servidor sigue con el código anterior en memoria hasta que se reinicia. Si la página detecta un servidor desactualizado, muestra un aviso rojo arriba.

Variables opcionales: `PORT` (por defecto 3000), `MAX_QUESTIONS` (preguntas por jugador, por defecto 12), `QUESTION_SECONDS` (segundos por pregunta, por defecto 20), `ADMIN_KEY` (clave del botón ⚙ para reiniciar la sala; por defecto `vilaseca`, cámbiala en el VPS) y `DB_PATH` (archivo de la base de datos; por defecto `data/ascensor.db`).

Prueba rápida sin navegador (2 bots + 1 espectador juegan una partida completa; con el servidor ya corriendo):

```bash
npm run test:sim
```

Esa partida de prueba queda guardada en el ranking. Para dejar ranking e historial en cero antes de la exposición: `npm run limpiar -- --si`.

## Cómo se juega

1. Cada persona abre el enlace y elige **Jugador 1**, **Jugador 2** o **Solo mirar**. Un lugar ocupado ya no está disponible; el resto ve todo como espectador.
2. Selección de empleado (pantalla estilo Tekken, sin límite de tiempo): flechas o mouse para mover el cursor, `Enter` o clic para elegir. Cada uno ve en vivo el cursor del otro. Un empleado elegido (o reservado por el azar del rival) no lo puede elegir el otro.
   - **Cambiar de personaje:** haciendo clic en otro empleado, o con `Esc` / el botón "Cambiar personaje". Se puede cambiar hasta que ambos estén listos; hay una pausa de 1,5 s antes del VS.
   - **Al azar** (botón, tecla `R` o las casillas `?`): efecto tragamonedas. El cursor recorre a todos los empleados al menos una vuelta completa, va perdiendo velocidad y se detiene en uno (unos 5 s). El resultado lo decide el servidor y todos lo ven igual.
3. **Inicio de la ronda:** cuando los dos eligieron personaje, la ronda no empieza sola (todavía pueden cambiar). La inicia con el botón **▶ EMPEZAR RONDA** un **espectador** desde su pantalla o, si no hay ningún espectador mirando, el **Jugador 1**. Después vienen la pantalla VS y la cuenta regresiva 3-2-1.
4. Cada jugador recibe **preguntas distintas** (el servidor reparte el mazo entre los dos, sin repetir). Además, el servidor da prioridad a las preguntas menos usadas, así que no se repiten entre partidas hasta haber usado todo el banco (ver [Base de datos](#base-de-datos-preguntas-ranking-e-historial)).
5. Teclas `1-4` o `A-D` para responder, o clic.
6. Al terminar, el VS se guarda en el historial y suma al ranking. Se ve con el botón 🏆 de la barra superior, en el menú, o en la pantalla del ganador (también en `/#ranking` y `/#historial`).

## Reglas (se cambian en `server/index.js`, objeto `CFG`)

| Regla | Valor actual |
|---|---|
| Piso inicial / meta | 1 → 7 |
| Valor de una pregunta | 20 puntos como máximo |
| Subir un piso | cada 20 puntos |
| Descuento por tiempo | puntos completos si responde en 5 s; luego −1 punto por segundo (mínimo 5) |
| Respuesta incorrecta | −5 puntos (no baja de 0; puede bajar de piso) |
| Tiempo por pregunta | 20 s; si se acaba, aparece otra pregunta sin penalización |
| Máximo de preguntas | 12 por jugador (las que se agotan por tiempo también cuentan) |
| Fin | Gana el primero en llegar al piso 7. Si alguien gasta sus 12 preguntas, el otro sigue jugando **mientras todavía pueda alcanzarlo**: sus puntos + 20 por cada pregunta que le queda (el mejor caso) tiene que ser igual o mayor que los puntos del que terminó. Cuando esa suma ya no le da, la partida termina y la pantalla final lo explica (ej.: "tenía 30 pts y le quedaban 3 preguntas (máx. +60 = 90 pts), menos que los 100 pts de Pol"). Si los dos gastan sus 12, gana quien tenga más puntos; si empatan, más aciertos; si siguen iguales, empate. Se muestra el personaje ganador con trofeo y confeti; 25 s después vuelve a la selección |

Con estas reglas, para llegar al piso 7 hacen falta 120 puntos (6 aciertos rápidos como mínimo).

### Ascensor y reacciones

- La cabina sube **de forma continua con cada punto** (no solo al completar un piso): 5 o 10 puntos mueven la cabina media piso o un cuarto. El hueco tiene marcas cada 10 puntos, una estela del color del jugador y los puntos escritos junto a la cabina y en cada piso (0, 20, 40… 120 pts). La altura del ascensor se ajusta al alto de la pantalla (variable CSS `--row`).
- **Emoticones en burbuja** (sobre la cabina y junto al retrato del jugador; los decide el servidor, así que todos ven lo mismo). Se editan en la tabla `EMOTES` de `server/index.js`:

| Evento | Emoticón |
|---|---|
| Empieza la partida | 💪 😤 🤞 |
| Acierto rápido (3 s o menos) | ⚡ 😉 👌 |
| Sube de piso | 🎉 🙌 🆙 |
| Racha de 2 / 3 / 4 / 5 / 6+ aciertos | 😄 / 😎 🤩 / 🔥 🥳 / 🚀 🤯 / 👑 🏆 🦸 (más grandes mientras sube la racha) |
| 1 error / 2 seguidos | 🙈 😳 😅 / 😬 😰 🥴 |
| 3 o más errores seguidos | 😭 😢 (sonido triste) |
| Baja de piso | 😱 📉 😵 |
| Se acaba el tiempo | 🥱 😴 ⏰ |
| 10 s sin responder | 🤔 🧐 |
| El rival lo pasa en puntos | 😤 😠 😒 |
| El rival está a un piso de ganar | 😰 😨 |

El panel de cada jugador muestra también su racha (🔥 racha ×N).

## Base de datos: preguntas, ranking e historial

Todo vive en un solo archivo SQLite, `data/ascensor.db` (se crea solo al primer arranque; no se sube a git). Se puede abrir con cualquier visor de SQLite (por ejemplo DB Browser for SQLite).

| Tabla | Contenido |
|---|---|
| `preguntas` | El banco de preguntas: `tema`, `texto`, `opcion_a` a `opcion_d`, `correcta` (0=A, 1=B, 2=C, 3=D), `activa` (0 la saca del juego sin borrarla) y `veces_usada`. |
| `empleados` | Los personajes con su nombre, cargo y color (copiados de `data/empleados.json`). |
| `partidas` | Una fila por cada VS terminado: fecha, duración, motivo del final, ganador (vacío = empate). |
| `partida_jugadores` | Los dos jugadores de cada partida: `empleado_id` y `nombre` (el empleado elegido), puntos, piso, aciertos, errores, preguntas sin responder y resultado (`gano`, `perdio`, `empato`). |

- **Preguntas:** hoy hay **121**, sobre la presentación (conceptos, acciones contra la corrupción, el soborno y el contrabando, marco legal de Bolivia, compromisos, canales de denuncia y casos prácticos). Cada partida usa como máximo 24 (12 por jugador), así que alcanzan para varias partidas sin repetir: el servidor reparte primero las menos usadas (`veces_usada`) y solo repite cuando todas se usaron el mismo número de veces.
- **Ranking:** cada empleado es una persona. Se calcula desde `partida_jugadores` y el nombre sale de la tabla `empleados`, que se copia de `data/empleados.json` en cada arranque. Más victorias primero; desempata menos derrotas y luego más puntos.
- **Historial:** las últimas 50 partidas con ambos empleados, puntos, piso, ganador y motivo. Las partidas canceladas (un jugador se fue) no se guardan.
- **API de solo lectura:** `GET /api/ranking` y `GET /api/historial?limit=50`.

Comandos:

```bash
npm run seed                 # agrega a la base las preguntas nuevas de data/preguntas.json (no toca las existentes)
npm run limpiar -- --si      # borra ranking e historial y pone veces_usada en 0 (no borra preguntas)
```

## Sonido y música

Todo se genera en el navegador (no hay archivos de audio). Botones de la barra superior: **🔊** apaga o enciende todo el sonido y **🎵** solo la música de fondo (se recuerda en cada navegador). Los navegadores solo dejan sonar después del primer clic o tecla.

- **Música de fondo:** suave, con acordes y un arpegio lento. Más tranquila al elegir personaje y en el VS, un poco más activa mientras se juega, y se apaga en la pantalla del ganador. Se ajusta con `MUSIC_VOL` al inicio de la sección de sonido de `public/app.js` (por defecto 0.6).
- **Efectos:** pantalla VS (viento y golpe grave), cuenta regresiva y ¡YA!, campanita cuando aparece tu pregunta, toque al elegir una respuesta, tic-tac en los últimos 5 segundos (más agudo en los últimos 3), acierto, error, tiempo agotado, subir de piso, rachas, y fanfarria del ganador (melodía triste para quien pierde).
- Los espectadores oyen los efectos de los dos jugadores, pero el tic-tac solo lo oye quien está jugando.

La pregunta y sus 4 respuestas siempre se ven completas sin bajar la página: el tamaño de la letra se calcula con la altura de la pantalla y, si el texto es muy largo, se reduce solo lo necesario. En el celular tu panel con la pregunta queda arriba y el edificio debajo.

## Personalizar contenido

- **Preguntas:** se leen de la base de datos. Para agregar o cambiar, hay dos caminos: (1) editar `data/preguntas.json` y correr `npm run seed` (formato `{ "t": "tema", "q": "pregunta", "o": ["op A","op B","op C","op D"], "c": 0 }`, donde `c` es el índice de la correcta; las opciones se barajan al mostrarlas; las que ya existen se comparan por texto y no se modifican), o (2) editar la tabla `preguntas` directamente con un visor de SQLite. Con menos de 24 preguntas activas se repetirían dentro de una misma partida (el servidor avisa al arrancar).
- **Empleados:** `data/empleados.json` (nombre, cargo, color, emoji). Para usar fotos, copia la imagen a `public/fotos/` y agrega `"foto": "archivo.jpg"` al empleado (cuadrada, se recorta en círculo). Se pueden poner más o menos de 12.
- **Personajes (imágenes):** las imágenes originales están en `tekken/` (chibi con fondo blanco liso). Si cambias alguna, regenera el personaje (figura recortada + cara) con:

  ```bash
  pip install pillow numpy opencv-python      # solo la primera vez
  python scripts/procesar_personajes.py pol kevin    # los ids que cambiaste (usa --todos para todos)
  ```

  Todos los personajes llevan el mismo **borde blanco** (estilo sticker): el script lo agrega a los que no lo tienen y ajusta el grosor a los que ya lo traían. Con `python scripts/procesar_personajes.py --bordes` se uniforma el borde de todas las figuras y caras que ya están en `public/fotos/` (es seguro repetirlo).

  El archivo puede llamarse como el id o el nombre del empleado (`gaby.jpg` y `giovis.jpg` también valen para Gabi y Geovis). Guarda `public/fotos/<id>.png` y `<id>_cara.png`, que es lo que usa el juego. La carpeta `tekken2/` guarda las versiones anteriores y no se usa.

## Desplegar con Docker (recomendado)

Requiere Docker con Compose v2 (`docker compose`) en el servidor. Archivos: `Dockerfile`, `docker-compose.yml`, `.dockerignore` y `.env.example`.

```bash
# 1) Copia el proyecto al servidor (git clone, scp, etc.) y entra a la carpeta
cp .env.example .env          # 2) edita .env: pon tu ADMIN_KEY (obligatoria) y, si quieres, el puerto
docker compose up -d --build  # 3) construye y arranca
```

El juego queda en `http://IP-DEL-SERVIDOR:3000` (o el `HOST_PORT` que pongas). Si lo publicas detrás de Nginx en el mismo servidor, pon `BIND_ADDR=127.0.0.1` en `.env` y usa el bloque de Nginx de más abajo (pasa los WebSockets).

- **Datos:** la base de datos (preguntas, ranking e historial) vive en el volumen `ascensor-data`, no dentro de la imagen: sobrevive a reinicios y actualizaciones. El contenedor corre con un usuario sin privilegios y se reinicia solo (`restart: unless-stopped`). `docker compose ps` muestra si está `healthy`.
- **Logs:** `docker compose logs -f`
- **Actualizar** (después de cambiar el código o las preguntas): `docker compose up -d --build`. Si agregaste preguntas a `data/preguntas.json`: `docker compose exec ascensor node scripts/seed-preguntas.js`.
- **Empezar limpio** (borra ranking e historial, no las preguntas): `docker compose exec ascensor node scripts/limpiar-historial.js --si`
- **Respaldo del ranking:**
  ```bash
  docker compose exec ascensor node -e "require('better-sqlite3')('/data/ascensor.db').backup('/data/respaldo.db').then(()=>console.log('listo'))"
  docker compose cp ascensor:/data/respaldo.db ./respaldo.db
  ```
- **Restaurar un respaldo** (con `respaldo.db` en la carpeta actual):
  ```bash
  docker compose stop
  docker compose run --rm --no-deps -v "$(pwd):/respaldo:ro" --entrypoint sh ascensor -c "rm -f /data/ascensor.db-wal /data/ascensor.db-shm && cp /respaldo/respaldo.db /data/ascensor.db"
  docker compose up -d
  ```
- **Borrar todo, incluida la base:** `docker compose down -v` (sin `-v` se conservan los datos).

## Fluidez

- **Imágenes livianas:** el juego descarga versiones WebP de los personajes (`public/fotos/web/`, 1 MB en total en vez de 12.6 MB de PNG) y las precarga en segundo plano. Se generan solas al procesar un personaje; para regenerarlas todas: `python scripts/procesar_personajes.py --web`.
- **Caché y compresión:** el servidor comprime JS, CSS y JSON, y las imágenes y fuentes se guardan un año en el navegador (cada imagen se pide con su versión, así que si cambia, se vuelve a bajar). La segunda visita casi no descarga nada.
- **Sin internet:** las fuentes (Bebas Neue y Rajdhani) están en `public/fonts/`, no se piden a Google.
- **Efectos ligeros:** la pantalla VS, la cuenta regresiva y el confeti están hechos para correr bien también en equipos modestos.

## Desplegar en el VPS sin Docker (PM2)

```bash
npm install --omit=dev
PORT=3000 ADMIN_KEY=tu_clave pm2 start server/index.js --name ascensor
```

Si usas Nginx como proxy, deja pasar WebSockets:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

`better-sqlite3` es un módulo nativo: en Linux `npm install` suele descargar el binario ya compilado; si no hay uno para tu sistema, necesita `python3`, `make` y `g++` para compilarlo. Haz copia de seguridad de `data/ascensor.db` (ahí está el ranking) y no lo borres al actualizar el código.

Hay una sola sala: una partida a la vez (2 jugadores + espectadores ilimitados). Si un jugador se desconecta, tiene 15 s para volver (recarga la página) antes de cancelar la partida. El estado de la partida en curso vive en memoria: reiniciar el servidor la borra (el ranking, el historial y las preguntas no se pierden, están en la base de datos).
