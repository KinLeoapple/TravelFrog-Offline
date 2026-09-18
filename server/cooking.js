/**
 * 月度烹饪引擎 (Cooking/cookingData 24 期 + cookingTaskData 8 模板):
 * 每月选主题年份 → 3 个日常任务 → 做满 6 个自动开火 → 领当月节气食物 →
 * 携带该食物旅行必出对应月度照片 (cookingData.pic_id)
 *
 * 官方语义 (main.min.js CookingModel/CookingView/CookTaskListItemRender/CookingThemeView 逆向):
 *   - serverData = {month, month_pro, week, complete, select, refresh_time, task_list}
 *     · month      日历月 1..12 (主题选择器按 month%12 过滤 CookingDB 两年同月条目)
 *     · select     ceil(选中条目.month/12) = 1|2; 0=未选主题 (进厨房先弹主题选择,
 *                  getMonthTheme()<=0 时 checkCookingPopup 拦截进 CookingThemeView)
 *     · selectMonth = month + 12*((select-1)||0) → CookingDB 键 1..24 (展示/领奖口径;
 *                  客户端 requestStartCooking 回调里的 CookingDB.get(getMonth()) 是死代码,
 *                  addHouseItem 为空 stub, 真实入包以服务器为准 → 按 selectMonth 发)
 *     · month_pro  当月已完成任务数 (0..task_num=6), 领奖时客户端本地 ++
 *     · complete   当月食物已领 (做满 6 个客户端自动 requestStartCooking)
 *     · refresh_time  下一次 0 点 (倒计时文案 "新任务将于0点后更新"; 日>=22 切
 *                  "下一期活动将于 .. 后更新")
 *     · task_list [{id, pro, complete, refresh?}]  pgb maximum=模板 state, value=pro;
 *                  pro==state 且未 complete → finish 态可领; refresh 标志官方用途
 *                  未明, 恒不置位
 *   - 做满 6 个后任务条目灰化 (enabled=false → normal2), 与玩家 FAQ "任务变灰=做满了" 吻合
 *   - 任务刷新: 条目上的刷新按钮 + ModalConfirm 确认, 无消耗 (官方无扣费逻辑)
 *   - 烹饪入口有硬编码时间门 getCookingActivity(): now>=1693497600 (2023-09, 官方
 *     24 期活动排期结束) 恒返回关闭态 —— 客户端补丁将阈值改 2099 年恢复常开
 *     (js/main.min.js, .bak_before_cooking 备份)
 *   - 官方活动 2021-09~2023-09 共 24 期; 离线按日历月轮转, 当月两个年份主题由玩家选
 *
 * 任务进度事件 (plans.js 同款埋点风格):
 *   loginWeek(1) / ad(2) / guestFeed(3) / cloverGain(4) / depart(5) /
 *   photoGain(6) / gachaRedeem(7) / share(8)
 *   广告任务官方由 adsmgr 广告回调推进 (cooking_look_ad 本客户端从未发送), 离线
 *   无广告 → 该任务只能免费刷新换掉, 与官方任务池保持一致不剔除
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const COOKING_DB = Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "Cooking", "cookingData.json"), "utf-8")));
const TASK_DB = Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "Cooking", "cookingTaskData.json"), "utf-8")));
const TASK_BY_ID = new Map(TASK_DB.map((t) => [Number(t.id), t]));
/** 月度食物 id → 必出照片 pic_id (旅行携带判定) */
const COOKING_PIC = new Map(COOKING_DB.map((r) => [Number(r.item_id), Number(r.pic_id)]));
/** CookingDB 键 (1..24) → 行 */
const MONTH_ROW = new Map(COOKING_DB.map((r) => [Number(r.month), r]));

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function p2(n) {
  return String(n).padStart(2, "0");
}
/** 日历月键 "YYYY-MM" (本地时间) */
function monthKey(now) {
  const d = new Date(now * 1000);
  return d.getFullYear() + "-" + p2(d.getMonth() + 1);
}
/** 周键 (周一起), 每周登录任务用 */
function weekKey(now) {
  const d = new Date(now * 1000);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  const mon = new Date(y, m - 1, day - ((d.getDay() + 6) % 7));
  const jan1 = new Date(mon.getFullYear(), 0, 1);
  const week = Math.floor((mon - jan1) / 604800000) + 1;
  return mon.getFullYear() + "-W" + p2(week);
}
/** 下一个本地 0 点 (秒) */
function nextMidnight(now) {
  const d = new Date(now * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0).getTime() / 1000);
}

