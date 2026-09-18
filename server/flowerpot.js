/**
 * 栽培花盆 (庭院种花)
 *
 * 官方语义 (main.min.js + offline-engine 逆向):
 *   - 客户端没有"种植"命令 —— 整个循环服务器驱动:
 *     空槽自动随机播种, 成长按经过时间推进, stage>=3 可收获
 *   - flowerpotData 只有一个花盆 23001 (陶瓷花盆), pos_list 2 个种植位;
 *     plant 35 种植物 (2010101 角堇·火龙果 ...), 每种 3 张成长图 (对应 stage 1..3)
 *   - 收获产物按植物物种固定映射: 蔬菜收同名特产 (种樱桃番茄收樱桃番茄),
 *     花类收同名插花物品 (Item.json type14, 种郁金香·命运女神收同名花);
 *     ×1~2 (30% 概率 2 个), 入 house; 特产记图鉴 specialtys, 花只记花园图鉴
 *   - furniture_flowerpot_harvest 响应精确格式 {item_list:[{item_id, num}]} (无 code);
 *     植物物种记入 flowerpot.grown (花园图鉴)
 *   - 收获后客户端 update_flowerpot 无事件绑定 → 须全量推 client_load_role 重绘
 */
const fs = require("fs");
const path = require("path");
const furni = require("./furni");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");
const read = (p) => JSON.parse(fs.readFileSync(path.join(CFG_DIR, p), "utf-8"));

const FP_TABLE = read(path.join("Furnitur", "flowerpotData.json"));
const FP_POTS = FP_TABLE.flowerpot || {};
const FLOWERPOT_ID = Number(Object.keys(FP_POTS)[0] || 23001);
const FLOWERPOT_SLOTS = (((FP_POTS[String(FLOWERPOT_ID)] || {}).pos_list) || []).length || 2;
const FLOWER_PLANTS = Object.keys(FP_TABLE.plant || {}).map(Number);

// 收获产物映射 (P7): 植物名 "观赏名·品种名" 的前缀决定产物, 收获物与种植外观一致
// (种樱桃番茄收樱桃番茄); 花类按完整名收同名插花物品 (Item.json type14)
const PLANT_HARVEST = [
  ["拇指萝卜", 4101], // → 小拇指萝卜
  ["樱桃萝卜", 4102], // → 樱桃萝卜
  ["樱桃番茄", 4103], // → 樱桃番茄
  ["迷你南瓜", 4104], // → 迷你南瓜
  ["草莓", 4006],     // → 草莓
];
const FLOWER_HARVEST_ID = 4020; // 花名无同名物品时兜底 → 蜂蜜

// 花类插花物品表 (Item.json type14): 植物名 → 同名物品 id (角堇·火龙果 → 202211)
const FLOWER_ITEM_BY_NAME = (() => {
  try {
    const t = read(path.join("MainData", "Item.json"));
    const arr = Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]);
    const m = new Map();
    for (const i of arr) {
      if (i && i.name && Number(i.type) === 14) m.set(i.name, Number(i.id));
    }
    return m;
  } catch (e) { return new Map(); }
})();

// 特产图鉴 id 集 (Specialty.json): 花类插花物品 (2022xx) 不属特产, 不记 specialtys
const SPECIALTY_IDS = new Set((() => {
  try {
    const t = read(path.join("MainData", "Specialty.json"));
    const arr = Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]);
    return arr.map((r) => Number(r.itemId || r.id)).filter((v) => v > 0);
  } catch (e) { return []; }
})());

/** 植物物种 → 收获物品 id (蔬菜=特产, 花=同名插花物品) */
function plantHarvestId(plantId) {
  const name = ((FP_TABLE.plant || {})[plantId] || {}).name || "";
  for (const [prefix, id] of PLANT_HARVEST) {
    if (name.indexOf(prefix) === 0) return id;
  }
  const flower = FLOWER_ITEM_BY_NAME.get(name);
  if (flower) return flower;
  return FLOWER_HARVEST_ID;
}

// 【自设计】成长节奏 (原版在服务端不可考): 每阶段默认 200s, 共 3 阶段
const PLANT_STAGE_SEC = Math.max(5, Number(process.env.FROG_PLANT_STAGE_SEC || 200));

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 存档 flowerpot 节点兜底 + 播种/成长推进 (travelTick 驱动); 返回 true 表示状态变化
 * 肥力门控【自设计】(对齐客户端 update_compost 土地贴图: 堆肥盒空 = 贫瘠):
 *   - 播种免费 (发芽 stage 1 靠种子自身养分), 空槽照常自动播种
 *   - stage 1→2 不需堆肥 (种子自身养分足够长一阶), stage 2→3 每升一阶吸收一格堆肥
 *   - 贫瘠 (0 格): stage 2 冻结 (plantedAt 跟随 now), 补肥后从当前阶重新计时
 *   - 肥沃 (3+ 格): 阶段时长减半
 */
