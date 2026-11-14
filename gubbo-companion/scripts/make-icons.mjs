// Draws the app and tray icons (a blocky purple head) and writes them as PNG. No image dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const head = (u, v) => {
  const m = 0.09;
  if (u < m || u > 1 - m || v < m || v > 1 - m) return [0, 0, 0, 0];
  const gx = Math.floor(((u - m) / (1 - 2 * m)) * 8), gy = Math.floor(((v - m) / (1 - 2 * m)) * 8);
  const hair = gy < 2 || (gy === 2 && (gx === 0 || gx === 7));
  const eye = gy === 4 && (gx === 1 || gx === 2 || gx === 5 || gx === 6);
  const pupil = gy === 4 && (gx === 2 || gx === 5);
  const mouth = gy === 6 && gx >= 2 && gx <= 5;
  const shade = ((gx * 7 + gy * 13) % 5) * 3;
  if (hair) return [46 + shade, 38 + shade, 60 + shade, 255];
  if (pupil) return [255, 255, 255, 255];
  if (eye) return [40, 30, 60, 255];
  if (mouth) return [70, 45, 110, 255];
  return [150 + shade, 108 + shade, 240, 255];
};

fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/icon.png', png(512, head));
fs.writeFileSync('assets/tray.png', png(32, head));
console.log('icons written');
