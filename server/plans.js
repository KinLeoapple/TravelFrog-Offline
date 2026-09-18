/**
 * 周期计划 (taskData.json list_map/list_type): 是日清单/当周/半月/月度/当季/年度
 *
 * 客户端契约 (main.min.js GuideTaskModel/GuideTaskView 逆向):
 *   task_load {list: [{id, pro}]}        —— 周期任务进度 (dataList)
 *   task_load_list {reward: [{id, pro}]} —— 各计划已领档位 (dataReward)
 *   task_get_list_reward {id: 100*计划type + 档位} → code 0 (奖励由服务端推送)
 *   伴蛙前行横幅: list 中 pro < count 的任务轮播标题; 空 → "计划都达成了~"
 *   红点: 完成数达到下一档 target 且未领 → GUIDE_TASK_LIST
 *
 * 结构: 每计划 type 池大小恰等于最大 target (3/5/6/12/11/30) —— 全池展示,
 * 完成 K 项解锁第 K 档奖励, 无需选任务。进度按周期清零 (本地时间):
 *   1 日 2 周(周一起) 3 半月(1/16日) 4 月 5 季 6 年
 */
const fs = require("fs");
const path = require("path");
const photo = require("./photo");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const TASK_DATA = JSON.parse(fs.readFileSync(path.join(CFG, "Task", "taskData.json"), "utf-8"));
const LIST_MAP = TASK_DATA.list_map;          // id → {id, type(1-6), count, title}
const LIST_TYPE = TASK_DATA.list_type;        // 计划type → {name, reward[], target[]}
const FURNI_TYPE = new Map(                    // 家具 id → type (1-27)
  Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "Furnitur", "furnitureData.json"), "utf-8")))
    .map((f) => [Number(f.id), Number(f.type)])
);

// ---------- 周期键 (本地时间) ----------
function periodKey(type, now) {
  const d = new Date(now * 1000);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const p2 = (n) => String(n).padStart(2, "0");
  switch (type) {
    case 1: return `${y}-${p2(m)}-${p2(day)}`;                     // 日
    case 2: {                                                      // 周 (周一起)
      const mon = new Date(y, m - 1, day - ((d.getDay() + 6) % 7));
      const jan1 = new Date(mon.getFullYear(), 0, 1);
      const week = Math.floor((mon - jan1) / 604800000) + 1;
      return `${mon.getFullYear()}-W${p2(week)}`;
    }
    case 3: return `${y}-${p2(m)}-${day <= 15 ? "H1" : "H2"}`;     // 半月
    case 4: return `${y}-${p2(m)}`;                                // 月
    case 5: return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;         // 季
    default: return `${y}`;                                        // 年
  }
}

