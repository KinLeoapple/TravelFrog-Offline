/**
 * 官方照片组合 (Picture.json 表 + 官方贴图体系, 全公式化)
 *
 * 官方规则 (main.min.js 逆向 + 官方贴图像素级验证 196/198 + 589/597):
 *   - 客户端 getPictureTexture 只读 pic.layers, 按序叠放, 画布 500x350
 *   - 姿势贴图体系: 每个姿势家族 4 种变体 (资源表 209 家族):
 *       _qw  = 蛙 (主角)          _bh = 小鸟 (旅伴)
 *       _cw  = 白毛球 (旅伴)       _yhc = 蜜蜂 (旅伴)
 *   - 角色层坐标公式 (frogPos/travelerPos 同一坐标系):
 *       layer.x = round(pos.x + 250 - texW/2)     水平居中于 pos.x
 *       layer.y = 350 - texH + min(pos.y, 0)      底边对齐 pos.y (y>0 视为 0)
 *     即 pos 以画布底边中点为原点, Y 轴向上, 蛙/旅伴脚底中心锚点
 *   - 组合顺序: backImage 元素 → 蛙(_qw) → 0~3 旅伴(变体随机) → frontImage
 *   - 元素引用名: back_<X> → 贴图 X (Goal 整幅背景); rnd_<X> → X 家族随机
 *     变体; <X>_<N> → <X>
 *   - 特例: 蛙画进整幅前景贴图的照片 (贴图 id 与前景相同) 不再叠蛙层
 */
const fs = require("fs");
const path = require("path");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");
const TEX_DIR = path.join(__dirname, "..", "resource", "China", "images", "Picture");

/** 表可能是数组或 {id: row} 对象, 统一转行数组 */
function rows(name, dir) {
  const t = JSON.parse(fs.readFileSync(path.join(CFG_DIR, dir || "MainData", name), "utf-8"));
  if (Array.isArray(t)) return t;
  return Object.keys(t).map((k) => t[k]).filter((r) => r && typeof r === "object");
}

const PICTURE_DB = new Map(rows("Picture.json", "PictureData").map((p) => [p.id, p]));
const RES_DB = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "PictureData", "resources.json"), "utf-8"));

// 照片数据包 (根目录 picture_data.json, 与 map_data.json 同级):
//   officialLayers — 官方真机抓包 layers 直查表 (album.load_by_id_list 实录):
//     官方服务器逐张配置的完整层列表, 坐标含 .5 小数, 无生成公式, 直查唯一精确来源
//   elemPos / poseTex — 公式化组合数据 (官方规则逆向推导), 直查表未收录的 pic_id 使用
const PIC_DATA = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "picture_data.json"), "utf-8")); }
  catch (e) { return { officialLayers: {}, elemPos: {}, poseTex: {} }; }
})();
const OFFICIAL_LAYERS = PIC_DATA.officialLayers || {};

// 贴图登记: 名字 -> {id, w, h} (PNG IHDR 头直读, 24 字节)
// 注意: resources.json 存在同贴图多 id 重复注册 (sky05:1/3, LS2_QW:437/691 等),
// 官方直查表可能引用任一 id → nameById/texById 必须覆盖全部同名 id。
const TEX = {};
const texById = {};
const nameById = {}; // 贴图 id -> 名字 (官方 layers 直查表解析用, 覆盖重复 id)
for (const k of Object.keys(RES_DB)) {
  const name = RES_DB[k].split("/").pop();
  if (TEX[name] === undefined) { // 同名重复条目: 尺寸只读一次 (同一文件)
    let size = null;
    try {
      const b = fs.readFileSync(path.join(TEX_DIR, RES_DB[k].replace("Picture/", "") + ".png"));
      size = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } catch (e) { /* 个别贴图文件缺失 */ }
    TEX[name] = Object.assign({ id: Number(k) }, size);
  }
  texById[Number(k)] = TEX[name];
  nameById[Number(k)] = name;
}
function nameOfTexId(id) { return nameById[Number(id)] || null; }

// 元素坐标表 (实测跨照片零冲突, 694 条) + 姿势特殊映射兜底 (BJ/CD 等缩写名)
const ELEM_POS = PIC_DATA.elemPos || {};
const POSE_TEX_FALLBACK = PIC_DATA.poseTex || {}; // pose_X -> qw 贴图 id (实测统计, 覆盖命名不规则家族)

