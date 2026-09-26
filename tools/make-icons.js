// Draws the Cache Sentry icon at every size Chrome asks for, so the PNGs in
// icons/ are reproducible instead of hand-drawn. Run: node tools/make-icons.js
//
// The mark: an amber shield (the sentry) over a dark tile, with three bars
// inside it standing for a shared cache. It has to stay readable at 16px.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const NAVY = [18, 21, 28];
const AMBER = [217, 142, 48];

// --- minimal PNG writer -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter type: none
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- the mark ---------------------------------------------------------------
// Coordinates below are normalised to 0..1 so one description fits every size.

function inRoundedSquare(nx, ny, radius) {
  const cx = Math.min(Math.max(nx, radius), 1 - radius);
  const cy = Math.min(Math.max(ny, radius), 1 - radius);
  const dx = nx - cx;
  const dy = ny - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// A rectangle with a rounded, pointed bottom: the classic shield outline.
function inShield(nx, ny) {
  if (nx < 0.14 || nx > 0.86 || ny < 0.1 || ny > 0.96) return false;
  if (ny <= 0.5) return true;
  const dx = (nx - 0.5) / 0.36;
  const dy = (ny - 0.5) / 0.46;
  return dx * dx + dy * dy <= 1;
}

const BARS = [0.3, 0.44, 0.58];

function inBar(nx, ny) {
  return BARS.some(
    (cy) => Math.abs(ny - cy) <= 0.045 && nx >= 0.29 && nx <= 0.71
  );
}

function sample(nx, ny) {
  if (!inRoundedSquare(nx, ny, 0.22)) return [0, 0, 0, 0];
  if (inShield(nx, ny) && !inBar(nx, ny)) return [...AMBER, 255];
  return [...NAVY, 255];
}

function renderIcon(size) {
  const SS = 4; // supersamples per axis; averages away the jagged edges
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [r, g, b, a] = sample(
            (x + (sx + 0.5) / SS) / size,
            (y + (sy + 0.5) / SS) / size
          );
          // Premultiplied, so the transparent surround cannot darken the edge.
          pr += r * a;
          pg += g * a;
          pb += b * a;
          pa += a;
        }
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = pa ? Math.round(pr / pa) : 0;
      pixels[offset + 1] = pa ? Math.round(pg / pa) : 0;
      pixels[offset + 2] = pa ? Math.round(pb / pa) : 0;
      pixels[offset + 3] = Math.round(pa / (SS * SS));
    }
  }

  return encodePng(size, pixels);
}

const SIZES = [16, 32, 48, 128];
const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const file = path.join(outDir, "icon" + size + ".png");
  fs.writeFileSync(file, renderIcon(size));
  console.log("wrote icons/icon" + size + ".png");
}