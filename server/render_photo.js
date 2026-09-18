/**
 * 照片组合像素级渲染验证 (无依赖 PNG 解码/合成/编码)
 * 把 photo.js 组合的 layers 用官方贴图真实渲染 → 输出 PNG 供肉眼对照
 * 用法: node render_photo.js <pic_id> [更多pic_id...]  → 输出 _render/pic_<id>.png
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const photo = require("./photo");

// ---- PNG 解码 (支持 8bit RGBA/RGB + 调色板省略, 照片贴图都是真彩色) ----
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png: " + file);
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 && !(bitDepth === 1 && colorType === 3)) throw new Error("unsupported bit depth " + bitDepth + ": " + file);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 0 ? 1 : 4;
  const bpp = bitDepth === 1 ? 1 : channels; // 过滤单元: <8bit 时按 1 字节
  const stride = bitDepth === 1 ? Math.ceil(w / 8) : w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = Buffer.from(line);
    // unfilter
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    // 写 RGBA
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) {
        out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 3) {
        const idx = cur[x];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255;
      }
    }
    prev = cur;
  }
  return { w, h, data: out };
}

// ---- PNG 编码 (RGBA, filter 0) ----
function encodePNG(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 渲染: layers 叠放 500x350 ----
const RES = require("f:/Projects/旅行青蛙/TravelFrog/resource/China/config/PictureData/resources.json");
const TEX_DIR = "f:/Projects/旅行青蛙/TravelFrog/resource/China/images/Picture";
const ROOT = "f:/Projects/旅行青蛙/TravelFrog/resource/China";
// 客户端按贴图名查 manifest (photo_frame 在 System/ 而非 Picture/), resources 表路径仅是其一
const MANIFEST = require("f:/Projects/旅行青蛙/TravelFrog/resource/China/default.res.json").resources;
const BY_NAME = {};
for (const r of MANIFEST) BY_NAME[r.name.replace(/_png$/, "")] = r.url;
const texCache = {};
function loadTex(id) {
  if (texCache[id]) return texCache[id];
  const rel = RES[String(id)];
  const candidates = [];
  if (rel) candidates.push(path.join(TEX_DIR, rel.replace("Picture/", "") + ".png"));
  const name = rel ? rel.split("/").pop() : null;
  if (name && BY_NAME[name]) candidates.push(path.join(ROOT, BY_NAME[name]));
  for (const file of candidates) {
    try { texCache[id] = decodePNG(file); return texCache[id]; } catch (e) { /* 下一候选 */ }
  }
  texCache[id] = null;
  return null;
}

function render(picId) {
  const layers = photo.composeLayers(picId);
  if (!layers) return null;
  const W = 500, H = 350;
  const canvas = Buffer.alloc(W * H * 4, 0);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    const sa = c[3] / 255, da = canvas[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    canvas[o] = Math.round((c[0] * sa + canvas[o] * da * (1 - sa)) / oa);
    canvas[o + 1] = Math.round((c[1] * sa + canvas[o + 1] * da * (1 - sa)) / oa);
    canvas[o + 2] = Math.round((c[2] * sa + canvas[o + 2] * da * (1 - sa)) / oa);
    canvas[o + 3] = Math.round(oa * 255);
  };
  for (const l of layers) {
    const tex = loadTex(l.layer[0]);
    if (!tex) { console.log("  缺贴图", l.layer[0]); continue; }
    for (let y = 0; y < tex.h; y++) {
      for (let x = 0; x < tex.w; x++) {
        const o = (y * tex.w + x) * 4;
        if (tex.data[o + 3] === 0) continue;
        put(l.layer[1] + x, l.layer[2] + y, [tex.data[o], tex.data[o + 1], tex.data[o + 2], tex.data[o + 3]]);
      }
    }
  }
  return canvas;
}

// ---- 主流程 ----
module.exports = { renderPng: (picId) => { const c = render(picId); return c ? encodePNG(500, 350, c) : null; } };
if (require.main !== module) return module.exports;
const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!ids.length) { console.error("用法: node render_photo.js <pic_id>..."); process.exit(1); }
const outDir = path.join(__dirname, "_render");
fs.mkdirSync(outDir, { recursive: true });
for (const id of ids) {
  const canvas = render(id);
  if (!canvas) { console.log(`pic ${id}: 无法组合`); continue; }
  const out = path.join(outDir, `pic_${id}.png`);
  fs.writeFileSync(out, encodePNG(500, 350, canvas));
  console.log(`pic ${id}: 已渲染 -> ${out}`);
}
