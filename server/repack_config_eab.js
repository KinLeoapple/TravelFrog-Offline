/** 重打包 config.eab:
 *  1. 解密原包 → 2. 给 resources_json 合并解包版多出的 id → 3. 以明文格式 (byte6=26,
 *     与官方其余 eab 一致, 客户端原生支持) 写回。原件备份为 config.eab.bak_official。
 *  用法: node repack_config_eab.js [--restore] */
const fs = require("fs");
const path = require("path");
const { decodeEab } = require("./decode_config_eab");

const EAB = path.join(__dirname, "..", "resource", "China", "eab", "config.eab");
const BAK = EAB + ".bak_official";
const UNPACKED = path.join(__dirname, "..", "resource", "China", "config", "PictureData", "resources.json");

if (process.argv[2] === "--restore") {
  if (!fs.existsSync(BAK)) { console.error("无备份可还原"); process.exit(1); }
  fs.copyFileSync(BAK, EAB);
  console.log("已还原官方原包 config.eab");
  process.exit(0);
}

if (!fs.existsSync(BAK)) fs.copyFileSync(EAB, BAK);
const buf = fs.readFileSync(BAK); // 始终从官方原包出发, 幂等

const { config, raw } = decodeEab(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const unpacked = JSON.parse(fs.readFileSync(UNPACKED, "utf-8"));

const parts = [];
let off = 0, added = 0;
for (const e of config) {
  const origS = e.s; // 源布局按原尺寸推进; 改写 e.s 前必须先记录, 否则后续子资产全部错位
  let bytes = Buffer.from(raw.buffer, raw.byteOffset + off, origS);
  off += origS;
  if (e.n === "resources_json") {
    const table = JSON.parse(bytes.toString("utf-8"));
    for (const [id, p] of Object.entries(unpacked)) {
      if (table[id] === undefined) { table[id] = p; added++; }
    }
    bytes = Buffer.from(JSON.stringify(table), "utf-8");
    e.s = bytes.length;
    console.log(`resources_json: 合并 ${added} 个缺失 id, 新大小 ${e.s} B`);
  }
  parts.push(bytes);
}

const head = Buffer.alloc(8);
head.set([137, 69, 65, 66, 13, 10, 26, 10]); // 明文 eab (byte6=26)
const cfgJson = Buffer.from(JSON.stringify(config), "utf-8");
const len = Buffer.alloc(4);
len.writeUInt32LE(cfgJson.length, 0);
fs.writeFileSync(EAB, Buffer.concat([head, len, cfgJson, ...parts]));
console.log(`子资产 ${config.length} 个; 明文包已写回 ${EAB} (${fs.statSync(EAB).size} B, 原 ${buf.length} B)`);
