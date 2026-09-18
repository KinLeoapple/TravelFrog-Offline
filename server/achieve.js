/**
 * 称号系统 (Achieve) — 服务器权威解锁, 官方下发协议
 *
 * 官方语义 (main.min.js 逆向确认):
 *   - 无独立 title_load: 称号数据随 client_load_role.frog 下发三字段
 *     cur_achieve(佩戴中 id) / achieves(已解锁 id 数组) /
 *     achieves_time([{id, time}] 限时称号过期秒级时间戳, 0/缺失=永久)
 *   - client_set_achieve [["id"],!1] 不带 session 无回复: 客户端本地先改
 *     useAchieveID 并 dispatch updateAchieveID, 服务器只需存档
 *   - 解锁判定全在服务器; 会话内不推送任何称号更新 (官方靠下次登录
 *     checkNewAchieve 对比本地缓存弹「恭喜获得称号」)
 *   - is_special=1 (900-902) 通过道具解锁: Item 203001-203027
 *     「蛙选之人/明星小蛙/蛙界艺术家 · N天」, 时长即 achieves_time 过期秒
 *
 * 解锁时机 (调用方):
 *   travelTick 尾部兜底 / returnFrog (旅行次数+短途) / departFrog (便当连击) /
 *   addItem (道具称号) / item_gacha (抽奖计数) / load_all_info (登录天数)
 */
const fs = require("fs");
const path = require("path");
const cfg = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "resource", "China", "config", p), "utf-8"));

const ACHIEVE_TABLE = (() => {
  const t = cfg("MainData/Achieve.json");
  const map = new Map();
  for (const row of Array.isArray(t) ? t : Object.values(t)) map.set(Number(row.id), row);
  return map;
})();

const ITEM_ARR = (() => {
  const t = cfg("MainData/Item.json");
  return Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]);
})();
const ITEM_BY_NAME = new Map(ITEM_ARR.filter((i) => i && i.name).map((i) => [i.name, Number(i.id)]));
// 称号 info 文本物品名 → Item.json 实际名 (个别名字两表不一致)
const NAME_ALIAS = { "苏州西瓜子": "西瓜子", "桃子": "蜜桃", "莜面": "莜面栲栳栳" };

// 特产 (type3) 总数 — 「获得所有特产食材」
const SPECIALTY_TOTAL = ITEM_ARR.filter((i) => i && Number(i.type) === 3).length;

// 「果汁」= 苹果汁 (id 14): 连续 4 次带果汁出发
const JUICE_LUNCH_ID = ITEM_BY_NAME.get("苹果汁") || 14;

/** 数量类条件: itemId → [{achieveId, count}] — 从 info「X超过N个」正则解析 */
const COUNT_RULES = (() => {
  const rules = new Map();
  for (const [id, row] of ACHIEVE_TABLE) {
    const m = /^(.+)超过(\d+)个$/.exec(row.info || "");
    if (!m) continue;
    const itemId = ITEM_BY_NAME.get(NAME_ALIAS[m[1]] || m[1]);
    if (itemId == null) { console.warn(`[achieve] 物品名未匹配: ${m[1]} (称号 ${id})`); continue; }
    if (!rules.has(itemId)) rules.set(itemId, []);
    rules.get(itemId).push({ achieveId: id, count: Number(m[2]) });
  }
  return rules;
})();

/** 道具称号: itemId → {achieveId, days} (蛙选之人/明星小蛙/蛙界艺术家 · N天) */
const TICKET_ACHIEVE = (() => {
  // 203001-203007=蛙选之人(900), 203011-203017=明星小蛙(901), 203021-203027=蛙界艺术家(902)
  const map = new Map();
  for (const it of ITEM_ARR) {
    const m = /^2030(\d)\d$/.exec(String(it.id));
    if (!m) continue;
    const kind = { 0: 900, 1: 901, 2: 902 }[Number(m[1])];
    if (kind == null) continue;
    const daysM = /(\d+)天$/.exec(it.name || "");
    if (!daysM) continue;
    map.set(Number(it.id), { achieveId: kind, days: Number(daysM[1]) });
  }
  return map;
})();