// PictureChara 权威姿势映射: poseName[i] ↔ data[*].posePath[i] 平行数组
// (かえる=蛙 qw, bh/cw/yhc=旅伴)。BWG 系列等缩写名贴图 (BWG_SD1_QW 等) 名称链
// 解析不到, 只能从这里拿到; 仅收录 resource/ 里实际存在的贴图。
const PC_POSE_TEX = {}; // poseName -> { qw/bh/cw/yhc: 贴图名 }
try {
  const pc = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "PictureData", "PictureChara.json"), "utf-8"));
  const charaByName = {};
  for (const d of pc.data) charaByName[d.name] = d;
  const SUFFIX_CHARA = { qw: "かえる", bh: "bh", cw: "cw", yhc: "yhc" };
  pc.poseName.forEach((pn, i) => {
    const e = {};
    for (const [sfx, cn] of Object.entries(SUFFIX_CHARA)) {
      const p = charaByName[cn] && charaByName[cn].posePath[i];
      const n = p && p.path && p.path.split("/").pop();
      if (n && TEX[n] && TEX[n].w) e[sfx] = n;
    }
    if (Object.keys(e).length) PC_POSE_TEX[pn] = e;
  });
} catch (e) { /* PictureChara.json 缺失时走名称链 + 实测表兜底 */ }

const W = 500, H = 350;
const COMPANION_SUFFIXES = ["bh", "cw", "yhc"]; // 旅伴变体 (蛙用 qw)

/** 资源表里某家族的全部变体名 (sea → sea1..seaN), 升序 */
function familyNames(base) {
  const out = [];
  for (const n of Object.keys(TEX)) {
    if (n === base || new RegExp("^" + base + "\\d+$").test(n)) out.push(n);
  }
  return out.sort();
}

