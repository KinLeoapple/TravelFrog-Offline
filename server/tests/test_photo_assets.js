/**
 * 照片资产完整性验证 (相册显示异常问题的回归锁):
 *   客户端渲染链 (main.min.js): 层贴图 id → ResourcesDB 路径 → 末段名+"_png"
 *   → RES.getRes; 任一层不在 default.res.json 清单 → getRes null → 整张照片
 *   不渲染 (相册里显示为天空渐变占位)。故所有可合成照片的每层贴图必须:
 *     1. 在 resources.json 表中可解析出名字
 *     2. 名字+"_png" 已注册进客户端清单 default.res.json
 *     3. PNG 文件真实存在 (服务端可静态托管)
 * 运行: node test_photo_assets.js
 */
const fs = require("fs");
const path = require("path");
const photo = require("../photo");
const { decodeEab } = require("../decode_config_eab");

const ROOT = path.join(__dirname, "..", "..");
const manifest = new Set(
  JSON.parse(fs.readFileSync(path.join(ROOT, "resource", "China", "default.res.json"), "utf-8"))
    .resources.map((r) => r.name)
);
const RES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "resource", "China", "config", "PictureData", "resources.json"), "utf-8")
);
const TEX_DIR = path.join(ROOT, "resource", "China", "images", "Picture");

// 客户端运行时真表 (config.eab → resources_json): getPicturePath 查不到的 id 会
// 回退 sky05 天空贴图 → 照片变天空渐变。服务端合成所用 id 必须在这张表里。
const clientTable = (() => {
  const buf = fs.readFileSync(path.join(ROOT, "resource", "China", "eab", "config.eab"));
  const { config, raw } = decodeEab(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let off = 0;
  for (const e of config) {
    if (e.n === "resources_json") {
      return JSON.parse(Buffer.from(raw.buffer, raw.byteOffset + off, e.s).toString("utf-8"));
    }
    off += e.s;
  }
  return {};
})();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

let total = 0;
const problems = [];
for (const [id] of photo.PICTURE_DB) {
  const layers = photo.composeLayers(id);
  if (!layers) continue;
  total++;
  for (const l of layers) {
    if (l.layer[0] === 0) continue; // photo_frame 由清单 photo_frame_png 提供
    if (clientTable[String(l.layer[0])] === undefined) {
      problems.push(`照片 ${id} 贴图 id ${l.layer[0]} 不在客户端 config.eab 资源表 (会回退天空贴图)`);
      continue;
    }
    const name = photo.nameOfTexId(l.layer[0]);
    if (!name) { problems.push(`照片 ${id} 层 ${l.layer[0]} 名字不可解析`); continue; }
    if (!manifest.has(name + "_png")) { problems.push(`照片 ${id} 贴图 ${name} 未注册进客户端清单`); continue; }
    const rid = Object.keys(RES).find((k) => RES[k].split("/").pop() === name);
    const rel = rid ? RES[rid].replace("Picture/", "") : null;
    if (!rel || !fs.existsSync(path.join(TEX_DIR, rel + ".png"))) {
      problems.push(`照片 ${id} 贴图 ${name} PNG 文件缺失`);
    }
  }
}
check(`A1 可合成照片 ${total} 张, 全部层贴图客户端可加载`, problems.length === 0,
  problems.length ? `问题 ${problems.length} 条: ${problems.slice(0, 5).join("; ")}` : "");
check("A2 客户端 config.eab 资源表含解包版全部贴图 id", Object.keys(clientTable).length >= Object.keys(RES).length,
  `客户端 ${Object.keys(clientTable).length} / 解包 ${Object.keys(RES).length}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