const DAY_BASE = 946656000; // 客户端 core.BaseTime (同 handlers.js)
const utcDay = (ts) => Math.floor((ts - DAY_BASE) / 86400);

/** stats 节点兜底 (旧档迁移) */
function node(s) {
  if (!s.stats) s.stats = { loginDays: 0, lastLoginDay: 0, gachaCount: 0, lunchHistory: [] };
  if (!Array.isArray(s.stats.lunchHistory)) s.stats.lunchHistory = [];
  return s.stats;
}

/** 解锁 (无过期): 已解锁则幂等 */
function grant(s, id) {
  if (s.frog.achieves.includes(id)) return false;
  s.frog.achieves.push(id);
  return true;
}

/** 道具称号激活 (限时): 重复获得时长叠加 */
function grantTimed(s, achieveId, days, now) {
  const f = s.frog;
  let entry = (f.achieves_time || []).find((x) => Number(x.id) === achieveId);
  if (!entry) {
    entry = { id: achieveId, time: now + days * 86400 };
    if (!Array.isArray(f.achieves_time)) f.achieves_time = [];
    f.achieves_time.push(entry);
  } else {
    const remain = Math.max(0, Number(entry.time) || 0);
    entry.time = (remain > now ? remain : now) + days * 86400;
  }
  if (!f.achieves.includes(achieveId)) f.achieves.push(achieveId);
}

/** 过期清理: 限时称号到期移除, 佩戴中的重置为默认 */
function sweepTimed(s, now) {
  const f = s.frog;
  if (!Array.isArray(f.achieves_time) || !f.achieves_time.length) return;
  const alive = f.achieves_time.filter((x) => Number(x.time) > now);
  if (alive.length === f.achieves_time.length) return;
  const dead = new Set(f.achieves_time.filter((x) => Number(x.time) <= now).map((x) => Number(x.id)));
  f.achieves_time = alive;
  f.achieves = f.achieves.filter((id) => !dead.has(id));
  if (dead.has(Number(f.cur_achieve))) f.cur_achieve = 0;
}

/** 持有量统计 (house + bag + desk): 一次遍历喂所有数量类条件 */
function countOwned(s) {
  const counts = new Map();
  for (const row of s.items.house || []) {
    counts.set(Number(row.item_id), (counts.get(Number(row.item_id)) || 0) + Number(row.count || 0));
  }
  for (const id of [...(s.items.bag || []), ...(s.items.desk || [])]) {
    if (id != null && id !== -1) counts.set(Number(id), (counts.get(Number(id)) || 0) + 1);
  }
  return counts;
}

/**
 * 全量解锁检查 (幂等, 逐条 grant)
 * @param {object} ctx 时机上下文 { tripWindow } — returnFrog 时传入本次旅行时长秒
 * @returns {boolean} 是否有新解锁 (调用方据此存档)
 */
