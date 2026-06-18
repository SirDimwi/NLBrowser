// Generates minimal valid PNG icons without any dependencies
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = uint32BE(data.length);
  const crc = uint32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePNG(size, bg, fg) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB

  // Build raw pixel rows
  const rows = [];
  const cx = size / 2, cy = size / 2, r = size * 0.42;

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      // Rounded rect background
      const rx = size * 0.18;
      const dx = Math.max(0, Math.abs(x - cx) - (size/2 - rx));
      const dy = Math.max(0, Math.abs(y - cy) - (size/2 - rx));
      const inBg = (dx * dx + dy * dy) < rx * rx;

      // Hexagon border
      const px = x - cx, py = y - cy;
      const angle = Math.atan2(py, px);
      const hexR = r * Math.cos(Math.PI / 6) / Math.cos(((angle % (Math.PI/3)) + Math.PI/3) % (Math.PI/3) - Math.PI/6);
      const dist = Math.sqrt(px*px + py*py);
      const inHex = dist < hexR;
      const onBorder = dist >= hexR * 0.82 && dist < hexR;

      // Simple N letter
      const lx = (x - cx) / size, ly = (y - cy) / size;
      const inN = (
        (Math.abs(lx + 0.12) < 0.04 && Math.abs(ly) < 0.22) ||
        (Math.abs(lx - 0.12) < 0.04 && Math.abs(ly) < 0.22) ||
        (Math.abs((ly + 0.22) - (lx + 0.12) * (0.44/0.24)) < 0.05 && lx > -0.14 && lx < 0.14)
      );

      let col;
      if (!inBg) col = [10, 13, 20];
      else if (inN || onBorder) col = fg;
      else col = bg;

      row[1 + x*3] = col[0];
      row[1 + x*3+1] = col[1];
      row[1 + x*3+2] = col[2];
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const bg = [10, 13, 20];   // #0a0d14
const fg = [6, 182, 212];  // #06b6d4 cyan

const outDir = path.join(__dirname, 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = makePNG(size, bg, fg);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icon${size}.png written (${png.length} bytes)`);
}
