/** config.eab 解密提取 (密钥已实测校准: 源码字面量含 3 个不可见控制字符,
 *  simpleEncrypt 后 = "ejoyassetbundle"; 终端复制丢控制字符是旧工具解不开的根因) */
const fs = require("fs");
const path = require("path");

// ---- 客户端 xxtea (main.min.js 原样移植) ----
const DELTA = 2654435769;
function toUint8Array(e, t) {
  var i = e.length, n = i << 2;
  if (t) { var r = e[i - 1]; if (n -= 4, n - 3 > r || r > n) return null; n = r; }
  for (var o = new Uint8Array(n), a = 0; n > a; ++a) o[a] = e[a >> 2] >> ((3 & a) << 3);
  return o;
}
function toUint32Array(e, t) {
  var i = e.length, n = i >> 2;
  0 !== (3 & i) && ++n;
  var r; t ? (r = new Uint32Array(n + 1), r[n] = i) : r = new Uint32Array(n);
  for (var o = 0; i > o; ++o) r[o >> 2] |= e[o] << ((3 & o) << 3);
  return r;
}
function mx(e, t, i, n, r, o) { return (i >>> 5 ^ t << 2) + (t >>> 3 ^ i << 4) ^ (e ^ t) + (o[3 & n ^ r] ^ i); }
function fixk(e) { if (e.length < 16) { var t = new Uint8Array(16); t.set(e), e = t; } return e; }
function decryptArr(e, t) {
  var i, r, o, a, s, c, l = e.length, h = l - 1;
  for (i = e[0], c = Math.floor(6 + 52 / l), o = c * DELTA; 0 !== o; o -= DELTA) {
    for (a = o >>> 2 & 3, s = h; s > 0; --s) r = e[s - 1], i = e[s] -= mx(o, i, r, s, a, t);
    r = e[h], i = e[0] -= mx(o, i, r, s, a, t);
  }
  return e;
}
function strToUtf8(e) {
  for (var t = e.length, i = new Uint8Array(3 * t), n = 0, r = 0; t > r; r++) {
    var o = e.charCodeAt(r);
    if (128 > o) i[n++] = o;
    else if (2048 > o) i[n++] = 192 | o >> 6, i[n++] = 128 | 63 & o;
    else i[n++] = 224 | o >> 12, i[n++] = 128 | o >> 6 & 63, i[n++] = 128 | 63 & o;
  }
  return i.subarray(0, n);
}
function xxteaDecrypt(e, keyStr) {
  const n = strToUtf8(keyStr);
  return toUint8Array(decryptArr(toUint32Array(e, false), toUint32Array(fixk(n), false)), true);
}

// ---- eab 容器 ----
// XXTEA 密钥: 根目录 eab.key.json 的 xxteaKey 字段 (与 map_data.json 同级, Web 直访已被
// server.js 拦截)。来源: main.min.js 源码字面量 "r]|lnf\x80X\x81U\x82aqr" (含 3 个不可见
// 控制字符, 终端复制会丢失) 经 Utils.simpleEncrypt(_,13) 派生。
const EAB_KEY = (() => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eab.key.json"), "utf-8"));
  if (!cfg.xxteaKey) throw new Error("eab.key.json 缺少 xxteaKey 字段");
  return cfg.xxteaKey;
})();

function decodeEab(buf) {
  const u8 = new Uint8Array(buf);
  if (!(u8[0] === 137 && u8[1] === 69 && u8[2] === 65 && u8[3] === 66 && u8[4] === 13 && u8[5] === 10 && (u8[6] === 26 || u8[6] === 27) && u8[7] === 10)) throw new Error("not eab");
  let body;
  if (u8[6] === 27) {
    body = xxteaDecrypt(new Uint8Array(buf, 8), EAB_KEY);
    if (!body) throw new Error("xxtea 解密失败");
  } else body = new Uint8Array(buf, 8);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const configLen = dv.getUint32(0, true);
  const config = JSON.parse(Buffer.from(body.buffer, body.byteOffset + 4, configLen).toString("utf-8"));
  const raw = body.slice(4 + configLen);
  return { config, raw };
}

module.exports = { decodeEab };

// ---- CLI: 提取子资产 ----
if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, "..", "resource", "China", "eab", "config.eab");
  const buf = fs.readFileSync(file);
  const { config, raw } = decodeEab(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log("子资产", config.length, "个:");
  let off = 0;
  const outDir = path.join(__dirname, "_config_eab");
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of config) {
    const bytes = Buffer.from(raw.buffer, raw.byteOffset + off, e.s);
    if (process.argv[3] === "all" || process.argv[3] === e.n) {
      fs.writeFileSync(path.join(outDir, e.n + (e.t === "json" ? ".json" : ".bin")), bytes);
      console.log("  导出", e.n, e.t, e.s + "B");
    }
    off += e.s;
  }
  if (!process.argv[3]) console.log("  (加参数 all 或子资产名导出)");
}
