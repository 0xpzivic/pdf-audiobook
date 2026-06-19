#!/usr/bin/env python3
"""Generate PWA icons (PNG) using only the Python standard library.
Draws a speaker + sound waves glyph on an indigo background (maskable-safe)."""
import struct, zlib, math

BG = (91, 91, 214)      # indigo #5b5bd6
FG = (255, 255, 255)    # white

def new_buf(w, h):
    return [[BG[:] for _ in range(w)] for _ in range(h)]

def blend(buf, x, y, color, a, w, h):
    if x < 0 or y < 0 or x >= w or y >= h or a <= 0:
        return
    r0, g0, b0 = buf[y][x]
    r1, g1, b1 = color
    buf[y][x] = (
        int(r0 + (r1 - r0) * a),
        int(g0 + (g1 - g0) * a),
        int(b0 + (b1 - b0) * a),
    )

def stamp(buf, cx, cy, r, color, w, h, alpha=1.0):
    r2 = r * r
    x0, x1 = int(cx - r - 1), int(cx + r + 1)
    y0, y1 = int(cy - r - 1), int(cy + r + 1)
    for y in range(max(0, y0), min(h, y1 + 1)):
        for x in range(max(0, x0), min(w, x1 + 1)):
            dx, dy = x - cx, y - cy
            d2 = dx * dx + dy * dy
            if d2 <= r2:
                d = math.sqrt(d2)
                a = alpha * max(0.0, min(1.0, (r - d) + 0.5))
                blend(buf, x, y, color, a, w, h)

def fill_poly(buf, pts, color, w, h):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    minx, maxx = int(min(xs)), int(max(xs))
    miny, maxy = int(min(ys)), int(max(ys))
    for y in range(max(0, miny), min(h, maxy + 1)):
        for x in range(max(0, minx), min(w, maxx + 1)):
            inside = False
            j = len(pts) - 1
            for i in range(len(pts)):
                xi, yi = pts[i]; xj, yj = pts[j]
                if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi):
                    inside = not inside
                j = i
            if inside:
                blend(buf, x, y, color, 1.0, w, h)

def thick_arc(buf, cx, cy, radius, a0, a1, thick, color, w, h):
    steps = int((a1 - a0) * radius * 2) + 2
    for i in range(steps + 1):
        t = i / steps
        a = a0 + (a1 - a0) * t
        x = cx + radius * math.cos(a)
        y = cy + radius * math.sin(a)
        stamp(buf, x, y, thick / 2.0, color, w, h)

def draw_speaker(buf, w, h):
    s = w / 512.0
    cx = cy = w / 2.0
    body = [(196 * s, 224 * s), (256 * s, 224 * s), (256 * s, 288 * s), (196 * s, 288 * s)]
    fill_poly(buf, body, FG, w, h)
    cone = [(256 * s, 224 * s), (322 * s, 188 * s), (322 * s, 324 * s), (256 * s, 288 * s)]
    fill_poly(buf, cone, FG, w, h)
    for (px, py) in body + cone:
        stamp(buf, px, py, 3 * s, FG, w, h, 0.6)
    thick_arc(buf, cx, cy, 104 * s, -0.55, 0.55, 18 * s, FG, w, h)
    thick_arc(buf, cx, cy, 150 * s, -0.45, 0.45, 18 * s, FG, w, h)

def write_png(buf, w, h, path):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b = buf[y][x]
            raw += bytes((r, g, b))
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
        return c
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, len(png), "bytes")

def main():
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
        buf = new_buf(size, size)
        draw_speaker(buf, size, size)
        write_png(buf, size, size, name)

if __name__ == "__main__":
    main()