// ---------- 状态 ----------
/**
 * s.cooking = {
 *   window: "YYYY-MM",          // 当月窗口键 (跨月重置)
 *   month: 1..12,               // 日历月 (主题选择器过滤口径)
 *   month_pro: 0..6,            // 当月已完成任务数
 *   complete: 0|1,              // 当月食物已领
 *   select: 0|1|2,              // 主题年份 (0=未选)
 *   lastWeek: "YYYY-Wnn",       // 每周登录判定
 *   refresh_time: ts,           // 下一次 0 点
 *   tasks: [{id, pro, complete}] // 当前 3 个任务
 * }
 */
function ensure(s, now) {
  let c = s.cooking;
  if (!c) {
    c = s.cooking = {
      window: monthKey(now),
      month: new Date(now * 1000).getMonth() + 1,
      month_pro: 0, complete: 0, select: 0,
      lastWeek: "", refresh_time: nextMidnight(now),
      tasks: [],
    };
    dealTasks(s);
    return c;
  }
  // 跨月: 重置当月进度, 重发任务 (select 主题选择跨月保留 —— 官方主题弹窗只在
  // getMonthTheme()<=0 即从未选择时出现)
  const key = monthKey(now);
  if (c.window !== key) {
    c.window = key;
    c.month = new Date(now * 1000).getMonth() + 1;
    c.month_pro = 0;
    c.complete = 0;
    c.refresh_time = nextMidnight(now);
    dealTasks(s);
  }
  // 每日 0 点: 当前 3 个任务全部完成 → 发新任务 (未完成的不打断, 进度保留)
  if (now >= c.refresh_time) {
    c.refresh_time = nextMidnight(now);
    if (c.tasks.length && c.tasks.every((t) => t.complete)) dealTasks(s);
  }
  return c;
}

/** 随机发 3 个互不重复的任务模板 (官方池 8 种含广告/分享) */
function dealTasks(s) {
  const c = s.cooking;
  const pool = TASK_DB.map((t) => Number(t.id));
  c.tasks = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    const id = pool.splice(randInt(0, pool.length - 1), 1)[0];
    c.tasks.push({ id, pro: 0, complete: 0 });
  }
}

/** 客户端 serverData 口径 (cooking_load_cooking 响应/推送, 全字段必齐: 模型整替换) */
function payload(s) {
  const c = s.cooking || {};
  return {
    month: c.month || 0,
    month_pro: c.month_pro || 0,
    week: 0, // 客户端视图未使用
    complete: (c.complete || 0) === 1,
    select: c.select || 0,
    refresh_time: c.refresh_time || 0,
    task_list: (c.tasks || []).map((t) => ({
      id: t.id, pro: t.pro, complete: t.complete === 1, refresh: 0,
    })),
  };
}

/** CookingDB 键 (selectMonth) → 行; 未选主题回退当月年-1 主题 */
function monthRow(s) {
  const c = s.cooking;
  if (!c || !c.month) return null;
  const select = c.select || 1;
  return MONTH_ROW.get(c.month + 12 * (select - 1)) || MONTH_ROW.get(c.month) || null;
}

/**
 * 任务进度推进 (事件埋点). 进度变化达到目标时推 cooking_task_update {task}
 * (客户端按 id 整条替换并刷新红点; 未达目标不推 —— 官方红点只认可领任务)
 */