/** 元素名解析链: 直接名 / back_X→X / rnd_X→家族随机 / X_N→X */
function resolveElemName(name) {
  if (TEX[name] && ELEM_POS[name]) return name;
  if (TEX[name] && TEX[name].w && TEX[name].w >= 490) return name; // 整幅背景(Goal 500x350): 坐标必 (0,0)
  if (name.startsWith("back_")) {
    const base = name.slice(5);
    if (TEX[base] && ELEM_POS[base]) return base;
    if (TEX[base] && TEX[base].w && TEX[base].w >= 490) return base;
  }
  if (name.startsWith("rnd_")) {
    const pool = familyNames(name.slice(4)).filter((n) => ELEM_POS[n] || (TEX[n] && TEX[n].w >= 490));
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  const m = name.match(/^(.+)_\d+$/);
  if (m && TEX[m[1]] && (ELEM_POS[m[1]] || (TEX[m[1]].w && TEX[m[1]].w >= 490))) return m[1];
  return null;
}

function elemLayer(name) {
  const real = resolveElemName(name);
  if (!real) return null;
  const pos = ELEM_POS[real] || [0, 0]; // 整幅背景无实测坐标 → (0,0)
  return { layer: [TEX[real].id, pos[0], pos[1]] };
}

/**
 * 姿势名 → 指定变体贴图。
 * 解析链: 0) PictureChara 权威映射 (poseName[i] ↔ posePath[i], 缩写名贴图唯一来源);
 * 1) pose_X → X_qw/X_QW 命名规则; 2) 去下划线模糊匹配 (官方姿势名
 * 与贴图名下划线不一致, 如 pose_g_haerbin_4 ↔ g_haerbin4_qw); 3) 实测映射表兜底。
 * 旅伴变体: 优先 PictureChara 直查, 否则从 qw 贴图名派生 (g_haerbin4_qw → g_haerbin4_bh/cw/yhc)。
 */
function poseTexture(pose, suffix) {
  // 链 0: PictureChara 权威映射
  const pcPose = String(pose || "").replace(/^rnd_/, "");
  let hit = PC_POSE_TEX[pcPose];
  if (!hit) {
    const norm = pcPose.replace(/^pose_g_/, "pose_").replace(/_(\d+)$/, "$1");
    if (norm !== pcPose) hit = PC_POSE_TEX[norm];
  }
  if (hit && hit[suffix]) return TEX[hit[suffix]];
  let qw = null;
  const m = String(pose || "").match(/^(?:rnd_)?pose_(.+)$/);
  if (m) {
    qw = [m[1] + "_qw", m[1] + "_QW"].find((n) => TEX[n] && TEX[n].w) || null;
    if (!qw) {
      // 模糊匹配: 归一化(去全部下划线+小写)比对所有 _qw 贴图
      const norm = m[1].replace(/_/g, "").toLowerCase();
      qw = Object.keys(TEX).find((n) => {
        if (!TEX[n].w) return false;
        const mm = n.match(/^(.+)_qw$/i);
        return mm && mm[1].replace(/_/g, "").toLowerCase() === norm;
      }) || null;
    }
  }
  if (!qw && POSE_TEX_FALLBACK[pose] != null) {
    const id = POSE_TEX_FALLBACK[pose];
    qw = Object.keys(TEX).find((n) => TEX[n].id === id && TEX[n].w) || null;
  }
  if (!qw) return null;
  if (suffix === "qw") return TEX[qw];
  const fam = qw.replace(/_qw$/i, "");
  const v = [fam + "_" + suffix, fam + "_" + suffix.toUpperCase()].find((n) => TEX[n] && TEX[n].w);
  return v ? TEX[v] : TEX[qw];
}

/** 角色层: 官方公式 (底边中点原点, Y 向上, 脚底中心锚点, y>0 钳到 0) */
function roleLayer(pose, pos, suffix) {
  const tex = poseTexture(pose, suffix);
  if (!tex || !tex.w || !pos) return null;
  return {
    layer: [
      tex.id,
      Math.round(pos.x + W / 2 - tex.w / 2),
      H - tex.h + Math.min(pos.y, 0),
    ],
  };
}

/** 旅伴槽位概率: 每槽 30% 出现 (官方概率不可考; 原版明信片常见 0~3 只小动物) */
const COMPANION_CHANCE = 0.3;

/** pic_id 种子伪随机 (mulberry32): 同一张照片的旅伴组合永远一致 (layers 不入存档) */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按官方 Picture 表组合一张照片的 layers。
 * 优先级: 官方真机抓包直查表 (100% 精确) > 公式化组合。
 * 旅伴组合以 pic_id 为种子 —— 同一张照片每次下发的 layers 完全一致。
 * @param {number} picId
 * @param {object} [opts] { companions: boolean } 关闭旅伴 (默认开)
 * @returns {Array|null} layers; 要素缺失时 null (调用方回退社区版)
 */
function composeLayers(picId, opts) {
  const official = OFFICIAL_LAYERS[Number(picId)];
  if (official && Array.isArray(official) && official.length) {
    // 深拷贝: 调用方 (存档/GM) 可能修改 layers, 不能污染直查表
    return official.map((l) => ({ layer: l.layer.slice() }));
  }
  const row = PICTURE_DB.get(Number(picId));
  if (!row) return null;
  const withCompanions = !opts || opts.companions !== false;
  const rng = seededRandom(Number(picId) || 1);
  const layers = [];
  for (const name of row.backImage || []) {
    const l = elemLayer(name);
    if (!l) return null;
    layers.push(l);
  }
  // 前景先行解析 (蛙层与前景同贴图 = 官方把蛙画进整图, 跳过蛙层)
  const fronts = [];
  for (const name of row.frontImage || []) {
    const l = elemLayer(name);
    if (!l) return null;
    fronts.push(l);
  }
  const frog = row.frogPose ? roleLayer(row.frogPose, row.frogPos, "qw") : null;
  const frogInFront = frog && fronts.some((f) => f.layer[0] === frog.layer[0]);
  if (frog && !frogInFront) layers.push(frog);
  // 旅伴: travelerPose 与 travelerPos 一一对应; 空姿势槽跳过
  if (withCompanions) {
    const poses = row.travelerPose || [];
    const poss = row.travelerPos || [];
    for (let i = 0; i < Math.min(poses.length, poss.length); i++) {
      if (!poses[i]) continue; // 官方表内空槽
      if (rng() >= COMPANION_CHANCE) continue;
      const suffix = COMPANION_SUFFIXES[Math.floor(rng() * COMPANION_SUFFIXES.length)];
      const l = roleLayer(poses[i], poss[i], suffix);
      if (l) layers.push(l);
    }
  }
  layers.push(...fronts);
  // 官方抓包 356/356 张照片末层恒为 photo_frame(id=0, 白色相框) —— 公式路径补齐,
  // 否则该照片在客户端无相框边 (与抓包照片外观不一致)
  layers.push({ layer: [0, 0, 0] });
  return layers.length ? layers : null;
}

/** 蛙层 (GM/回退路径用) — 官方直查表优先, 公式兜底。
 * 注意: 直查表蛙层命名无统一后缀 (LS2_QW / roof1_2qw / wet0 等),
 * 本函数仅识别规则命名 (_qw 结尾); 直查表照片的池准入用 hasOfficialLayers 信任官方数据。 */
function frogLayerOf(picId) {
  const official = OFFICIAL_LAYERS[Number(picId)];
  if (official && Array.isArray(official) && official.length) {
    for (const l of official) {
      const name = nameOfTexId(l.layer[0]);
      if (name && /_qw$/i.test(name)) return { layer: l.layer.slice() };
    }
    return null; // 官方该照片无独立蛙层 (蛙画进整图/无蛙照片)
  }
  const row = PICTURE_DB.get(Number(picId));
  if (!row || !row.frogPose) return null;
  return roleLayer(row.frogPose, row.frogPos, "qw");
}

/** 官方设计该照片有蛙且可给出蛙层 */
function officialHasFrog(picId) {
  return !!frogLayerOf(picId);
}

/** 该照片命中官方真机抓包直查表 (layers 100% 精确, 调用方应无条件信任) */
function hasOfficialLayers(picId) {
  const official = OFFICIAL_LAYERS[Number(picId)];
  return !!(official && Array.isArray(official) && official.length);
}

module.exports = { composeLayers, officialHasFrog, hasOfficialLayers, frogLayerOf, nameOfTexId, PICTURE_DB };