function flowerpotTick(s, now) {
  const fp = s.flowerpot || (s.flowerpot = { slots: [], grown: [] });
  if (!Array.isArray(fp.slots)) fp.slots = [];
  if (!Array.isArray(fp.grown)) fp.grown = [];
  if (fp.slots.length !== FLOWERPOT_SLOTS) {
    // 槽位数量变化: 保留已有槽, 补齐/截断
    const old = fp.slots.slice(0, FLOWERPOT_SLOTS);
    while (old.length < FLOWERPOT_SLOTS) old.push({ id: 0, stage: 0, plantedAt: 0 });
    fp.slots = old;
  }
  const boxes = furni.node(s).compost.boxes;
  let filled = 0;
  for (const v of boxes) if (v > 0) filled++;
  const barren = filled === 0;
  const stageSec = filled >= 3 ? Math.max(1, Math.floor(PLANT_STAGE_SEC / 2)) : PLANT_STAGE_SEC;
  let changed = false;
  for (const slot of fp.slots) {
    if (!slot.id) {
      // 空槽自动随机播种 (官方语义: 服务器驱动; 发芽不耗肥)
      if (FLOWER_PLANTS.length) {
        slot.id = FLOWER_PLANTS[randInt(0, FLOWER_PLANTS.length - 1)];
        slot.stage = 1;
        slot.plantedAt = now;
        changed = true;
      }
      continue;
    }
    if (barren) {
      // 贫瘠: stage 1→2 靠种子自身养分仍可生长; stage 2→3 需堆肥, 冻结
      if (slot.stage < 2) {
        const want = Math.min(2, 1 + Math.floor((now - (slot.plantedAt || now)) / stageSec));
        if (want > slot.stage) { slot.stage = want; changed = true; }
      } else {
        slot.plantedAt = now; // 冻结在 stage 2, 等补肥
      }
      continue;
    }
    const want = Math.min(3, 1 + Math.floor((now - (slot.plantedAt || now)) / stageSec));
    while (want > slot.stage) {
      // stage 1→2 不吸收堆肥 (种子自身养分); stage 2→3 需吸收一格
      if (slot.stage >= 2) {
        const idx = boxes.findIndex((v) => v > 0);
        if (idx < 0) break; // 堆肥耗尽: 冻结在当前阶
        boxes[idx] = 0;   // 吸收一格 (物品腐烂成养分)
      }
      slot.stage += 1;
      changed = true;
    }
  }
  return changed;
}

/** furniture_load_flowerpot 载荷: show_list/list/plant_list 三字段必齐 */
function flowerpotPayload(s) {
  const fp = s.flowerpot || { slots: [], grown: [] };
  return {
    show_list: [{ type: 1, id: FLOWERPOT_ID }],
    list: [],
    plant_list: (fp.slots || []).map((slot, i) => ({
      type: 1,
      index: i + 1,
      id: slot.id || 0,
      stage: slot.stage || 0,
    })),
  };
}

/**
 * 收获 (furniture_flowerpot_harvest {index}, 1-based):
 * 仅 stage>=3 可收; 产物按植物物种固定映射 (种什么收什么) ×1~2, 入 house
 * (蔬菜记特产图鉴, 花类只记花园图鉴 grown);
 * 槽位清空 (下轮 tick 自动重新播种)。
 * @returns {{item_list: [{item_id, num}]}} 失败返回空对象 (客户端静默)
 */
function harvest(s, index) {
  const fp = s.flowerpot || { slots: [], grown: [] };
  const slot = (fp.slots || [])[Number(index) - 1];
  if (!slot || !slot.id) return {};
  if ((slot.stage || 0) < 3) return {};
  const grownPlant = slot.id;
  const itemId = plantHarvestId(grownPlant);
  const num = 1 + (Math.random() < 0.3 ? 1 : 0);
  // 物种记录 (花园图鉴)
  if (!fp.grown) fp.grown = [];
  if (fp.grown.indexOf(grownPlant) === -1) fp.grown.push(grownPlant);
  require("./ency").onPlantHarvest(s, grownPlant); // 花图鉴: 收获变体解锁条目
  slot.id = 0;
  slot.stage = 0;
  slot.plantedAt = 0;
  // 产出入库 + 图鉴 (特产才记 specialtys; 花类插花物品走花园图鉴 fp.grown)
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += num;
  else s.items.house.push({ item_id: itemId, count: num });
  if (SPECIALTY_IDS.has(itemId)
    && s.handbook && s.handbook.specialtys && s.handbook.specialtys.indexOf(itemId) === -1) {
    s.handbook.specialtys.push(itemId);
  }
  return { item_list: [{ item_id: itemId, num }] };
}

module.exports = {
  flowerpotTick, flowerpotPayload, harvest, plantHarvestId,
  FLOWERPOT_ID, FLOWER_PLANTS, PLANT_STAGE_SEC,
};
