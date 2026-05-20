// Generates the Lottery Lab app icon set (PNG + ICNS + ICO).
//
// Design:
//   1. macOS-style squircle background with a vertical indigo gradient
//      (deep at the top → bright at the bottom), giving it weight and
//      matching the "local desktop tool" vibe.
//   2. Centered white lottery ball with a subtle inner highlight and
//      soft drop shadow for depth.
//   3. Three colored pips on the ball (red / teal / gold) arranged in
//      a triangle — reads as "numbers" / "draw" at any size, and at
//      16px the pips collapse into a readable dot cluster.
//
// No external image libraries — we keep the zero-dep style of the
// existing placeholder script, just with real drawing primitives
// (rounded-rect SDF, anti-aliased circles, alpha blending).

import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, "..", "src-tauri", "icons");
mkdirSync(ICONS_DIR, { recursive: true });

// ---------- Color helpers -------------------------------------------------

/** Linear interpolation between two RGB triples. */
function lerpRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ---------- Buffer + primitives -------------------------------------------

function makeBuffer(size) {
  return Buffer.alloc(size * size * 4); // RGBA, all zero = transparent
}

function setPixel(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

/** Alpha blend src onto dst (0-255 components). */
function blendPixel(buf, size, x, y, r, g, b, a) {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  const dstA = buf[idx + 3];
  if (dstA === 0) {
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
    buf[idx + 3] = a;
    return;
  }
  const srcA = a / 255;
  const dstAlpha = dstA / 255;
  const outA = srcA + dstAlpha * (1 - srcA);
  if (outA <= 0) return;
  const mix = (srcChan, dstChan) =>
    Math.round(
      (srcChan * srcA + dstChan * dstAlpha * (1 - srcA)) / outA,
    );
  buf[idx] = mix(r, buf[idx]);
  buf[idx + 1] = mix(g, buf[idx + 1]);
  buf[idx + 2] = mix(b, buf[idx + 2]);
  buf[idx + 3] = Math.round(outA * 255);
}

/**
 * Rounded-square background with a vertical gradient.
 *
 * We compute the squircle-ish distance for each pixel and feed a
 * sub-pixel smoothstep through the edge for anti-aliasing.
 */
function fillRoundedRect(buf, size, margin, radius, topColor, bottomColor) {
  const innerSize = size - margin * 2;
  const halfSide = innerSize / 2 - radius;
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    const t = (y - margin) / innerSize;
    const clamped = Math.max(0, Math.min(1, t));
    const [r, g, b] = lerpRgb(topColor, bottomColor, clamped);
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx) - halfSide;
      const dy = Math.abs(y - cy) - halfSide;
      const cornerDist = Math.sqrt(
        Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2,
      );
      // Negative = inside the shape, 0 = right on the edge.
      const edge = cornerDist - radius;
      // Anti-alias the 1-pixel-wide edge.
      let alpha = 1;
      if (edge > 0) alpha = Math.max(0, 1 - edge);
      else if (edge > -0.5) alpha = 1;
      if (alpha > 0) {
        blendPixel(buf, size, x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  }
}

/** Anti-aliased filled circle. */
function fillCircle(buf, size, cx, cy, radius, [r, g, b, a = 255]) {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      const diff = radius - d;
      if (diff >= 0.5) {
        blendPixel(buf, size, x, y, r, g, b, a);
      } else if (diff > -0.5) {
        const coverage = diff + 0.5; // 0..1
        blendPixel(buf, size, x, y, r, g, b, Math.round(a * coverage));
      }
    }
  }
}

/** Soft radial highlight on the upper-left of the ball. */
function applyBallHighlight(buf, size, cx, cy, radius) {
  const hlCx = cx - radius * 0.35;
  const hlCy = cy - radius * 0.4;
  const hlR = radius * 0.7;
  for (let y = Math.max(0, Math.floor(hlCy - hlR)); y <= Math.min(size - 1, Math.ceil(hlCy + hlR)); y++) {
    for (let x = Math.max(0, Math.floor(hlCx - hlR)); x <= Math.min(size - 1, Math.ceil(hlCx + hlR)); x++) {
      const distFromHl = Math.sqrt((x - hlCx) ** 2 + (y - hlCy) ** 2);
      const distFromBall = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      if (distFromBall > radius) continue;
      const t = 1 - distFromHl / hlR;
      if (t <= 0) continue;
      const alpha = Math.round(t ** 2 * 160);
      blendPixel(buf, size, x, y, 255, 255, 255, alpha);
    }
  }
}

/** Soft drop shadow below the ball. */
function applyDropShadow(buf, size, cx, cy, radius) {
  const shadowCy = cy + radius * 0.45;
  const shadowR = radius * 1.05;
  for (let y = Math.max(0, Math.floor(shadowCy - shadowR)); y <= Math.min(size - 1, Math.ceil(shadowCy + shadowR)); y++) {
    for (let x = Math.max(0, Math.floor(cx - shadowR)); x <= Math.min(size - 1, Math.ceil(cx + shadowR)); x++) {
      const dx = (x + 0.5 - cx) / shadowR;
      const dy = (y + 0.5 - shadowCy) / (shadowR * 0.35);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      const alpha = Math.round((1 - d) ** 2 * 60);
      blendPixel(buf, size, x, y, 10, 8, 30, alpha);
    }
  }
}

