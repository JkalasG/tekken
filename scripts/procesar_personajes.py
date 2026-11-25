#!/usr/bin/env python3
"""Genera los personajes del juego a partir de las imágenes de la carpeta tekken/.

  tekken/<nombre>.(jpg|jfif|png)  ->  public/fotos/<id>.png        figura con fondo transparente (1000 px de alto)
                                      public/fotos/<id>_cara.png   rostro cuadrado de 360x360 (fondo transparente)

Las imágenes de origen deben tener fondo blanco liso (como las que se generan con IA). Los archivos de salida
se toman de data/empleados.json (campos "figura" y "foto").

Uso (desde la carpeta del proyecto):
  python scripts/procesar_personajes.py            procesa solo los personajes cuya imagen en tekken/ es claramente más nueva que la de public/fotos/
                                                   (si dudas, escribe los ids: es lo más seguro)
  python scripts/procesar_personajes.py pol kevin  procesa esos ids
  python scripts/procesar_personajes.py --todos    procesa todos
  python scripts/procesar_personajes.py --web      solo regenera las imágenes livianas (WebP) de todos los personajes
  python scripts/procesar_personajes.py --bordes   solo uniforma el borde blanco de TODAS las figuras y caras que ya están en public/fotos/

Además de los PNG, deja en public/fotos/web/ tres versiones WebP muy livianas por personaje (figura, miniatura de la
lista y cara): son las que descarga el juego, así carga rápido y sin tirones. Se generan solas al procesar un personaje.

Todos los personajes quedan con el mismo borde blanco (estilo sticker): se agrega a los que no lo tienen y se
ajusta el grosor a los que ya lo tenían. Es seguro repetirlo: si el borde ya está bien, no cambia nada.

Requiere:  pip install pillow numpy opencv-python
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
ORIGEN = RAIZ / "tekken"
SALIDA = RAIZ / "public" / "fotos"
EXTENSIONES = {".jpg", ".jpeg", ".jfif", ".png"}

# Nombres de archivo que no coinciden con el id del empleado en data/empleados.json
ALIAS = {"gabi": ["gaby"], "geovis": ["giovis"], "joseluis": ["jose luis"]}

ALTO_FIGURA = 1000   # alto final de la figura (px)
LADO_CARA = 360      # lado final de la cara (px)
UMBRAL_BLANCO = 246  # un píxel con R, G y B por encima de esto cuenta como fondo
GROSOR_FIGURA = 22   # borde blanco de la figura (px, sobre 1000 de alto)
GROSOR_CARA = 14     # borde blanco de la cara (px, sobre 360)
BLANCO_BORDE = 235   # un anillo del borde cuenta como blanco si su valor mediano supera esto
WEB = SALIDA / "web"  # imágenes livianas que usa el juego
ALTO_WEB_FIGURA = 800  # alto de la figura WebP (px)
ALTO_WEB_TILE = 220    # alto de la miniatura de la lista de personajes (px)
LADO_WEB_CARA = 320    # lado de la cara WebP (px)
CALIDAD_WEBP = 82
MARGEN_S = 120       # en modo automático, la imagen de tekken/ debe ser más nueva que la de public/fotos/ por más de esto
                     # (tras clonar o descomprimir el proyecto todos los archivos tienen casi la misma fecha)


def normalizar(texto):
    t = unicodedata.normalize("NFD", texto.lower())
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in t if unicodedata.category(c) != "Mn"))


def buscar_origen(emp):
    """Archivo de tekken/ que corresponde al empleado (por id, nombre o alias). Si hay varios, el más nuevo."""
    claves = {normalizar(x) for x in [emp["id"], emp["nombre"]] + ALIAS.get(emp["id"], [])}
    candidatos = [p for p in ORIGEN.iterdir() if p.suffix.lower() in EXTENSIONES and normalizar(p.stem) in claves]
    return max(candidatos, key=lambda p: p.stat().st_mtime, default=None)


# ---------- Recorte del fondo ----------
def recortar_fondo(rgb):
    """rgb uint8 HxWx3 con fondo blanco liso -> RGBA uint8 con fondo transparente y bordes suavizados."""
    h, w = rgb.shape[:2]
    minimo = rgb.min(axis=2)

    # Fondo = zonas casi blancas conectadas con el borde de la imagen (el blanco de dentro, como camisas o brillos, se conserva)
    candidato = (minimo >= UMBRAL_BLANCO).astype(np.uint8)
    _, etiquetas = cv2.connectedComponents(candidato, connectivity=4)
    borde = np.concatenate([etiquetas[0], etiquetas[-1], etiquetas[:, 0], etiquetas[:, -1]])
    fondo = np.isin(etiquetas, np.unique(borde[borde > 0]))

    # Huecos de fondo que quedaron atrapados pegados al contorno (por ejemplo entre dos mechones de pelo): se ven por
    # estar casi blancos y a pocos píxeles del fondo exterior. Los blancos de verdad (ojos, brillos) están más adentro.
    n_c, et_c, st_c, _ = cv2.connectedComponentsWithStats(candidato, connectivity=4)
    dist = cv2.distanceTransform((~fondo).astype(np.uint8), cv2.DIST_L2, 3)   # distancia de cada píxel al fondo exterior
    cerca = 0.012 * max(h, w)
    huecos = np.zeros_like(fondo)
    for i in range(1, n_c):
        x, y, cw, ch, area = st_c[i]
        if area < 60:
            continue
        sub = et_c[y:y + ch, x:x + cw] == i
        if fondo[y:y + ch, x:x + cw][sub].any():
            continue   # ya es fondo
        if dist[y:y + ch, x:x + cw][sub].min() <= cerca:
            huecos[y:y + ch, x:x + cw] |= sub
    fondo |= huecos
    frente = ~fondo

    # El contorno que queda suelto del otro lado de un hueco eliminado es una línea fina que flota: se quita abriendo
    # la silueta, pero solo cerca de esos huecos (así no se despuntan los mechones del resto del pelo).
    if huecos.any():
        lado = int(cerca * 2.4) | 1
        elipse = lambda d: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))
        abierto = cv2.morphologyEx(frente.astype(np.uint8), cv2.MORPH_OPEN, elipse(lado)).astype(bool)
        zona = cv2.dilate(huecos.astype(np.uint8), elipse(lado * 2 + 1)).astype(bool)
        frente = np.where(zona, abierto, frente)

    # Quitar motas sueltas (ruido del JPG) que quedaron fuera del personaje
    n, et, stats, _ = cv2.connectedComponentsWithStats(frente.astype(np.uint8), connectivity=8)
    if n > 1:
        grande = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        for i in range(1, n):
            if i != grande and stats[i, cv2.CC_STAT_AREA] < 0.02 * stats[grande, cv2.CC_STAT_AREA]:
                frente[et == i] = False

    # Borde suave: junto al fondo, el píxel es una mezcla del contorno oscuro y el blanco; se estima cuánto
    # es contorno (alfa) y se le quita el blanco para que no quede un halo claro alrededor.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    banda = cv2.dilate((~frente).astype(np.uint8), k).astype(bool) & frente
    mas_oscuro = cv2.erode(minimo, k).astype(np.float32)          # contorno más oscuro cercano
    mezcla = np.clip((255.0 - minimo) / np.maximum(255.0 - mas_oscuro, 1.0), 0.0, 1.0)
    alfa = frente.astype(np.float32)
    alfa[banda] = mezcla[banda]
    color = rgb.astype(np.float32)
    a3 = np.maximum(alfa, 0.05)[..., None]
    limpio = np.clip((color - (1.0 - alfa[..., None]) * 255.0) / a3, 0, 255)
    color = np.where(banda[..., None], limpio, color)
    return np.dstack([color.astype(np.uint8), (alfa * 255).astype(np.uint8)])


def redimensionar(imagen, ancho, alto):
    """Redimensiona un RGBA sin que el color de los píxeles transparentes ensucie los bordes."""
    return imagen.convert("RGBa").resize((ancho, alto), Image.LANCZOS).convert("RGBA")


# ---------- Borde blanco (estilo sticker) ----------
def medir_borde(rgba):
    """Grosor en px del borde blanco que ya tiene la imagen (0 si no tiene).
    Se revisa anillo a anillo desde el contorno hacia adentro; el primer anillo (borde suavizado) no cuenta."""
    opaco = rgba[..., 3] > 128
    dist = cv2.distanceTransform(opaco.astype(np.uint8), cv2.DIST_L2, 3)
    minimo = rgba[..., :3].min(axis=2)
    t = 0
    for d in range(2, 80):
        anillo = opaco & (dist > d - 1) & (dist <= d)
        if anillo.sum() < 30 or np.median(minimo[anillo]) < BLANCO_BORDE:
            break
        t = d
    return t


def _agregar_borde(rgba, extra, ampliar_lienzo):
    """Rodea la figura con `extra` px más de borde blanco."""
    if ampliar_lienzo:
        ys, xs = np.where(rgba[..., 3] > 0)
        h, w = rgba.shape[:2]
        necesario = extra + 3
        arriba, abajo = max(0, necesario - ys.min()), max(0, necesario - (h - 1 - ys.max()))
        izq, der = max(0, necesario - xs.min()), max(0, necesario - (w - 1 - xs.max()))
        rgba = np.pad(rgba, ((arriba, abajo), (izq, der), (0, 0)))
    opaco = rgba[..., 3] > 128
    # Si ya tenía borde, su contorno suavizado queda gris dentro del borde nuevo: se pinta de blanco
    interior = cv2.distanceTransform(opaco.astype(np.uint8), cv2.DIST_L2, 3)
    if medir_borde(rgba) > 0:
        rim = opaco & (interior <= 1.5)
        rgba = rgba.copy()
        rgba[rim, :3] = 255
        rgba[rim, 3] = 255
    fuera = cv2.distanceTransform((~opaco).astype(np.uint8), cv2.DIST_L2, 3)   # distancia a la figura
    a_borde = np.clip(extra + 0.5 - fuera, 0.0, 1.0)                              # 1 dentro del grosor, 1 px de transición
    af = rgba[..., 3].astype(np.float32) / 255.0
    ab = a_borde * (1.0 - af)                                                     # capa blanca por debajo de la figura
    a_out = af + ab
    color = (rgba[..., :3].astype(np.float32) * af[..., None] + 255.0 * ab[..., None]) / np.maximum(a_out[..., None], 1e-4)
    return np.dstack([np.clip(color, 0, 255), a_out * 255.0]).round().astype(np.uint8)


def _quitar_borde(rgba, quitar):
    """Recorta `quitar` px del borde blanco, desde afuera."""
    opaco = rgba[..., 3] > 128
    dist = cv2.distanceTransform(opaco.astype(np.uint8), cv2.DIST_L2, 3)
    out = rgba.copy()
    out[..., 3] = (rgba[..., 3] * np.clip(dist - quitar, 0.0, 1.0)).round().astype(np.uint8)
    return out


def estandarizar_borde(rgba, grosor, ampliar_lienzo):
    """Deja la imagen con un borde blanco de `grosor` px: lo agrega si falta o lo ajusta si es más grueso/fino.
    ampliar_lienzo=True agrega margen transparente si hace falta (figuras); False mantiene el tamaño (caras)."""
    for _ in range(3):
        t = medir_borde(rgba)
        if t == grosor:
            break
        rgba = _quitar_borde(rgba, t - grosor) if t > grosor else _agregar_borde(rgba, grosor - t, ampliar_lienzo)
    return rgba


# ---------- Rostro ----------
def caja_cabeza(rgba):
    """(centro_x, arriba, mentón) de la cabeza, en píxeles de la imagen recortada.
    Arriba = parte alta del pelo; mentón = abajo de la mancha de piel más grande de la mitad superior."""
    alfa = rgba[..., 3] > 128
    ys, xs = np.where(alfa)
    arriba, alto_fig = int(ys.min()), int(ys.max() - ys.min() + 1)

    hsv = cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    piel = ((h >= 3) & (h <= 24) & (s >= 35) & (v >= 110) & alfa).astype(np.uint8)
    piel = cv2.morphologyEx(piel, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    n, et, stats, _ = cv2.connectedComponentsWithStats(piel, connectivity=8)
    mejor, area = None, 0
    for i in range(1, n):
        top = stats[i, cv2.CC_STAT_TOP]
        if top < arriba + 0.6 * alto_fig and stats[i, cv2.CC_STAT_AREA] > area:
            mejor, area = i, stats[i, cv2.CC_STAT_AREA]
    if mejor is None:  # sin piel detectada: cabeza = 40 % superior de la figura
        return (xs.min() + xs.max()) / 2, arriba, arriba + 0.4 * alto_fig

    cara = et == mejor
    filas = cara.sum(axis=1)
    ancho_max = filas.max()
    y_cara = np.where(filas >= 0.4 * ancho_max)[0]   # filas "anchas": cuello y manos finos no cuentan
    menton = int(y_cara.max())
    xs_c = np.where(cara[y_cara.min():menton + 1].any(axis=0))[0]
    return (xs_c.min() + xs_c.max()) / 2, arriba, menton


def hacer_cara(rgba):
    cx, arriba, menton = caja_cabeza(rgba)
    lado = (menton - arriba) * 1.25
    x0, y0 = int(round(cx - lado / 2)), int(round(arriba - 0.07 * lado))
    lado = int(round(lado))
    lienzo = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    lienzo.paste(Image.fromarray(rgba), (-x0, -y0))   # lo que quede fuera de la imagen queda transparente
    return redimensionar(lienzo, LADO_CARA, LADO_CARA)


def procesar(emp, origen):
    rgb = np.array(Image.open(origen).convert("RGB"))
    rgba = recortar_fondo(rgb)

    # Figura: recortada al contorno (con un pequeño margen) y escalada a 1000 px de alto
    ys, xs = np.where(rgba[..., 3] > 8)
    m = max(2, int(0.005 * (ys.max() - ys.min())))
    x0, x1 = max(0, xs.min() - m), min(rgba.shape[1], xs.max() + m + 1)
    y0, y1 = max(0, ys.min() - m), min(rgba.shape[0], ys.max() + m + 1)
    figura = Image.fromarray(rgba[y0:y1, x0:x1])
    ancho = max(1, round(figura.width * ALTO_FIGURA / figura.height))
    figura = np.array(redimensionar(figura, ancho, ALTO_FIGURA))
    Image.fromarray(estandarizar_borde(figura, GROSOR_FIGURA, True)).save(SALIDA / emp["figura"], optimize=True)

    cara = np.array(hacer_cara(rgba))
    Image.fromarray(estandarizar_borde(cara, GROSOR_CARA, False)).save(SALIDA / emp["foto"], optimize=True)
    exportar_web(emp)


def exportar_web(emp):
    """Versiones livianas (WebP con transparencia) de la figura, la miniatura de la lista y la cara."""
    WEB.mkdir(exist_ok=True)
    fig_png, cara_png = SALIDA / emp["figura"], SALIDA / emp["foto"]
    if fig_png.exists():
        fig = Image.open(fig_png).convert("RGBA")
        for sufijo, alto in (("fig", ALTO_WEB_FIGURA), ("tile", ALTO_WEB_TILE)):
            ancho = max(1, round(fig.width * alto / fig.height))
            redimensionar(fig, ancho, alto).save(WEB / f"{emp['id']}_{sufijo}.webp", "WEBP", quality=CALIDAD_WEBP, method=6)
    if cara_png.exists():
        redimensionar(Image.open(cara_png).convert("RGBA"), LADO_WEB_CARA, LADO_WEB_CARA).save(
            WEB / f"{emp['id']}_cara.webp", "WEBP", quality=CALIDAD_WEBP, method=6)


def uniformar_bordes(emp):
    """Ajusta el borde blanco de la figura y la cara que ya están en public/fotos/. Devuelve cuántos archivos cambió."""
    cambios = 0
    for campo, grosor, ampliar in (("figura", GROSOR_FIGURA, True), ("foto", GROSOR_CARA, False)):
        ruta = SALIDA / emp[campo]
        if not ruta.exists():
            continue
        antes = np.array(Image.open(ruta).convert("RGBA"))
        despues = estandarizar_borde(antes, grosor, ampliar)
        if despues.shape != antes.shape or not np.array_equal(despues, antes):
            Image.fromarray(despues).save(ruta, optimize=True)
            cambios += 1
    return cambios


def main():
    args = sys.argv[1:]
    todos = "--todos" in args
    ids = [normalizar(a) for a in args if not a.startswith("--")]
    empleados = json.loads((RAIZ / "data" / "empleados.json").read_text(encoding="utf-8"))
    if "--bordes" in args or "--web" in args:
        for emp in empleados:
            n = uniformar_bordes(emp) if "--bordes" in args else 0
            exportar_web(emp)
            print(f"{emp['nombre']:<10} {'borde ajustado · ' if n else ''}WebP listo")
        return
    hechos = 0
    for emp in empleados:
        origen = buscar_origen(emp)
        if origen is None:
            continue
        destino = SALIDA / emp["figura"]
        if ids:
            if emp["id"] not in ids and normalizar(emp["nombre"]) not in ids:
                continue
        elif not todos and destino.exists() and origen.stat().st_mtime <= destino.stat().st_mtime + MARGEN_S:
            continue
        procesar(emp, origen)
        hechos += 1
        print(f"{emp['nombre']:<10} {origen.name}  ->  {emp['figura']}, {emp['foto']}")
    if not hechos:
        print("Nada que procesar: las imágenes de public/fotos/ ya están al día. Usa --todos o escribe los ids para forzarlo.")


if __name__ == "__main__":
    main()
