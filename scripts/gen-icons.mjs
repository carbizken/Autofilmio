// Generate AutoFilm PNG icons (fire background + white chevron mark)
// Pure Node: zlib for IDAT, hand-rolled CRC32. No image libraries.
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeIcon(size) {
  // Fire #D94F00 rounded-square bg, white chevron (the AutoFilm "Λ" mark)
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const cx = size / 2;
  const strokeW = Math.max(1.5, size * 0.10);

  // Chevron geometry: apex at (0.5, 0.24), feet at (0.18, 0.76) & (0.82, 0.76)
  const ax = 0.5 * size, ay = 0.24 * size;
  const lx = 0.18 * size, rx2 = 0.82 * size, fy = 0.76 * size;

  function distToSeg(px_, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px_ - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px_ - qx, py - qy);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Rounded-rect alpha
      const dx = Math.max(r - x, x - (size - 1 - r), 0);
      const dy = Math.max(r - y, y - (size - 1 - r), 0);
      const cornerDist = Math.hypot(dx, dy);
      const bgA = cornerDist <= r ? 255 : 0;
      if (!bgA) { px[i+3] = 0; continue; }

      // Background: fire orange
      let cr = 0xD9, cg = 0x4F, cb = 0x00;

      // Chevron stroke (two segments), antialiased edge
      const d = Math.min(
        distToSeg(x + .5, y + .5, lx, fy, ax, ay),
        distToSeg(x + .5, y + .5, ax, ay, rx2, fy),
      );
      const t = Math.max(0, Math.min(1, (strokeW / 2 + 0.7 - d) / 1.4));
      if (t > 0) {
        cr = Math.round(cr + (255 - cr) * t);
        cg = Math.round(cg + (255 - cg) * t);
        cb = Math.round(cb + (255 - cb) * t);
      }

      px[i] = cr; px[i+1] = cg; px[i+2] = cb; px[i+3] = 255;
    }
  }

  // Assemble scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../chrome-extension/icons', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128, 192]) {
  writeFileSync(`${outDir}/icon-${s}.png`, makeIcon(s));
  console.log(`icon-${s}.png written`);
}
// Also drop the 192 into frontend for web push notifications
writeFileSync(new URL('../frontend/icon-192.png', import.meta.url).pathname, makeIcon(192));
console.log('frontend/icon-192.png written');
