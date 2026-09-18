/**
 * 祈愿/手工引擎 (HandCraft: 木片拼接 + 愿望牌制作)
 *
 * 官方语义 (main.min.js HandCraftModel/BoxCraftView/PrayCraftDetailRender 逆向):
 *   - pray_load_grays 载荷 = {wishs, stamps, boxes, wish_new, stamp_new}
 *     · wish_new  正在制作的愿望牌 (蛙旅行中制作): {content, stamp, stamp_state,
 *       make_time, stamp_time} —— PrayCraftDetailRender 读 content→PrayCraftNoteDB
 *       (prayNoteData 愿望纸条 35 种), stamp→StampCraftDB (stampData 印章 27 种,
 *       stamp_state 取 pattern_pic[state 下标]); make_time/stamp_time 为红点与
 *       落款日期
 *     · wishs    已归档的愿望牌列表
 *     · 红点 PRAY_CRAFT: 蛙外出(getFrogStatus()==1) 且 now>make_time 且未确认
 *   - 木片 (Item type16 COMPOSE: 8501/8502/8503 三种 sub_type): 物品栏木片上的
 *     「拼接」按钮开 BoxCraftView, 三种各>=1 时自动 send pray_compose{ComposeId}
 *     · ComposeId=5502 (物品「木制护符的三拼技巧」, Define 常量)
 *     · 响应 {item_list} 逐条弹 ItemRewardView "获得物品，由勤劳蛙蛙手工拼成"
 *   - pray_confirm_make_box: 关闭 BoxCraftShowView 时确认领取 boxes (物品 id 数组)
 *   - stamps/stamp_new (印章制作线) 官方服务器黑盒无抓包, 恒空不下发 (不自创)
 *
 * 离线语义 (服务器权威, 官方无公开数据处已注明):
 *   - 木片来源: 旅行归来 25% 带回 1 枚随机木片 (官方来源未知; 木片在表中无商店/
 *     任务获取途径, 旅行掉落是唯一自洽闭环)
 *   - 拼接产物: 紫檀木护符 1306 (type1 护身符, spend=1 单程消耗, 与"木制护符"
 *     三拼技巧文案一致)
 *   - 愿望牌: 出门 60% 开始制作 (content/stamp 随机), 途中 make_time 完成,
 *     回家归档进 wishs (上限 12 张, 最早的挤掉)
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const NOTE_IDS = Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "HandCraft", "prayNoteData.json"), "utf-8")))
  .map((r) => Number(r.id));
const STAMP_IDS = Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "HandCraft", "stampData.json"), "utf-8")))
  .map((r) => Number(r.id));

const COMPOSE_ID = 5502;          // Define.ComposeId (官方常量)
const CHIP_IDS = [8501, 8502, 8503]; // 木制护符 1/2/3 号木片 (type16 sub_type 1-3)
const AMULET_ID = 1306;           // 紫檀木护符 (拼接产物)
const CHIP_DROP_CHANCE = 0.25;    // 旅行带回木片概率 (离线自定)
const WISH_CHANCE = 0.6;          // 出门制作愿望牌概率 (离线自定)
const WISHS_MAX = 12;

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function chance(p) {
  return Math.random() < p;
}

/** s.pray = {wish_new: null|{...}, wishs: []} (懒建档) */
function node(s) {
  if (!s.pray) s.pray = { wish_new: null, wishs: [] };
  return s.pray;
}

/** pray_load_grays 载荷 (模型整字段读取, 缺字段会污染列表) */
function payload(s) {
  const p = s.pray || {};
  return {
    wishs: (p.wishs || []).slice(),
    stamps: [],
    boxes: [],
    wish_new: p.wish_new || null,
    stamp_new: null,
  };
}

/** 出门钩子: 60% 开始制作一张愿望牌 (content 愿望纸条 + stamp 印章随机) */
function onDepart(s, now) {
  const p = node(s);
  if (p.wish_new || !chance(WISH_CHANCE)) return;
  p.wish_new = {
    content: NOTE_IDS[randInt(0, NOTE_IDS.length - 1)],
    stamp: STAMP_IDS[randInt(0, STAMP_IDS.length - 1)],
    stamp_state: randInt(1, 3),
    make_time: now + randInt(1800, 4 * 3600), // 途中完成 (红点要求蛙仍在外)
    stamp_time: now,
  };
}

/** 回家钩子: 归档完成的愿望牌; 返回 true 表示载荷变化 (调用方推 pray_load_grays) */
function onReturn(s) {
  const p = node(s);
  if (!p.wish_new) return false;
  p.wishs.unshift(p.wish_new);
  p.wishs = p.wishs.slice(0, WISHS_MAX);
  p.wish_new = null;
  return true;
}

/** 旅行奖励: 25% 带回 1 枚随机木片 (离线自定的木片来源) */
function rollChip() {
  return chance(CHIP_DROP_CHANCE) ? CHIP_IDS[randInt(0, CHIP_IDS.length - 1)] : -1;
}

function houseCount(s, id) {
  const row = s.items.house.find((x) => x.item_id === id);
  return row ? row.count : 0;
}
function addHouse(s, id, n) {
  const row = s.items.house.find((x) => x.item_id === id);
  if (row) row.count += n;
  else if (n > 0) s.items.house.push({ item_id: id, count: n });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
}

/**
 * 拼接 (pray_compose {id}): 官方 ComposeId=5502; 三种木片各>=1 → 各消耗 1 枚,
 * 得紫檀木护符 ×1。返回 {code, item_list} (客户端按 item_list 逐条弹奖励)。
 */
function compose(s, id) {
  if (Number(id) !== COMPOSE_ID) return { code: 1, item_list: [] };
  if (!CHIP_IDS.every((c) => houseCount(s, c) >= 1)) return { code: 1, item_list: [] };
  CHIP_IDS.forEach((c) => addHouse(s, c, -1));
  addHouse(s, AMULET_ID, 1);
  return { code: 0, item_list: [{ item_id: AMULET_ID, count: 1 }] };
}

module.exports = {
  COMPOSE_ID, CHIP_IDS, AMULET_ID, NOTE_IDS, STAMP_IDS,
  payload, onDepart, onReturn, rollChip, compose,
};