// ---------- PNG encoder (from existing script) ----------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline prefixed with a filter byte (0 = none).
  const rowStride = size * 4;
  const raw = Buffer.alloc((rowStride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowStride + 1)] = 0;
    rgba.copy(raw, y * (rowStride + 1) + 1, y * rowStride, y * rowStride + rowStride);
  }
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- Design ---------------------------------------------------------

// Indigo gradient (deep top → bright bottom) for the squircle.
const BG_TOP = [30, 27, 75];    // indigo-950
const BG_BOTTOM = [99, 102, 241]; // indigo-500
const BALL_COLOR = [255, 255, 255];

// Lottery-ball pips: a warm triad so they pop on white.
const PIP_COLORS = [
  [220, 38, 38, 255],   // red (SSQ red)
  [14, 165, 233, 255],  // sky blue (SSQ blue)
  [234, 179, 8, 255],   // amber gold (accent)
];

function renderIcon(size) {
  const buf = makeBuffer(size);

  // Squircle background. Margin keeps the icon from touching the
  // canvas edge so the Finder / Dock drop-shadow has room to breathe.
  const margin = Math.round(size * 0.08);
  const radius = Math.round(size * 0.22);
  fillRoundedRect(buf, size, margin, radius, BG_TOP, BG_BOTTOM);

  // Centered white ball — intentionally a bit above center so the pips
  // leave room for the drop shadow below.
  const cx = size / 2;
  const cy = size * 0.48;
  const ballR = size * 0.3;

  applyDropShadow(buf, size, cx, cy, ballR);
  fillCircle(buf, size, cx, cy, ballR, [...BALL_COLOR, 255]);
  applyBallHighlight(buf, size, cx, cy, ballR);

  // Three pips in a triangle — tight enough that at 16px they still
  // read as a single punchy cluster.
  const pipR = Math.max(1.2, size * 0.055);
  const pipOffset = ballR * 0.42;
  const positions = [
    [cx, cy - pipOffset],                                  // top
    [cx - pipOffset * 0.9, cy + pipOffset * 0.55],         // bottom-left
    [cx + pipOffset * 0.9, cy + pipOffset * 0.55],         // bottom-right
  ];
  positions.forEach((pos, index) => {
    fillCircle(buf, size, pos[0], pos[1], pipR, PIP_COLORS[index]);
  });

  return buf;
}

// ---------- Generate all sizes --------------------------------------------

const PNG_SIZES = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
  // Sizes referenced only by the ICNS / ICO containers below.
  { name: "_icon_16.png", size: 16 },
  { name: "_icon_32.png", size: 32 },
  { name: "_icon_64.png", size: 64 },
  { name: "_icon_128.png", size: 128 },
  { name: "_icon_256.png", size: 256 },
  { name: "_icon_512.png", size: 512 },
  { name: "_icon_1024.png", size: 1024 },
];

const pngs = {};
for (const { name, size } of PNG_SIZES) {
  const buf = encodePng(renderIcon(size), size);
  writeFileSync(resolve(ICONS_DIR, name), buf);
  pngs[name] = buf;
}

// ---------- ICNS ----------------------------------------------------------

function icnsEntry(type, pngBuf) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(pngBuf.length + 8, 4);
  return Buffer.concat([header, pngBuf]);
}
const icnsEntries = [
  icnsEntry("icp4", pngs["_icon_16.png"]),
  icnsEntry("icp5", pngs["_icon_32.png"]),
  icnsEntry("icp6", pngs["_icon_64.png"]),
  icnsEntry("ic07", pngs["_icon_128.png"]),
  icnsEntry("ic08", pngs["_icon_256.png"]),
  icnsEntry("ic09", pngs["_icon_512.png"]),
  icnsEntry("ic10", pngs["_icon_1024.png"]),
];
const icnsBody = Buffer.concat(icnsEntries);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(icnsBody.length + 8, 4);
writeFileSync(resolve(ICONS_DIR, "icon.icns"), Buffer.concat([icnsHeader, icnsBody]));

// ---------- ICO -----------------------------------------------------------

function makeIco(pngBuf, size) {
  const dirSize = 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(dirSize);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + dirSize, 12);

  return Buffer.concat([header, entry, pngBuf]);
}
writeFileSync(resolve(ICONS_DIR, "icon.ico"), makeIco(pngs["_icon_256.png"], 256));

// Clean up the intermediate PNGs only used by the containers.
for (const name of Object.keys(pngs)) {
  if (name.startsWith("_icon_")) unlinkSync(resolve(ICONS_DIR, name));
}

console.log("Lottery Lab icons written to", ICONS_DIR);