// ---------- 任务定义 (match 谓词过滤事件参数; 祈愿/博物馆未实现的任务 501-511 恒 0) ----------
const lunchTrip = (id) => ({ ev: "depart", match: (o) => o.lunch === id });
const DEFS = {
  101: { ev: "depart", match: (o) => o.lunch > 0 },   // 出门随便逛逛: 带便当出门
  102: { ev: "photoGoal" },                           // 有目标一定能到达: 目的地照
  103: { ev: "photoNewPlace" },                       // 去看更大的世界: 新地点照片
  201: { ev: "guestFeed" },                           // 跟邻居打个招呼: 投喂小伙伴
  202: { ev: "cloverHarvest" },                       // 等一片草原: 收 100 株三叶草
  203: { ev: "decorate" },                            // 学着浪漫一点: 插花
  204: { ev: "letterSelf" },                          // 给自己寄一封信 (兑换码"给自己的信")
  205: lunchTrip(1),                                  // 草莓可丽饼出门
  301: { ev: "buyTool" },                             // 商店买旅行道具
  302: lunchTrip(2),                                  // 沙拉皮塔饼
  303: lunchTrip(3),                                  // 茄汁蛋包饭
  304: { ev: "depart", match: (o) => o.bagFull },     // 装满背包出发 (4 格)
  305: { ev: "depart", match: (o) => o.deskFull },    // 桌上便当/护符/道具放满
  306: { ev: "noteRead" },                            // 阁楼书桌看笔记
  401: { ev: "storyGift" },                           // 小仓库-故事小红心 (给故事送礼)
  402: { ev: "giftStore" },                           // 照片/特产收入礼品盒
  403: { ev: "partyAttend" },                         // 邻居聚会 (买绘本发起)
  404: { ev: "guestFeed", match: (o) => o.guest === 0 }, // 投喂困困
  405: { ev: "guestFeed", match: (o) => o.guest === 1 }, // 投喂胖胖
  406: { ev: "guestFeed", match: (o) => o.guest === 2 }, // 投喂跳跳
  407: { ev: "calendarClaim" },                       // 日历领取时令奖励
  408: lunchTrip(4),                                  // 香葱烤包子 → 西部
  409: lunchTrip(5),                                  // 海苔煎豆腐 → 沿海
  410: lunchTrip(15),                                 // 桂花蒸米糕 → 江南
  411: lunchTrip(16),                                 // 彩椒烙蛋饼 → 北方
  412: lunchTrip(33),                                 // 水果沙拉 → 山区
  601: { ev: "materialGain" },                        // 材料带回家 x5
  629: { ev: "craftTumbler" },                        // 学会制作不倒翁
  630: { ev: "craftCompost" },                        // 学会制作堆肥箱
};
for (let t = 1; t <= 27; t++) {                        // 602-628: 学会各族家具制作
  DEFS[601 + t] = { ev: "craftType", match: (o) => o.ftype === t };
}

/** 惰性周期滚动: 过期 type 的进度/领奖清零 */
function ensureState(s, now) {
  if (!s.plans) s.plans = { key: {}, prog: {}, claimed: {} };
  const p = s.plans;
  if (!p.key) { p.key = {}; p.prog = p.prog || {}; p.claimed = p.claimed || {}; }
  for (const type of Object.keys(LIST_TYPE)) {
    const k = periodKey(Number(type), now);
    if (p.key[type] === k) continue;
    p.key[type] = k;
    for (const t of Object.values(LIST_MAP)) {
      if (String(t.type) === type) delete p.prog[t.id];
    }
    p.claimed[type] = 0;
  }
  return p;
}

/** 进度事件入口: 匹配任务并累加 (cap 在 count)。
 *  push 给定时进度变化实时推 task_load —— 客户端横幅/面板/红点立即刷新,
 *  否则要重新登录才可见 (交互缺陷); taskMod 懒加载避循环依赖 */
function event(s, name, opts, push) {
  const now = Math.floor(Date.now() / 1000);
  const p = ensureState(s, now);
  const o = opts || {};
  let changed = false;
  for (const idStr of Object.keys(DEFS)) {
    const def = DEFS[idStr];
    if (def.ev !== name) continue;
    if (def.match && !def.match(o)) continue;
    const meta = LIST_MAP[idStr];
    if (!meta) continue;
    const cur = p.prog[Number(idStr)] || 0;
    if (cur >= meta.count) continue;
    p.prog[Number(idStr)] = Math.min(meta.count, cur + (o.delta || 1));
    changed = true;
  }
  if (changed && push) {
    push("task_load", {
      tasks: require("./task").payload(s).tasks,
      list: listPayload(s),
    });
  }
  return changed;
}

/** 出门快照: 便当/背包/桌子状态 (travel.js departFrog 调用) */
function onDepart(s, plan, push) {
  const desk = s.items.desk || [];
  const deskTypes = new Set(desk.filter((v) => v > 0).map((v) => itemType(v)));
  event(s, "depart", {
    lunch: plan.lunchId > 0 ? plan.lunchId : -1,
    bagFull: (plan.carried || []).length >= 4,
    deskFull: desk.length >= 8 && !desk.includes(-1)
      && deskTypes.has(0) && deskTypes.has(1) && deskTypes.has(2),
  }, push);
}

