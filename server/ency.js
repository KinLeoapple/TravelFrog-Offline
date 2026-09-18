/**
 * 图鉴引擎 (Ency: 旅行食物图鉴 encytravel + 花图鉴 encyclopedia)
 *
 * 官方语义 (main.min.js EncyModel/EncyView 逆向):
 *   - encyclopedia_load 载荷 = {unlock_list, unlock_desc, show_sub}
 *     · unlock_list  已解锁条目 long_id 数组 (客户端自行升序排序)
 *       - encytravel.list: {long_id:10010001, id:1001(条目), item_id:0(物品),
 *         name:华夫饼, sub_id, sub_name:奶油华夫饼, tab} —— 159 行, item_id 一一对应
 *       - encyclopedia.list: {long_id:1010101, id:101(物种), sub_id(色变体),
 *         name:角堇, sub_name:火龙果, tab} —— 241 行, 与花盆植物名
 *         ("角堇·火龙果", flowerpotData.plant) 按 物种·变体 匹配
 *     · unlock_desc  [{id: 条目id, list: [已解锁段号]}] —— 条目描述 2~5 段,
 *       段号对应 desc 表的键 (1=目科属/获得途径, 2..=习性/花语...), 逐级解锁
 *     · show_sub     [{id: 条目id, sub_id: 值}] —— 展示变体选择; 注意客户端
 *       getShowSubItems 把 show_sub 的值直接当 list 键用 (n[i[r]]), 故此处的
 *       sub_id 字段承载的是 long_id (客户端本地设置时也是存 long_id)
 *   - encyclopedia_set_show_sub {id: long_id}: 选择展示变体
 *   - isOpen(): unlock_list 非空才显示图鉴入口
 *
 * 离线语义 (服务器权威; 官方解锁阈值未知, 已注明):
 *   - 食物: 作为便当携带出门 1 次 = 解锁条目; 携带次数 1/2/4/7/11 解锁第 1..5 段
 *   - 花: 花盆收获该变体 = 解锁; 同物种收获次数 1/2/4/7/11 解锁第 1..5 段
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
function readJSON(p) {
  return JSON.parse(fs.readFileSync(path.join(CFG, p), "utf-8"));
}
const ENCY = readJSON("Ency/encyclopedia.json");   // 花
const ENCY_TRAVEL = readJSON("Ency/encytravel.json"); // 旅行食物
const FP_PLANT = readJSON("Furnitur/flowerpotData.json").plant || {};

/** item_id → encytravel 行 */
const FOOD_ROW = new Map(Object.values(ENCY_TRAVEL.list).map((r) => [Number(r.item_id), r]));
/** encyclopedia.list: long_id → 行 */
const PLANT_BY_LONG = new Map(Object.values(ENCY.list).map((r) => [Number(r.long_id), r]));
/** 植物 id → encyclopedia 行 (按 "物种名·变体名" 匹配) */
const PLANT_ROW = new Map(
  Object.values(FP_PLANT).map((p) => {
    const name = String(p.name || "");
    const dot = name.indexOf("·");
    if (dot <= 0) return [Number(p.id), null];
    const species = name.slice(0, dot), sub = name.slice(dot + 1);
    const row = Object.values(ENCY.list).find((r) => r.name === species && r.sub_name === sub) || null;
    return [Number(p.id), row];
  }).filter(([, row]) => row != null)
);

/** 描述段解锁阈值 (携带/收获次数 → 第 k 段) */
const STEP_THRESHOLDS = [1, 2, 4, 7, 11];

/**
 * s.ency = {eat: {itemId: 携带次数}, plants: [long_id], grow: {条目id: 次数},
 *           show: {条目id: long_id}}
 */
function node(s) {
  if (!s.ency) s.ency = { eat: {}, plants: [], grow: {}, show: {} };
  return s.ency;
}

/** 出门钩子: 便当携带 → 食物图鉴解锁/计数 */
function onEatFood(s, lunchId) {
  const row = FOOD_ROW.get(Number(lunchId));
  if (!row) return false;
  const e = node(s);
  e.eat[Number(lunchId)] = (e.eat[Number(lunchId)] || 0) + 1;
  return true;
}

/** 花盆收获钩子: 植物 id → 花图鉴条目解锁 + 物种计数 */
function onPlantHarvest(s, plantId) {
  const hit = PLANT_ROW.get(Number(plantId));
  if (!hit) return false;
  const e = node(s);
  if (!e.plants.includes(hit.long_id)) e.plants.push(hit.long_id);
  e.grow[hit.id] = (e.grow[hit.id] || 0) + 1;
  return true;
}

/** 次数 → 已解锁段号列表 */
function stepsUnlocked(count) {
  const out = [];
  for (let k = 0; k < STEP_THRESHOLDS.length; k++) {
    if (count >= STEP_THRESHOLDS[k]) out.push(k + 1);
  }
  return out;
}

/** encyclopedia_load 载荷 */
function payload(s) {
  const e = node(s);
  const unlock = [];
  const desc = [];
  const descMap = {};
  // 食物
  for (const [itemId, count] of Object.entries(e.eat)) {
    const row = FOOD_ROW.get(Number(itemId));
    if (!row || count <= 0) continue;
    unlock.push(row.long_id);
    descMap[row.id] = Math.max(descMap[row.id] || 0, count);
  }
  // 花 (物种计数来自 grow; plants 只管条目解锁)
  for (const [entryId, count] of Object.entries(e.grow)) {
    descMap[entryId] = Math.max(descMap[entryId] || 0, count);
  }
  for (const longId of e.plants) {
    const row = PLANT_BY_LONG.get(Number(longId));
    if (row) unlock.push(row.long_id);
  }
  // 描述段
  for (const [entryId, count] of Object.entries(descMap)) {
    const list = stepsUnlocked(count);
    if (list.length) desc.push({ id: Number(entryId), list });
  }
  // 展示变体 (sub_id 字段承载 long_id —— 客户端将其当 list 键用)
  const show = Object.entries(e.show).map(([entryId, longId]) => ({
    id: Number(entryId), sub_id: Number(longId),
  }));
  return { unlock_list: unlock, unlock_desc: desc, show_sub: show };
}

/** encyclopedia_set_show_sub {id: long_id}: 校验后记录展示变体 */
function setShowSub(s, longId) {
  const row = PLANT_BY_LONG.get(Number(longId));
  if (!row) return false;
  node(s).show[row.id] = row.long_id;
  return true;
}

module.exports = {
  FOOD_ROW, PLANT_ROW, STEP_THRESHOLDS,
  payload, onEatFood, onPlantHarvest, setShowSub,
};