function check(s, now, ctx) {
  const f = s.frog;
  if (!f.achieves) f.achieves = [];
  if (!Array.isArray(f.achieves_time)) f.achieves_time = [];
  const stats = node(s);
  const before = f.achieves.length + f.achieves_time.length;
  sweepTimed(s, now);

  grant(s, 0); // 默认称号

  // 旅行次数 10/25/50/100
  const trips = s.travel.tripCount || 0;
  if (trips >= 10) grant(s, 1);
  if (trips >= 25) grant(s, 2);
  if (trips >= 50) grant(s, 3);
  if (trips >= 100) grant(s, 20);

  // 特产图鉴 20/30/40 + 全图鉴
  const spN = (s.handbook.specialtys || []).length;
  if (spN >= 20) grant(s, 17);
  if (spN >= 30) grant(s, 18);
  if (spN >= 40) grant(s, 19);
  if (spN >= SPECIALTY_TOTAL) grant(s, 6);

  // 纪念品 5/10/15/20
  const coN = (s.handbook.collections || []).length;
  if (coN >= 5) grant(s, 13);
  if (coN >= 10) grant(s, 14);
  if (coN >= 15) grant(s, 15);
  if (coN >= 20) grant(s, 16);

  // 三叶草 / 抽奖 / 便当连击
  if (s.res.clover_point > 100000) grant(s, 9);
  if (stats.gachaCount >= 20) grant(s, 10);
  const lh = stats.lunchHistory;
  if (lh.length >= 4 && lh.every((id) => Number(id) === JUICE_LUNCH_ID)) grant(s, 11);

  // 登录天数 60/100/180/280/360
  if (stats.loginDays >= 60) grant(s, 21);
  if (stats.loginDays >= 100) grant(s, 22);
  if (stats.loginDays >= 180) grant(s, 23);
  if (stats.loginDays >= 280) grant(s, 71);
  if (stats.loginDays >= 360) grant(s, 72);

  // 数量类 (一次遍历)
  const counts = countOwned(s);
  for (const [itemId, rules] of COUNT_RULES) {
    const have = counts.get(itemId) || 0;
    for (const r of rules) if (have >= r.count) grant(s, r.achieveId);
  }

  // 装饰插花: 蜡梅 100 / 木槿 101 (阶段1=花苞, 阶段2=绽放)
  const d = s.furniture && s.furniture.decorate;
  if (d && d.putId) {
    if (d.putId === 100 && d.status >= 1) grant(s, 73);
    if (d.putId === 100 && d.status >= 2) grant(s, 74);
    if (d.putId === 101 && d.status >= 1) grant(s, 79);
    if (d.putId === 101 && d.status >= 2) grant(s, 80);
  }

  // 24 小时未归 (旅行中判定)
  if (f.status === 1 && now - (s.travel.departAt || 0) >= 86400) grant(s, 8);
  // 出发不到 30 分钟就回家 (returnFrog 时机传入)
  if (ctx && ctx.tripWindow != null && ctx.tripWindow < 1800) grant(s, 7);

  // 典藏 (博物馆) 4/8/12/20 — 已归档照片数
  const picN = (s.pictures || []).length;
  if (picN >= 4) grant(s, 82);
  if (picN >= 8) grant(s, 83);
  if (picN >= 12) grant(s, 84);
  if (picN >= 20) grant(s, 85);

  // 节日: 六一期间 (6.1~6.7) / 周年庆 (12 月) 登录
  const dt = new Date((now + 8 * 3600) * 1000); // UTC+8 北京时间
  if (dt.getUTCMonth() === 5 && dt.getUTCDate() >= 1 && dt.getUTCDate() <= 7) grant(s, 78);
  if (dt.getUTCMonth() === 11) grant(s, 87);

  return f.achieves.length + f.achieves_time.length !== before;
}

/** 登录: 跨天递增 loginDays + 全量检查 */
function onLogin(s, now) {
  const stats = node(s);
  const day = utcDay(now);
  if (day !== stats.lastLoginDay) {
    stats.lastLoginDay = day;
    stats.loginDays += 1;
  }
  return check(s, now);
}

/** 出门: 记录便当连击史 (连续 4 次果汁) */
function onDepart(s, lunchId) {
  const stats = node(s);
  stats.lunchHistory.push(Number(lunchId));
  if (stats.lunchHistory.length > 4) stats.lunchHistory.shift();
}

/** 物品入包: 道具称号 (蛙选之人等 2030xx) 即时激活 */
function onItemGain(s, itemId, now) {
  const t = TICKET_ACHIEVE.get(Number(itemId));
  if (t) grantTimed(s, t.achieveId, t.days, now || Math.floor(Date.now() / 1000));
}

/** 抽奖计数 */
function onGacha(s) {
  node(s).gachaCount += 1;
}

module.exports = {
  ACHIEVE_TABLE, SPECIALTY_TOTAL, COUNT_RULES, TICKET_ACHIEVE, JUICE_LUNCH_ID,
  node, grant, grantTimed, check, onLogin, onDepart, onItemGain, onGacha,
};