/** 回家快照: 目的地照/新地点/材料 (travel.js returnFrog 在照片入桶前调用) */
function onReturn(s, rewards, push) {
  const owned = new Set(
    [].concat(s.pictures || [], s.albumPending || [], s.giftPictures || [], s.albumDeleted || [])
      .map((p) => Number(p.pic_id))
  );
  const places = new Set();
  for (const id of owned) {
    const r = photo.PICTURE_DB.get(id);
    if (r && r.place) places.add(r.place);
  }
  for (const pic of rewards.pictures || []) {
    if (owned.has(Number(pic))) continue;
    const row = photo.PICTURE_DB.get(Number(pic));
    if (!row) continue;
    if (row.type === "Goal") event(s, "photoGoal", null, push);
    if (row.place && !places.has(row.place)) event(s, "photoNewPlace", null, push);
  }
  for (const id of rewards.items || []) {
    if (itemType(id) === 16) event(s, "materialGain", null, push);
  }
}

// 物品类型懒查 (独立加载, 避免与 travel.js 循环依赖)
let ITEM_TYPE_MAP = null;
function itemType(id) {
  if (!ITEM_TYPE_MAP) {
    const t = JSON.parse(fs.readFileSync(path.join(CFG, "MainData", "Item.json"), "utf-8"));
    ITEM_TYPE_MAP = new Map((Array.isArray(t) ? t : Object.values(t)).map((i) => [Number(i.id), Number(i.type)]));
  }
  return ITEM_TYPE_MAP.get(Number(id));
}

/** 制作完工 (furni.js craftTick): kind=furniture|tumbler|pocket, fid=产物id */
function onCraft(s, kind, fid, push) {
  if (kind === "tumbler") return event(s, "craftTumbler", null, push);
  if (kind === "pocket") return;
  const ftype = FURNI_TYPE.get(Number(fid));
  if (ftype) event(s, "craftType", { ftype }, push);
}

/** 当前周期某计划的完成数 */
function completeNum(s, type) {
  const now = Math.floor(Date.now() / 1000);
  const p = ensureState(s, now);
  let n = 0;
  for (const t of Object.values(LIST_MAP)) {
    if (String(t.type) !== String(type)) continue;
    if ((p.prog[t.id] || 0) >= t.count) n++;
  }
  return n;
}

/** task_load.list 载荷 (全池任务 + 当前周期进度, pro 封顶 count) */
function listPayload(s) {
  const now = Math.floor(Date.now() / 1000);
  const p = ensureState(s, now);
  return Object.values(LIST_MAP).map((t) => ({ id: t.id, pro: Math.min(p.prog[t.id] || 0, t.count) }));
}

/** task_load_list.reward 载荷 (各计划已领档位) */
function rewardPayload(s) {
  const now = Math.floor(Date.now() / 1000);
  const p = ensureState(s, now);
  return Object.keys(LIST_TYPE).map((type) => ({ id: Number(type), pro: p.claimed[type] || 0 }));
}

/** 领档校验 + 发放; @returns {{ok, item?}} 奖励物品 id (各档 x1) */
function claim(s, id) {
  const now = Math.floor(Date.now() / 1000);
  const p = ensureState(s, now);
  const type = Math.floor(Number(id) / 100);
  const tier = Number(id) % 100;
  const plan = LIST_TYPE[String(type)];
  if (!plan || tier < 1 || tier > plan.target.length) return { ok: false };
  if ((p.claimed[type] || 0) !== tier - 1) return { ok: false };          // 必须按档领
  if (completeNum(s, type) < plan.target[tier - 1]) return { ok: false }; // 完成数不足
  p.claimed[type] = tier;
  return { ok: true, item: plan.reward[tier - 1] };
}

module.exports = { event, onDepart, onReturn, onCraft, listPayload, rewardPayload, claim, completeNum, LIST_TYPE };