function event(s, name, opts, push) {
  const now = Math.floor(Date.now() / 1000);
  const c = ensure(s, now);
  const o = opts || {};
  let changed = null;
  for (const t of c.tasks) {
    if (t.complete) continue;
    const tpl = TASK_BY_ID.get(t.id);
    if (!tpl || Number(tpl.type) !== TYPE_OF_EVENT[name]) continue;
    if (t.pro >= Number(tpl.state)) continue;
    t.pro = Math.min(Number(tpl.state), t.pro + (o.delta || 1));
    if (t.pro >= Number(tpl.state)) changed = t;
  }
  if (changed && push) {
    push("cooking_task_update", {
      task: { id: changed.id, pro: changed.pro, complete: false, refresh: 0 },
    });
  }
}
const TYPE_OF_EVENT = {
  loginWeek: 1, ad: 2, guestFeed: 3, cloverGain: 4,
  depart: 5, photoGain: 6, gachaRedeem: 7, share: 8,
};

/** 每周登录: 任意服务器接触 (登录链 tick) 即视为本周登录过 */
function tick(s, push) {
  const now = Math.floor(Date.now() / 1000);
  const c = ensure(s, now);
  const wk = weekKey(now);
  if (c.lastWeek !== wk) {
    c.lastWeek = wk;
    event(s, "loginWeek", {}, push);
  }
}

/** 刷新任务: 未完成的任务换成当前列表外的一个随机模板 (官方无消耗) */
function swapTask(s, id) {
  const c = ensure(s, Math.floor(Date.now() / 1000));
  const t = c.tasks.find((x) => x.id === Number(id));
  if (!t || t.complete) return null;
  const used = new Set(c.tasks.map((x) => x.id));
  const pool = TASK_DB.map((x) => Number(x.id)).filter((x) => !used.has(x));
  if (!pool.length) return null; // 8 选 3 不可能耗尽, 兜底
  t.id = pool[randInt(0, pool.length - 1)];
  t.pro = 0;
  t.complete = 0;
  return t;
}

/** 领任务奖励: pro 已达模板 state 才可领; month_pro++ */
function claim(s, id) {
  const c = ensure(s, Math.floor(Date.now() / 1000));
  const t = c.tasks.find((x) => x.id === Number(id));
  if (!t || t.complete) return false;
  const tpl = TASK_BY_ID.get(t.id);
  if (!tpl || t.pro < Number(tpl.state)) return false;
  t.complete = 1;
  c.month_pro++;
  return true;
}

/**
 * 开火烹饪: 做满 task_num 且当月未领 → 发当月节气食物 ×1 入屋。
 * 返回 {item_id, count} 或 null (未满足/已领)。
 */
function startCooking(s) {
  const c = ensure(s, Math.floor(Date.now() / 1000));
  if (c.complete) return null;
  const row = monthRow(s);
  if (!row || c.month_pro < Number(row.task_num)) return null;
  c.complete = 1;
  const itemId = Number(row.item_id);
  const hr = s.items.house.find((x) => x.item_id === itemId);
  if (hr) hr.count += 1;
  else s.items.house.push({ item_id: itemId, count: 1 });
  return { item_id: itemId, count: hr ? hr.count : 1 };
}

/** 旅行奖励 roll 钩子: 携带月度食物 → 必出对应照片 (官方 "月度烹饪食物必出特殊SSR") */
function guaranteedPic(lunchId, owned, pending) {
  const pic = COOKING_PIC.get(Number(lunchId));
  if (!pic) return -1;
  if ((owned || []).some((p) => p.pic_id === pic) || (pending || []).some((p) => p.pic_id === pic)) return -1;
  return pic;
}

module.exports = {
  DB: COOKING_DB,
  TASK_DB,
  COOKING_PIC,
  payload, tick, event, swapTask, claim, startCooking, guaranteedPic,
};
