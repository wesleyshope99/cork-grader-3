"""Generate simple placeholder PNG icons for the PWA without any external deps.
Draws an orange disk on a dark background. Pure stdlib (zlib + struct).
Run: python scripts/make_icons.py
"""
import struct
import zlib
import os

BG = (26, 26, 28)        # near-black background
DISK = (232, 137, 43)    # orange -- distinct from v1 (cork-tan) and v2 (teal)
RING = (128, 72, 20)     # darker ring for a bit of depth
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def make_png(path, size):
    radius = size * 0.36
    ring_r = size * 0.40
    cx = cy = size / 2

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter type 0 (none) for this scanline
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            d = (dx * dx + dy * dy) ** 0.5
            if d <= radius:
                r, g, b = DISK
            elif d <= ring_r:
                r, g, b = RING
            else:
                r, g, b = BG
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size}, {len(png)} bytes)")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    make_png(os.path.join(OUT_DIR, "icon-192.png"), 192)
    make_png(os.path.join(OUT_DIR, "icon-512.png"), 512)
    make_png(os.path.join(OUT_DIR, "apple-touch-icon.png"), 180)
