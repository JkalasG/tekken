# Ascensor Vilaseca

Juego en tiempo real para la exposición. Dos jugadores eligen un empleado (estilo Tekken Tag), se enfrentan en pantalla VS y suben en ascensor hasta el piso 7 (Agencia Vilaseca S.A.) respondiendo preguntas. El resto de personas entra por el mismo enlace como espectador y ve la selección y la partida en vivo.

## Cómo correrlo

```bash
npm install
npm start            # http://localhost:3000
```

Variables opcionales: `PORT` (por defecto 3000) y `ADMIN_KEY` (clave del botón ⚙ para reiniciar la sala; por defecto `vilaseca`, cámbiala en el VPS).

Prueba rápida sin navegador (2 bots + 1 espectador juegan una partida completa):

```bash
node scripts/simulacion.js http://127.0.0.1:3000
```

## Cómo se juega

1. Cada persona abre el enlace y elige **Jugador 1**, **Jugador 2** o **Solo mirar**. Un lugar ocupado ya no está disponible; el resto ve todo como espectador.
2. Selección de empleado (pantalla estilo Tekken, sin límite de tiempo): flechas o mouse para mover el cursor, `Enter` o clic para elegir. Cada uno ve en vivo el cursor del otro. Un empleado elegido (o reservado por el azar del rival) no lo puede elegir el otro.
   - **Cambiar de personaje:** haciendo clic en otro empleado, o con `Esc` / el botón "Cambiar personaje". Se puede cambiar hasta que ambos estén listos; hay una pausa de 1,5 s antes del VS.
   - **Al azar** (botón, tecla `R` o las casillas `?`): efecto tragamonedas. El cursor recorre a todos los empleados al menos una vuelta completa, va perdiendo velocidad y se detiene en uno (unos 5 s). El resultado lo decide el servidor y todos lo ven igual.
3. Pantalla VS, cuenta regresiva 3-2-1 y empieza el juego.
4. Cada jugador recibe **preguntas distintas** (el servidor reparte el mazo entre los dos, sin repetir).
5. Teclas `1-4` o `A-D` para responder, o clic.

## Reglas (se cambian en `server/index.js`, objeto `CFG`)

| Regla | Valor actual |
|---|---|
| Piso inicial / meta | 1 → 7 |
| Valor de una pregunta | 20 puntos como máximo |
| Subir un piso | cada 20 puntos |
| Descuento por tiempo | puntos completos si responde en 5 s; luego −1 punto por segundo (mínimo 5) |
| Respuesta incorrecta | −5 puntos (no baja de 0; puede bajar de piso) |
| Tiempo por pregunta | 20 s; si se acaba, aparece otra pregunta sin penalización |
| Fin | gana el primero en llegar al piso 7; 25 s después vuelve a la selección |

Con estas reglas, para llegar al piso 7 hacen falta 120 puntos (6 aciertos rápidos como mínimo).

## Personalizar contenido

- **Preguntas:** `data/preguntas.json`. Formato `{ "q": "pregunta", "o": ["op A","op B","op C","op D"], "c": 0 }` donde `c` es el índice de la correcta (las opciones se barajan al mostrarlas). Hoy hay 38 de ejemplo sobre análisis de sistemas y procesos; reemplázalas por las de tu exposición. Mientras más haya, menos se repiten.
- **Empleados:** `data/empleados.json` (nombre, cargo, color, emoji). Para usar fotos, copia la imagen a `public/fotos/` y agrega `"foto": "archivo.jpg"` al empleado (cuadrada, se recorta en círculo). Se pueden poner más o menos de 12.

## Desplegar en el VPS

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

Hay una sola sala: una partida a la vez (2 jugadores + espectadores ilimitados). Si un jugador se desconecta, tiene 15 s para volver (recarga la página) antes de cancelar la partida. El estado vive en memoria: reiniciar el servidor borra la partida en curso.
