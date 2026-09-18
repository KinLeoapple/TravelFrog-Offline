/**
 * 协议处理器 (M1: 登录链 + 状态推送 + 庭院基础)
 *
 * 线格式 (来自 main.min.js SocketManage 逆向):
 *   请求: {session, timestamp, cmd: "hall.login", data: {...}}
 *   响应: {session, data: {code: 0, ...}}     -> 回填请求回调 + 模型事件
 *   推送: {cmd: "clover_load_clovers", data}   -> 直接触发模型事件
 */
const saveMod = require("./save");
const travel = require("./travel");
const guestMod = require("./guest");
const merchantMod = require("./merchant");
const furniMod = require("./furni");
const flowerpotMod = require("./flowerpot");
const drawingMod = require("./drawing");
const decorationMod = require("./decoration");
const achieveMod = require("./achieve");
const taskMod = require("./task");
const storyMod = require("./story");
const eggMod = require("./egg");
const plansMod = require("./plans");
const museumMod = require("./museum");
const cookingMod = require("./cooking");
const prayMod = require("./pray");
const encyMod = require("./ency");
const animpicMod = require("./animpic");
const fs = require("fs");
const path = require("path");

// 商店表: config/ShopData/shopData.json (id=货架位, itemId/price/limit/before_buy)
const SHOP = new Map(
  JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "resource", "China", "config", "ShopData", "shopData.json"), "utf-8"
  )).map((x) => [x.id, x])
);

/** 商店限购状态: 客户端 purchasedMap 按货架位 id 记 (响应字段名 item_id 实为 slot id) */
function shopInfoPayload(s) {
  return {
    purchased: Object.entries(s.items.purchased)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ item_id: Number(id), count: n })),
  };
}

/** 全量状态推送 (hall_enter_game 后客户端 load_all_info 触发)
 *  对齐 offline-v2 BOOT_PUSH: 官方在登录后推送全部模型数据 —— 客户端的
 *  这些 cmd 只在 addProtocolCallback 注册, 从不主动 send, 漏推哪个哪个模型
 *  就恒空 (如 item_load_shop_info 漏推 → purchasedMap 空 → 商店限购失效) */
function pushAllState(ctx) {
  const s = ctx.save;
  const push = ctx.push;
  // --- 核心角色数据 ---
  push("client_load_role", travel.rolePayload(s));
  push("client_load_events", s.events);
  push("clover_load_clovers", s.clovers);
  push("item_load_items", travel.itemsPayload(s));
  push("item_load_handbook", travel.handbookPayload(s));
  // 商店限购状态: 客户端 purchasedMap 唯一数据源 (item_load_shop_info 处理器重建),
  // 漏推则已购计数归零 → 限购商品刷新后可重复购买
  push("item_load_shop_info", shopInfoPayload(s));
  push("travel_load_note", { note_list: s.note_list });
  push("travel_load_gift", travel.giftPayload(s));
  push("album_load", {
    pictures: s.pictures.map(travel.withLayers),
    total: s.pictures.length,
    start: 1,
  });
  push("album_load_new", {
    pictures: s.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
    visted_pic: [],
    has_ads: false,
    is_share: false,
  });
  push("story_load", { stories: s.stories, new_story_id: s.new_story_id });
  // 成就任务: 全量进度表 (客户端 GuideTaskModel 以 pro>=count && !is_reward 判可领)
  // list = 周期计划进度 (plans.js): 伴蛙前行横幅轮播未完成任务, 空则误显"计划都达成了"
  push("task_load", { tasks: taskMod.payload(s).tasks, list: plansMod.listPayload(s) });
  push("task_load_list", { reward: plansMod.rewardPayload(s) });
  // 邮件: mail_load 客户端 revice_mails(convertArray(e)) 读裸数组
  push("mail_load", s.mails);
  // 装饰插花 (室内花瓶): 客户端 client_load_decorate 读 has_list/put_id/status
  push("client_load_decorate", decorationMod.decoratePayload(s));
  // 访客: 小伙伴 (guest_load) + 串门邮差 (visit_load)
  push("guest_load", guestMod.guestPayload(s));
  push("visit_load", guestMod.visitorPayload(s));
  // 天气: 客户端 getSeasonKey 用 season""hours_type 选庭院场景 (1..4 × 1..4)
  push("weather_load", travel.weatherPayload(s));
  // --- 活动类: 全部关闭状态 ---
  push("adsmgr_load", { item_list: [], can_pop: false });
  // 动态照片 (animpic.js): 挂机经验结算后全字段推送 (模型整替换)
  animpicMod.tick(s, Math.floor(Date.now() / 1000));
  push("animpicture_load", animpicMod.payload(s, travel.withLayers));
  // 日历: 幸运日对象数组 (客户端 calendar_load 处理器按 t[i].day→t[i].item_id 重建
  // map, 推裸数组/空数组则幸运日格不渲染且永不红点)。已领取的不推 (map 缺失 = 不可领)
  ensureLuckyMonth(s);
  push("calendar_load", {
    new_flag: s.calendar.new_flag,
    // 集字任务: 无活动数据源. 但客户端 canGetStReward() 对空数组返回 true
    // (vacuous truth) 会导致日历红点常亮, 故推 3 条未完成任务占位
    // (任务 UI 仅在 st_days[day] 非空时渲染, 占位条目不会显示)
    task_list: [
      { id: 1, complete: false, pro: 0 },
      { id: 2, complete: false, pro: 0 },
      { id: 3, complete: false, pro: 0 },
    ],
    lucky_days: Object.entries(s.calendar.lucky_days)
      .map(([day, item_id]) => ({ day: Number(day), item_id })),
    st_days: [],
  });
  push("capsule_load", { task_list: [], patch_num: 0, start_time: 0, end_time: 0 });
  push("client_load_publicity", { id_list: [] });
  // 月度烹饪 (cooking.js): 登录即 tick (每周登录任务在此推进), 全字段必齐
  // (CookingModel 整替换 serverData)
  cookingMod.tick(s, push);
  push("cooking_load_cooking", cookingMod.payload(s));
  // 彩蛋: 客户端按 egg_list 渲染 (蛙稀有动作/雨具NPC/萤火虫) 并开放抓拍
  push("easteregg_load", eggMod.eggPayload(s));
  push("encyclopedia_load", encyMod.payload(s));
  push("furniture_load_furniture", merchantMod.furniturePayload(s));
  // 不倒翁/挂兜 (FurnitureModel 整对象替换 + 红点刷新): 漏推则模型恒空
  push("furniture_load_tumbler", furniMod.tumblerPayload(s));
  push("furniture_load_pocket", furniMod.pocketPayload(s));
  // 家具族载荷全字段必齐 (官方 BOOT_PUSH): 花盆/堆肥 (客户端 convertArrayAll 只拷已有键)
  flowerpotMod.flowerpotTick(s, Math.floor(Date.now() / 1000));
  push("furniture_load_flowerpot", flowerpotMod.flowerpotPayload(s));
  push("furniture_load_compost", furniMod.compostPayload(s));
  push("greetcard_load", { card_info: null, start_time: 0, end_time: 0 });
  // DrawingModel 整模型替换 (this.data = e): 必须携带全部字段, 缺 show_coll 会致
  // undefined 语义异常 → "屋内似乎多了些东西"每次进屋误弹 (offline-v2 drawingPayload 确认)
  push("guest_load_drawing", drawingMod.drawingPayload(s));
  // 周末小插曲 (lottery.js): 周末建档 + 结算推进后全量下发 (LotteryModel 整模型替换)
  {
    const lm = require("./lottery");
    const nw = Math.floor(Date.now() / 1000);
    if (lm.isWeekend(nw)) lm.node(s, nw);
    lm.tick(s, null, nw);
    push("lottery_load", lm.payload(s));
  }
  push("misc_moment_load", { list: s.moments }); // 彩蛋时刻解锁表
  // 博物馆 (官方地图系统的静态部分): 照片墙按拥有照片点亮
  push("museum_load", museumMod.payload(s));
  push("museumday_load", { start_time: 0, end_time: 0 });
  push("other_load_touch", { cur: 0, list: [] });
  push("partycake_load", {
    end_time: 0, cream: 0, sugar: 0, pre_cream: 0, pre_sugar: 0,
    cur_state: 0, part: 0, layers: [], task_list: [], share_get: [],
  });
  push("pray_load_grays", prayMod.payload(s));
  push("recharge_load_gift", { gift: [] });
  push("share_load", { pic_list: [] });
  push("springcard_load", {
    end_time: 0, card_info: null, task_harvest: 0, buy_num: 0, can_buy_num: 0,
    share_num: 0, share_get: [], box_id: 0, share_code: "", items: [], task_item: [], reward_list: [],
  });
  push("wishingpool_load", { end_time: 0 });
}

/**
 * 收割三叶草: 校验 + 入账 + 重置下一轮
 * 客户端 addClover/addHouseItem 均为空 stub —— 一切入账必须经推送:
 *   element 0 -> clover_update {clover} (货币)
 *   element 1 -> item_update (四叶草, 官方 Define.FourLeafCloverID = 1000)
 *   element 2 -> item_update (道具, sprite = item_id)
 */
function harvestClover(ctx, cloverId, atTime) {
  const s = ctx.save;
  saveMod.refreshClovers(s); // 挂机场景: 会话内到期的槽位在此重掷元素 (load 时刷不到)
  const c = s.clovers.find((x) => x.clover_id === cloverId);
  const now = Math.floor(Date.now() / 1000);
  if (!c) return { code: 1 };
  if (!(c.last_harvest === 0 || (c.last_harvest > 0 && c.last_harvest + c.rebirth_span <= now))) {
    return { code: 1, clover_id: cloverId }; // 未成熟
  }
  // 入账 (按收割时刻槽位的元素, 与客户端点击时记录的一致)
  s.stats.cloverHarvested = (s.stats.cloverHarvested || 0) + 1; // 成就 901 屯点家底
  plansMod.event(s, "cloverHarvest", null, ctx.push); // 周期计划 202 等一片草原 (周收 100 株)
  if (c.element === saveMod.CLOVER.ELEMENT.THREE) {
    s.res.clover_point += 1;
    cookingMod.event(s, "cloverGain", {}, ctx.push); // 月度烹饪 4: 累计获得三叶草
    ctx.push("clover_update", { clover: s.res.clover_point });
  } else if (c.element === saveMod.CLOVER.ELEMENT.FOUR) {
    pushItemSync(ctx, saveMod.CLOVER.FOUR_LEAF_ID);
  } else if (c.sprite > 0) {
    pushItemSync(ctx, c.sprite);
  }
  // 重置下一轮: element 在重生时 (refreshClovers) 重掷
  // resend 补记账时重生从实际收割时刻起算 (离线收割可能发生在过去)
  c.element = saveMod.CLOVER.ELEMENT.THREE;
  c.sprite = 1;
  c.last_harvest = atTime > 0 ? atTime : now;
  c.rebirth_span = saveMod.rollRebirth();
  return { code: 0, clover: s.res.clover_point, clover_id: cloverId };
}

/** 物品入账 + 推送同步 (item_update 的 count 为背包总数) */
function pushItemSync(ctx, itemId, count) {
  addItem(ctx.save, itemId, count || 1);
  const row = ctx.save.items.house.find((x) => x.item_id === itemId);
  ctx.push("item_update", { item: { item_id: itemId, count: row ? row.count : 1 } });
}

/** house 物品增减 */
function addItem(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += count;
  else s.items.house.push({ item_id: itemId, count });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
  // 道具称号 (蛙选之人/明星小蛙/蛙界艺术家 · N天): 获得即激活限时称号
  if (count > 0) achieveMod.onItemGain(s, itemId);
  // 四叶草累计 (成就 902 攒点运气): 一切途径的获得都计入
  if (count > 0 && itemId === saveMod.CLOVER.FOUR_LEAF_ID) {
    s.stats.fourLeafGained = (s.stats.fourLeafGained || 0) + count;
  }
}
function takeItem(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (!row || row.count < count) return false;
  row.count -= count;
  if (row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
  return true;
}

/** 新手签到第 day 天奖励 (calendarData_json.beginner) */
const CALENDAR_BEGINNER = {
  1: { item_id: 1201, num: 1 },  // 幸运花
  2: { item_id: 101, num: 1 },   // 枣花酥
  3: { item_id: 1104, num: 1 },  // 博物馆通票
  4: { item_id: 102, num: 1 },   // 龙眼酥
  5: { item_id: 202107, num: 1 },// 兔尾草
  6: { item_id: 5101, num: 1 },  // 种子盲盒
  7: { item_id: 1103, num: 1 },  // 完整的路标
};

// ---------- 日历: 对齐客户端 core.getOffsetDay (UTC 自然日差) ----------
// 客户端 getCreateDay = floor(getOffsetDay(serverTime, createTime)) + 1,
// getOffsetDay 以 BaseTime(2000-01-01 UTC) 的 86400s 边界对齐 —— 即 UTC 日差。
// 服务器旧实现用 24h 周期 floor, 建号次日 0:00~建号时刻之间会算回前一日:
// 客户端已跨日显示可领脉冲, 服务器却按"已领"拒绝 → 点击无反应。
const DAY_BASE = 946656000; // 2000-01-01 00:00:00 UTC (客户端 core.BaseTime)
const utcDay = (ts) => Math.floor((ts - DAY_BASE) / 86400);
/** 建号第 N 天 (1 起, UTC 自然日, 与客户端 getCreateDay 一致) */
function calendarDay(s, now) {
  return utcDay(now) - utcDay(s.create_time) + 1;
}

// 幸运日奖池: 常用便当/护符 (客户端弹窗 GiftPackageView 按 ItemDB 渲染)
const LUCKY_ITEM_POOL = [1, 2, 3, 5, 6, 1002, 1003, 1004, 1005, 1006];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** 当月幸运日: 跨月重掷 3 天 (day → item_id), 已领取的从中删除 */
function ensureLuckyMonth(s) {
  const d = new Date();
  const month = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  if (s.calendar.lucky_month === month) return;
  s.calendar.lucky_month = month;
  s.calendar.lucky_days = {};
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const days = new Set();
  while (days.size < Math.min(3, maxDay)) days.add(randInt(1, maxDay));
  for (const day of days) {
    s.calendar.lucky_days[day] = LUCKY_ITEM_POOL[randInt(0, LUCKY_ITEM_POOL.length - 1)];
  }
}

/** 发放签到奖励并同步客户端 (item_update 的 count 为总数) */
function grantCalendarDay(ctx, day) {
  const s = ctx.save;
  const reward = CALENDAR_BEGINNER[day];
  addItem(s, reward.item_id, reward.num);
  const row = s.items.house.find((x) => x.item_id === reward.item_id);
  ctx.push("item_update", { item: { item_id: reward.item_id, count: row.count } });
  s.calendar.new_flag[day - 1] = 1;
  plansMod.event(s, "calendarClaim", null, ctx.push); // 周期计划 407 时令美食
}

// ---------- 抽奖 (item_gacha / item_redeem_prize) ----------
// 客户端流 (RaffleView 逆向): raffle() 本地校验 5 券后 send item_gacha {is_reward:!1};
// 响应由 ItemModel.item_gacha 处理: gachaColorBall = e.ticket (ticket 字段承载球 rank),
// updateGachaColorBall → playRaffleAnm(rank) (PrizeDishImage[rank] 两张碟随机)。
// is_reward=!0 为广告/连抽免费路径 (客户端不校验券)。领取:
//   白球(rank0) → GetTicket 弹窗 + addTicket(stock) + send item_redeem_prize {prize_id}
//   彩球 → PrizeSelector 玩家自选一项 → addHouseItem + send item_redeem_prize {prize_id}
// item_redeem_prize needResponse:!1 —— 入账全靠服务器推送补账 (addTicket 是空 stub)。
const PRIZE_TABLE = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "resource", "China", "config", "MainData", "Prize.json"), "utf-8"
));
// 官方 Define.PrizeBalls 权重: White 40 / Blue 25 / Purple 22 / Green 9 / Red 3 / Gold 1
const PRIZE_RANKS = [
  { rank: 0, weight: 40 }, // White → +1 抽奖券 (Prize id0, itemId:-1)
  { rank: 1, weight: 25 }, // Blue  → 1002~1006 护符
  { rank: 2, weight: 22 }, // Purple → 1013~1016 护符
  { rank: 3, weight: 9 },  // Green → 6~10 食物
  { rank: 4, weight: 3 },  // Red   → 11~14 食物
  { rank: 5, weight: 1 },  // Gold  → 1007~1010 护符
];
const RAFFLE_NEED_TICKETS = 5; // 官方 Define.RAFFEL_NEEDTICKETS

function rollPrizeRank() {
  const total = PRIZE_RANKS.reduce((n, r) => n + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of PRIZE_RANKS) {
    if ((roll -= r.weight) < 0) return r.rank;
  }
  return 0;
}

/**
 * 协议路由表: cmd -> (ctx, data) => responseData
 * ctx = { save, push(cmd, data), reply(data) }
 * 未列出的协议 -> 兜底 {code: 0}
 */
const handlers = {
  // ---------- 周末小插曲 (lottery.js) ----------
  "lottery_open": (ctx) => {
    const lm = require("./lottery");
    const r = lm.openRound(ctx.save);
    if (r.code === 0) {
      // open_item 即得食物: 推库存 (客户端 req_open 回调里自己弹奖励窗)。
      // 不推 lottery_load! 推送会整对象替换 LotteryModel.data, 开着的 LotteryView
      // 攥着旧 data 引用 → 视图不更新 (揭开无反应, 刷新才显示); 回复自带
      // open_item/extra_item, 客户端 req_open 本地切 Select 态
      ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    }
    return r;
  },
  "lottery_select": (ctx, data) => require("./lottery").select(ctx.save, Array.isArray(data) ? data : (data && data.list)),
  "lottery_confirm_reward": (ctx) => {
    const r = require("./lottery").confirmReward(ctx.save, ctx.push);
    return r;
  },
  // 分享/看广告回调: 线格式 {ads_type: N} (抓包确认); 3 = 周末礼领取
  "adsmgr_share": (ctx, data) => {
    const t = Number(data && data.ads_type !== undefined ? data.ads_type : data);
    if (t === 3) return require("./lottery").claimExtra(ctx.save, ctx.push);
    return { code: 0 };
  },
  // ---------- 登录链 ----------
  "hall_gen_token": (ctx, data) => {
    ctx.save = saveMod.load(data.account); // 加载/建档
    ctx.token = "T" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    return { code: 0, token: ctx.token };
  },
  "hall_login": (ctx, data) => {
    if (!ctx.save) ctx.save = saveMod.load("guest_default");
    return { code: 0, account: ctx.save.account };
  },
  // 断线重连 (浏览器切后台 WS 断开, 切回前台客户端发 hall.reconnect{token, account}):
  // 必须按 account 重新加载存档 —— 否则本连接 ctx.save 恒 null, 后续
  // hall_enter_game 兜底加载 guest_default 错档, 全量同步推的是别人的数据
  // → 切回前台场景不刷新/数据错乱
  "hall_reconnect": (ctx, data) => {
    const account = data.account || data.token || "guest_default";
    ctx.save = saveMod.load(String(account));
    ctx.token = data.token;
    return { code: 0, account: ctx.save.account };
  },
  "hall_enter_game": (ctx) => {
    return { code: 0 };
  },
  "client_hello": (ctx) => {
    return { code: 0, timestamp: Math.floor(Date.now() / 1000) };
  },
  "client_load_all_info": (ctx) => {
    // 称号: 登录天数跨天递增 + 全量解锁检查 (存档层, 数据随 rolePayload 三字段下发)
    achieveMod.onLogin(ctx.save, Math.floor(Date.now() / 1000));
    pushAllState(ctx); // 先推全部状态
    ctx.synced = true; // 客户端模型就绪: 此后旅行 tick 才实时推送
    return { code: 0 }; // 后回响应 -> 客户端触发 syncComplete
  },

  // ---------- 庭院基础 ----------
  "clover_harvest": (ctx, data) => {
    const res = harvestClover(ctx, data.clover_id);
    if (res.code === 0) {
      // 同步槽位状态 (客户端据此启动重生计时)
      ctx.push("clover_load_clovers", ctx.save.clovers);
    }
    return res;
  },
  "clover_harvest_resend": (ctx, data) => {
    // 弱网补偿: 客户端载荷为 {clover_id, time} (main.min.js syncHarvestClover)
    // 已收过的会被就绪检查挡下, 不重复入账
    for (const h of data.list || []) harvestClover(ctx, h.clover_id, h.time);
    // 响应必须是裸数组: 客户端 clover_load_clovers(convertArray(e))
    // convertArray 对非数组返回 [] —— 返回对象会清空整个草地显示
    return ctx.save.clovers;
  },
  "item_putin_bag": (ctx, data) => {
    // 旅行中包随蛙走, 不可操作
    if (ctx.save.frog.status === 1) return { code: 1, conflict: false };
    const { pos, item_id } = data;
    const bag = ctx.save.items.bag;
    if (pos < 1 || pos > bag.length) return { code: 1, conflict: false };
    if (bag[pos - 1] !== -1) return { code: 1, conflict: true };
    if (!takeItem(ctx.save, item_id, 1)) return { code: 1, conflict: false };
    bag[pos - 1] = item_id;
    // 官方语义: 客户端 consumeHouseItem 只校验不扣减, house 数量靠服务器推送同步
    // (缺推送 → 物品栏数量不更新 → 可重复放置, 客户端乐观更新后拒绝也不回滚)
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return { code: 0, conflict: false };
  },
  "item_takeout_bag": (ctx, data) => {
    if (ctx.save.frog.status === 1) return { code: 1, conflict: false };
    const pos = data.pos;
    const bag = ctx.save.items.bag;
    if (pos < 1 || pos > bag.length || bag[pos - 1] === -1) return { code: 1, conflict: false };
    addItem(ctx.save, bag[pos - 1], 1);
    bag[pos - 1] = -1;
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return { code: 0, conflict: false };
  },
  "item_putin_desk": (ctx, data) => {
    const { pos, item_id } = data;
    const desk = ctx.save.items.desk;
    if (pos < 1 || pos > desk.length) return { code: 1, conflict: false };
    if (desk[pos - 1] !== -1) return { code: 1, conflict: true };
    if (!takeItem(ctx.save, item_id, 1)) return { code: 1, conflict: false };
    desk[pos - 1] = item_id;
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return { code: 0, conflict: false };
  },
  "item_takeout_desk": (ctx, data) => {
    const pos = data.pos;
    const desk = ctx.save.items.desk;
    if (pos < 1 || pos > desk.length || desk[pos - 1] === -1) return { code: 1, conflict: false };
    addItem(ctx.save, desk[pos - 1], 1);
    desk[pos - 1] = -1;
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return { code: 0, conflict: false };
  },
  // 行囊「准备完成 / 锁定」按钮 —— 出发的玩家触发
  // BagView.lock() 校验便当在包内后发送 {completed: 1}; 记录锁定状态 +
  // 蛙在家且包/桌有可携带之物时排程出门 (WAIT 窗口 3~8min 内自行出发,
  // 正常游戏节奏; offline-v2 的「完成即出发」语义已于 2026-09-19 废弃)。
  // 解锁 (completed=0) 允许, 只回显状态; 已排程的出发由 tick 的
  // tripPrepared 检查兜底 (窗口内收走便当则蛙留在家)。
  "item_set_bag_completed": (ctx, data) => {
    const s = ctx.save;
    const completed = data.completed === true || Number(data.completed) > 0;
    const wasCompleted = s.items.bag_completed ? 1 : 0;
    s.items.bag_completed = completed;
    // 涂鸦派对守卫: 已受邀/锁包 (drawing.state 2~3) 或蛙在聚会 (status 3) 时顺延出发
    // (派对结束/解锁后 travelTick 兜底照常出门, bag_completed 已记录)
    const partyPending = s.frog.status === 3
      || (s.drawing && s.drawing.state >= 2 && s.drawing.state <= 3);
    const schedule = completed && !wasCompleted && s.frog.status !== 1 && !partyPending && travel.tripPrepared(s);
    if (schedule) travel.scheduleDeparture(s);
    ctx.push("item_load_items", travel.itemsPayload(s));
    return { code: 0 };
  },
  "item_buy": (ctx, data) => {
    // 商店购买: shopData.json (id=货架位) + 限购/前置链/余额
    // 客户端购买时乐观扣款 (consumeClover), 拒绝路径必须推 clover_update 回滚
    const s = ctx.save;
    const slot = SHOP.get(parseInt(data.shop_id, 10));
    const refuse = (code) => {
      ctx.push("clover_update", { clover: s.res.clover_point }); // 回滚乐观扣款
      return { code, ticket: 0 };
    };
    if (!slot) return refuse(1);
    const bought = s.items.purchased[slot.id] || 0;
    // 限购 (limit=0 不限)
    if (slot.limit > 0 && bought >= slot.limit) return refuse(2);
    // 前置: before_buy = ['shop', N] 表示需先购货架位 N (连锁商品); 空数组 = 无前置
    const bb = slot.before_buy;
    const pre = Array.isArray(bb) && bb.length >= 2 && bb[0] === "shop" ? Number(bb[1]) : null;
    if (pre != null && !(s.items.purchased[pre] > 0)) return refuse(3);
    // 余额
    if (s.res.clover_point < slot.price) return refuse(4);

    s.res.clover_point -= slot.price;
    s.items.purchased[slot.id] = bought + 1;
    pushItemSync(ctx, slot.itemId); // 发货 + item_update 推送
    if (travel.isType(slot.itemId, travel.ITEM_TYPE.TOOLS)) plansMod.event(s, "buyTool", null, ctx.push); // 计划 301
    ctx.push("clover_update", { clover: s.res.clover_point });
    return { code: 0, ticket: 0 };
  },
  "item_load_shop_info": (ctx) => ({
    // 限购恢复: purchasedMap 按货架位 id 记 (字段名 item_id 实为 slot id)
    code: 0,
    ...shopInfoPayload(ctx.save),
  }),
  // 嘟嘟家具商店购买 (客户端成功回调: code==0 时本地 shop_list.num-- 并按物品类型
  // 弹窗/入包; 图纸 type13 客户端不入包, 服务器入包+推送, 三叶草由服务器权威扣)
  "furniture_buy_shop": (ctx, data) => {
    const s = ctx.save;
    const shopId = parseInt(data.shop_id, 10);
    const r = merchantMod.buyShopItem(s, shopId);
    if (r.code !== 0) {
      // 失败回滚客户端乐观扣款显示 (客户端买前会本地先扣显示, 失败弹窗)
      ctx.push("clover_update", { clover: s.res.clover_point });
      return { code: r.code };
    }
    pushItemSync(ctx, r.item_id);
    ctx.push("clover_update", { clover: s.res.clover_point });
    return { code: 0 };
  },
  // ---- 家具工坊 (furni.js: 槽位含库存扣减/顶替回仓, 官方语义客户端 code 驱动) ----
  // 工作台放入 (ProtocolList: furniture_putin_bench [["pos","id"]]):
  // 顶替旧槽物品回仓; 图纸+材料齐 → 自动开工 (crafting:1)
  "furniture_putin_bench": (ctx, data) => {
    const r = furniMod.putinBench(ctx.save, data.pos, data.id);
    if (r.code !== 0) return { code: r.code };
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    ctx.push("furniture_load_furniture", merchantMod.furniturePayload(ctx.save));
    // 开工推送 client_load_role: 蛙上工 (motion 5-9 工具动画) 需客户端实时切换
    if (r.crafting) ctx.push("client_load_role", travel.rolePayload(ctx.save));
    return r;
  },
  // 工作台取出 (furniture_takeout_bench [["pos"]]): 槽位物品回仓
  "furniture_takeout_bench": (ctx, data) => {
    const r = furniMod.takeoutBench(ctx.save, data.pos);
    if (r.code !== 0) return { code: r.code };
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    ctx.push("furniture_load_furniture", merchantMod.furniturePayload(ctx.save));
    return { code: 0 };
  },
  // 堆肥盒 (furniture_putin_box / takeout_box [["pos","id"]]): 6 格, 空槽值 0
  // 放入/取出改变肥力 → 推 furniture_load_compost 刷新土地贴图 (td_pj/td_zc/td_fw)
  "furniture_putin_box": (ctx, data) => {
    const r = furniMod.putinBox(ctx.save, data.pos, data.id);
    if (r.code !== 0) return { code: r.code };
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    ctx.push("furniture_load_compost", furniMod.compostPayload(ctx.save));
    return { code: 0 };
  },
  "furniture_takeout_box": (ctx, data) => {
    const r = furniMod.takeoutBox(ctx.save, data.pos);
    if (r.code !== 0) return { code: r.code };
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    ctx.push("furniture_load_compost", furniMod.compostPayload(ctx.save));
    return { code: 0 };
  },
  // 摆放/撤下家具 (furniture_replace_fur [["id"]]): code 1=撤下该 type, 0=摆上
  "furniture_replace_fur": (ctx, data) => furniMod.replaceFur(ctx.save, data.id),
  // 工坊全量状态 (响应式): 客户端 FurnitureFinish 家具分支会主动 send 拉取
  // (furniture_load_furniture 处理器 serverData 整对象替换, 须含 shop 全字段)
  "furniture_load_furniture": (ctx) => merchantMod.furniturePayload(ctx.save),
  // 堆肥盒状态 (furniture_load_compost): show/replace_index + box_list[6]
  "furniture_load_compost": (ctx) => furniMod.compostPayload(ctx.save),
  // 切换/隐藏堆肥箱 (furniture_replace_compost [["index"]], 1-based):
  // 同款再点隐藏 (code 1), 换款展示 (code 0); 客户端自行维护索引并重绘
  "furniture_replace_compost": (ctx, data) => furniMod.replaceCompost(ctx.save, data.index),
  // ---- 不倒翁 (tumbler: 复用 compost 的 replace 语义, 客户端整模型替换) ----
  "furniture_load_tumbler": (ctx) => furniMod.tumblerPayload(ctx.save),
  "furniture_replace_tumbler": (ctx, data) => furniMod.replaceTumbler(ctx.save, data.index),
  // ---- 挂兜 (pocket: 庭院树上存钱罐) ----
  "furniture_load_pocket": (ctx) => furniMod.pocketPayload(ctx.save),
  "furniture_replace_pocket": (ctx, data) => furniMod.replacePocket(ctx.save, data.index),
  // 领取挂兜三叶草 (furniture_pocket_get 无参): 客户端成功后本地 clover=0,
  // 入账必须服务器推 clover_update + furniture_load_pocket (刷新红点)
  "furniture_pocket_get": (ctx) => {
    const s = ctx.save;
    const r = furniMod.pocketGet(s);
    if (r.code === 0) {
      ctx.push("clover_update", { clover: s.res.clover_point });
      ctx.push("furniture_load_pocket", furniMod.pocketPayload(s));
    }
    return r;
  },
  // ---- 装饰插花 (client_change_decorate [["id"]]: Design B 插花不消耗, 换花消耗旧花) ----
  "client_change_decorate": (ctx, data) => {
    const s = ctx.save;
    const r = decorationMod.changeDecorate(s, data.id);
    if (r.code === 0) {
      plansMod.event(s, "decorate", null, ctx.push); // 周期计划 203 学着浪漫一点
      // 客户端本地扣旧花 + putID/status 自维护; 推权威载荷兜底 (含库存变化)
      ctx.push("item_load_items", travel.itemsPayload(s));
      ctx.push("client_load_decorate", decorationMod.decoratePayload(s));
    }
    return r;
  },
  // ---- 称号佩戴 (client_set_achieve [["id"],!1]: 无 session 无回复, 客户端本地
  // 先改 useAchieveID 并 dispatch; 服务器只存档, 校验 id 已解锁) ----
  "client_set_achieve": (ctx, data) => {
    const s = ctx.save;
    const id = Number(data.id);
    if (id === 0 || (s.frog.achieves || []).includes(id)) s.frog.cur_achieve = id;
    return { code: 0 };
  },
  // ---- 栽培花盆 (flowerpot.js: 全服务器驱动, 无种植命令) ----
  // 拉取时 tick 可能吸收了堆肥 (升阶) → 同步推 compost 刷新土地肥力贴图
  "furniture_load_flowerpot": (ctx) => {
    if (flowerpotMod.flowerpotTick(ctx.save, Math.floor(Date.now() / 1000))) {
      ctx.push("furniture_load_compost", furniMod.compostPayload(ctx.save));
    }
    return flowerpotMod.flowerpotPayload(ctx.save);
  },
  // 收获 (furniture_flowerpot_harvest {index}, 1-based): 响应精确 {item_list:[{item_id,num}]}
  "furniture_flowerpot_harvest": (ctx, data) => {
    const s = ctx.save;
    const r = flowerpotMod.harvest(s, data.index);
    if (!r.item_list || !r.item_list.length) return {};
    const { item_id, num } = r.item_list[0];
    ctx.push("item_update", { item: { item_id, count: (s.items.house.find((x) => x.item_id === item_id) || {}).count || num } });
    ctx.push("item_load_handbook", travel.handbookPayload(s));
    // 不推 client_load_role: RoleModel 会 dispatch loadRole → MainOutView.reset()
    // 整个庭院视图重建, 视角强制回中。盆栽移除与奖励弹窗均由响应驱动
    // (客户端 req_flowerpot_harvest 本地 splice plant_list + GiftPackageViewController)
    return r;
  },
  "client_set_name": (ctx, data) => {
    ctx.save.frog.name = String(data.name || "").slice(0, 12);
    return { code: 0 };
  },
  "client_rename_cost": (ctx) => ({ code: 0, cost: 0 }),

  // ---------- 新手引导 ----------
  // 引导链检查响应的 ok 字段 (非 code): ok=false 会重走引导造成死循环
  "tutorial_step_open_door": (ctx) => ({ code: 0 }),
  "tutorial_step_open_door_q": (ctx) => ({ code: 0, ok: true }),
  "tutorial_step_ask_award": (ctx) => ({ code: 0 }),
  "tutorial_step_ask_award_q": (ctx) => ({ code: 0, ok: true }),

  // ---------- 日历 (新手7天签到 + 幸运日) ----------
  // 奖励表 = calendarData_json.beginner (config.eab, 客户端本地同表负责展示)
  // day 用 calendarDay (UTC 自然日差, 对齐客户端 getCreateDay) —— 24h 周期制会在
  // 跨日后未满 24h 时算回前一日, 造成客户端可领而服务器拒绝 (点击无反应)
  "calendar_get_beginer_reward": (ctx) => {
    const s = ctx.save;
    const day = calendarDay(s, Math.floor(Date.now() / 1000));
    if (day < 1 || day > 7) return { code: 0, day: 0 };        // 超7天无奖励
    if (s.calendar.new_flag[day - 1] > 0) return { code: 0, day: 0 }; // 已领
    grantCalendarDay(ctx, day);
    return { code: 0, day };
  },
  "calendar_get_code_reward": (ctx, data) => {
    // 兑换码领取 (客户端传 day; 官方用于补偿错过天数)
    const s = ctx.save;
    const day = parseInt(data.day, 10);
    if (!(day >= 1 && day <= 7)) return { code: 0, day: 0 };
    if (s.calendar.new_flag[day - 1] > 0) return { code: 0, day: 0 };
    grantCalendarDay(ctx, day);
    return { code: 0, day };
  },
  "calendar_get_st_reward": (ctx) => ({ code: 0 }),   // 集字奖励: 无任务数据源, 推送侧恒空
  // 幸运日领取 (客户端点击今日幸运格, 无请求参数, 服务器按今日判断;
  // 响应 code==0 → 客户端弹窗 + 本地置 null, 服务器同步删除持久化)
  "calendar_get_luck_reward": (ctx) => {
    const s = ctx.save;
    ensureLuckyMonth(s);
    const today = new Date().getDate();
    const item = s.calendar.lucky_days[today];
    if (!item) return { code: 1 };
    delete s.calendar.lucky_days[today];
    plansMod.event(s, "calendarClaim", null, ctx.push); // 周期计划 407 时令美食
    addItem(s, item, 1);
    const row = s.items.house.find((x) => x.item_id === item);
    ctx.push("item_update", { item: { item_id: item, count: row ? row.count : 1 } });
    return { code: 0 };
  },
  "calendar_load_note": (ctx) => ({ code: 0, list: [] }), // 手帐(旅行日记): 空表

  // ---------- 成就任务 (task.js) ----------
  // 伴蛙前行面板打开时客户端主动拉取 (GuideTaskViewControl.open → send task_load)。
  // 走未实现兜底 {code:0} 会被模型 task_load(e) 当载荷解析: data=convertArray(undefined)=[]
  // → 成就列表清空、分类按钮全锁 (updateLock 判 typeMap 为空)、红点消失, 直到重新登录;
  // 必须回与登录推送同构的完整载荷
  "task_load": (ctx) => ({
    code: 0,
    tasks: taskMod.payload(ctx.save).tasks,
    list: plansMod.listPayload(ctx.save),
  }),
  // 客户端本地已把任务置为已领 (is_reward/红点), 奖励入账全靠这里推送:
  // addHouseItem/addClover 在客户端是空 stub, 漏推 = 领了白屏奖励
  "task_get_reward": (ctx, data) => {
    const s = ctx.save;
    const r = taskMod.claim(s, Number(data.id));
    if (!r.ok) return { code: 1 };
    if (r.reward.type === "clover") {
      s.res.clover_point += r.reward.num;
      cookingMod.event(s, "cloverGain", { delta: r.reward.num }, ctx.push); // 月度烹饪 4
      ctx.push("clover_update", { clover: s.res.clover_point });
    } else {
      addItem(s, r.reward.id, r.reward.num);
      const row = s.items.house.find((x) => x.item_id === r.reward.id);
      ctx.push("item_update", { item: { item_id: r.reward.id, count: row ? row.count : r.reward.num } });
    }
    return { code: 0 };
  },

  // ---------- 博物馆 ----------
  // 客户端 requestMuseum (小仓库菜单进入博物馆时) 主动拉取
  "museum_load": (ctx) => ({ code: 0, ...museumMod.payload(ctx.save) }),

  // ---------- 周期计划 (plans.js): 是日清单/当周/半月/月度/当季/年度 ----------
  // 客户端 req_list_reward 回调只看 code==0 (本地记档位), 奖励入账靠服务端推送
  "task_get_list_reward": (ctx, data) => {
    const s = ctx.save;
    const r = plansMod.claim(s, Number(data.id));
    if (!r.ok) return { code: 1 };
    if (r.item > 0) {
      addItem(s, r.item, 1);
      const row = s.items.house.find((x) => x.item_id === r.item);
      ctx.push("item_update", { item: { item_id: r.item, count: row ? row.count : 1 } });
    }
    return { code: 0 };
  },

  // 兑换码 (CdkeyView 判 200==code 为成功): 离线版仅收录"给自己的信"
  // (周期计划 204 的正解: 给自己写信的仪式感, 无物品产出)
  "item_use_gift_code": (ctx, data) => {
    const gc = data.gift_code !== undefined ? data.gift_code : data; // 线格式 {gift_code: "码"} 或 {gift_code:{code}} (协议模式表)
    const code = String((gc && gc.code) || gc || "").trim();
    if (code === "给自己的信") {
      plansMod.event(ctx.save, "letterSelf", null, ctx.push);
      return { code: 200 };
    }
    return { code: 404 }; // 无效礼包码 (客户端走"礼包码无效"提示)
  },

  // ---------- 涂鸦派对故事 (story.js) ----------
  // 客户端阅读新故事后 fire-and-forget; 服务端不同步清 → 红点每次登录重现
  "story_read_new_story": (ctx) => {
    ctx.save.new_story_id = 0;
    return { code: 0 };
  },
  // 送礼 {id, gift}: 客户端 consumeHouseItem 只校验不扣货, 服务器权威扣减
  "story_send_gift": (ctx, data) => {
    const s = ctx.save;
    const row = s.items.house.find((x) => x.item_id === Number(data.gift));
    const before = row ? row.count : 0;
    if (!storyMod.sendGift(s, data.id, data.gift, (id, n) => takeItem(s, id, n))) {
      return { code: 1 };
    }
    plansMod.event(s, "storyGift", null, ctx.push); // 周期计划 401 故事小红心
    ctx.push("item_update", { item: { item_id: Number(data.gift), count: before - 1 } });
    return { code: 0 };
  },
  // 拆 StoryGift 邮件时的"感谢赠礼"回执 (fire-and-forget, 仅确认)
  "story_feedback_gift": (ctx) => ({ code: 0 }),

  // ---------- 彩蛋时刻 ----------
  // 客户端抓拍触发 (蛙动作/邻居/商人入镜): 记录解锁 id, 重启后已抓拍不重弹
  "misc_moment_unlock": (ctx, data) => {
    const id = Number(data.id);
    if (!ctx.save.moments.includes(id)) ctx.save.moments.push(id);
    return { code: 0 };
  },

  // ---------- 个人信息 ----------
  // 头像切换 (RoleModel.iconID): 需要回显在个人信息界面, 持久化到存档
  "client_set_icon": (ctx, data) => {
    const id = Number(data.id);
    if (id >= 0) ctx.save.frog.icon = id;
    return { code: 0 };
  },

  // ---------- 抽奖 ----------
  // 抽球 (item_gacha {is_reward}): needResponse, 响应 ticket 字段承载球 rank,
  // 客户端 ItemModel.item_gacha 读它驱动 playRaffleAnm —— 缺失即报
  // "Cannot read properties of undefined (reading '1')" (PrizeDishImage[undefined][1])
  "item_gacha": (ctx, data) => {
    const s = ctx.save;
    const isReward = data && (data.is_reward === true || Number(data.is_reward) === 1);
    if (!isReward) {
      // 正常抽: 客户端 consumeTicket 仅本地校验不扣, 服务器权威扣 5 券
      if (s.res.ticket < RAFFLE_NEED_TICKETS) {
        return { code: 0, ticket: s.items.gacha.color_ball }; // 券不足: 不抽, 回显当前球
      }
      s.res.ticket -= RAFFLE_NEED_TICKETS;
    } else if (s.items.gacha.color_ball >= 0) {
      // 免费连抽: 上一个球未领时客户端等待领取, 不再 roll —— 防止覆盖待领球
      return { code: 0, ticket: s.items.gacha.color_ball };
    }
    const rank = rollPrizeRank();
    s.items.gacha.color_ball = rank;
    s.items.gacha.rolled = true; // 标记真实抽过 (save.js 旧档迁移 0→-1 的判据)
    achieveMod.onGacha(s); // 称号: 抽奖 20 次以上
    ctx.push("item_update_ticket", { ticket: s.res.ticket });
    return { code: 0, ticket: rank };
  },
  // 领奖 (item_redeem_prize {prize_id}): needResponse:!1, 客户端已本地先行
  // (白球 addTicket / 彩球 addHouseItem), 服务器按 Prize 表补账推送
  "item_redeem_prize": (ctx, data) => {
    const s = ctx.save;
    const prize = PRIZE_TABLE.find((p) => Number(p.id) === Number(data.prize_id));
    if (!prize || s.items.gacha.color_ball !== Number(prize.rank)) return { code: 1 };
    s.items.gacha.color_ball = -1;
    if (Number(prize.rank) === 0) {
      // 白球: itemId=-1 → +stock 张抽奖券
      s.res.ticket += Number(prize.stock) || 1;
      ctx.push("item_update_ticket", { ticket: s.res.ticket });
    } else {
      addItem(s, Number(prize.itemId), Number(prize.stock) || 1);
      const row = s.items.house.find((x) => x.item_id === Number(prize.itemId));
      ctx.push("item_update", {
        item: { item_id: Number(prize.itemId), count: row ? row.count : (Number(prize.stock) || 1) },
      });
    }
    cookingMod.event(s, "gachaRedeem", {}, ctx.push); // 月度烹饪 7: 抽奖后兑换 1 次奖品
    return { code: 0 };
  },

  // ---------- 月度烹饪 (cooking.js: 官方 CookingModel 协议) ----------
  // 拉取 (cooking_load_cooking): 响应整对象替换 serverData, 全字段必齐
  "cooking_load_cooking": (ctx) => {
    cookingMod.tick(ctx.save, ctx.push);
    return cookingMod.payload(ctx.save);
  },
  // 选主题年份 (cooking_select {index}: 1|2, 主题选择器 confirm 后发送)
  "cooking_select": (ctx, data) => {
    const idx = Number(data.index);
    if (idx !== 1 && idx !== 2) return { code: 1 };
    cookingMod.tick(ctx.save, ctx.push);
    ctx.save.cooking.select = idx;
    return { code: 0 };
  },
  // 刷新任务 (cooking_refresh_task {id}): 换成列表外随机模板, 响应须带 {task}
  // (客户端按 id 整条替换; 官方无消耗, 仅 ModalConfirm 确认)
  "cooking_refresh_task": (ctx, data) => {
    const t = cookingMod.swapTask(ctx.save, data.id);
    if (!t) return { code: 1 };
    return { code: 0, task: { id: t.id, pro: t.pro, complete: false, refresh: 0 } };
  },
  // 领任务奖励 (cooking_complete_task {id}): pro 达标才可领; month_pro 客户端本地 ++
  "cooking_complete_task": (ctx, data) => {
    if (!cookingMod.claim(ctx.save, data.id)) return { code: 1 };
    return { code: 0 };
  },
  // 开火烹饪 (cooking_start_cooking): 做满 6 个后客户端自动发送; 客户端回调里的
  // addHouseItem 是空 stub, 食物入包必须由服务器推 item_update 补账
  "cooking_start_cooking": (ctx) => {
    const s = ctx.save;
    const got = cookingMod.startCooking(s);
    if (!got) return { code: 1 };
    ctx.push("item_update", { item: got });
    return { code: 0 };
  },
  // 分享完成 (cooking_share): 相册/照片分享回调无条件上报 → 烹饪任务 8 进度
  "cooking_share": (ctx) => {
    cookingMod.event(ctx.save, "share", {}, ctx.push);
    return { code: 0 };
  },
  // 看广告 (cooking_look_ad): 本客户端从未发送 (官方由 adsmgr 广告回调推进), 兜底空实现
  "cooking_look_ad": (ctx) => ({ code: 0 }),

  // ---------- 祈愿/手工 (pray.js: 官方 HandCraftModel 协议) ----------
  // 拉取 (pray_load_grays): 客户端也可主动 send (needResponse), 返回同款载荷
  "pray_load_grays": (ctx) => prayMod.payload(ctx.save),
  // 领取成品盒 (pray_confirm_make_box): 客户端关 BoxCraftShowView 前本地清空后上报,
  // 服务器侧 boxes 恒空 (奖励走 pray_compose 响应), 仅回执
  "pray_confirm_make_box": (ctx) => ({ code: 0 }),
  // 拼接 (pray_compose {id}): 官方 ComposeId=5502, 三种木片各 1 → 紫檀木护符;
  // 客户端按响应 item_list 逐条弹奖励, 消耗/入包由服务器推送同步
  "pray_compose": (ctx, data) => {
    const r = prayMod.compose(ctx.save, data.id);
    if (r.code === 0) ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return r;
  },

  // ---------- 图鉴 (ency.js) ----------
  // 选择展示变体 (encyclopedia_set_show_sub {id: long_id}): 客户端本地先行,
  // 服务器持久化 (载荷 sub_id 字段回传 long_id, 客户端拿它当 list 键用)
  "encyclopedia_set_show_sub": (ctx, data) => {
    encyMod.setShowSub(ctx.save, data.long_id !== undefined ? data.long_id : data.id); // 线格式 {long_id} (协议模式表)
    return { code: 0 };
  },

  // ---------- 动态照片 (animpic.js: 官方 AnimPictureModel 协议) ----------
  // 桶变动后必须推 album_load_new (客户端新照片桶唯一数据源)
  "animpicture_load": (ctx) => {
    animpicMod.tick(ctx.save, Math.floor(Date.now() / 1000));
    return animpicMod.payload(ctx.save, travel.withLayers);
  },
  "animpicture_guide": (ctx) => animpicMod.guide(ctx.save),
  // 领取完成奖励 (照片存储开启物 ×N): 入包必须推 item_load_items
  "animpicture_get_item": (ctx) => {
    const r = animpicMod.getItem(ctx.save);
    if (r.code === 0) ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return r;
  },
  "animpicture_select_pic": (ctx, data) => {
    const r = animpicMod.selectPic(ctx.save, data.id);
    if (r.code === 0) {
      ctx.push("album_load_new", {
        pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
        visted_pic: [], has_ads: false, is_share: false,
      });
      ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    }
    return r;
  },
  "animpicture_add_pic": (ctx, data) => {
    const r = animpicMod.addPic(ctx.save, data.ids);
    if (r.code === 0) {
      ctx.push("album_load_new", {
        pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
        visted_pic: [], has_ads: false, is_share: false,
      });
      ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    }
    return r;
  },
  "animpicture_remove_pic": (ctx, data) => {
    const r = animpicMod.removePic(ctx.save, data.index);
    if (r.code === 0) ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    return r;
  },
  "animpicture_open_album": (ctx, data) => {
    const r = animpicMod.openAlbum(ctx.save, data.index);
    if (r.code === 0) ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    return r;
  },
  "animpicture_album_add_pic": (ctx, data) => {
    const r = animpicMod.albumAddPic(ctx.save, data.anim_index, data.pic_index, data.pic_uid);
    if (r.code === 0) {
      ctx.push("album_load_new", {
        pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
        visted_pic: [], has_ads: false, is_share: false,
      });
      ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    }
    return r;
  },
  "animpicture_album_remove_pic": (ctx, data) => {
    const r = animpicMod.albumRemovePic(ctx.save, data.anim_index, data.pic_index);
    if (r.code === 0) {
      ctx.push("album_load_new", {
        pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
        visted_pic: [], has_ads: false, is_share: false,
      });
      ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
    }
    return r;
  },
  // 使用显影液: 客户端只读响应 {phase}; 消耗经 item_load_items 同步
  "animpicture_use_item": (ctx, data) => {
    const r = animpicMod.useItem(ctx.save, data.id, Math.floor(Date.now() / 1000));
    if (r.code === 0) {
      ctx.push("item_load_items", travel.itemsPayload(ctx.save));
      ctx.push("animpicture_load", animpicMod.payload(ctx.save, travel.withLayers));
      if (ctx.save.albumPending) ctx.push("album_load_new", {
        pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
        visted_pic: [], has_ads: false, is_share: false,
      });
    }
    return r;
  },

  // ---------- 邮件 ----------
  "mail_load_mails": (ctx, data) => {
    const start = data.start || 1;
    const count = data.count || 5;
    const mails = ctx.save.mails;
    const slice = mails.slice(start - 1, start - 1 + count);
    return { code: 0, mails: slice, start, total: mails.length };
  },
  // 打开邮箱视图时客户端 requestMail() 主动拉取;
  // 响应为裸邮件数组 (revice_mails(convertArray(e))), 缺处理器回 {code:0} 会清空邮件列表
  "mail_load": (ctx) => ctx.save.mails,
  // 已读标记必须写在邮件对象上: 客户端 mail_load 推送 (revice_mails) 整体替换
  // 列表, read/opened 状态以下发的邮件对象为准 —— 只记在旁路字典会导致
  // 每次全量推送 (新邮件到达/伙伴告别邮件) 已读邮件重新显示未读
  "mail_read": (ctx, data) => {
    const m = ctx.save.mails.find((x) => x.id === Number(data.id));
    if (m) m.read = true;
    return { code: 0 };
  },
  // 拆信入账 (P9): 客户端 openMailInfo 的 addClover/addTicket/addHouseItem 全是空 stub,
  // 附件三叶草/抽奖券/物品必须由服务器在 mail_open 时入账并推送补账。
  // 官方语义 mail_open = 服务器删除该邮件 (客户端本地 splice 移除 + 无回复期待),
  // 后续 mail_load 全量推送不再包含 → 否则客户端整体替换后已领邮件重现可重复领取
  "mail_open": (ctx, data) => {
    const s = ctx.save;
    const idx = s.mails.findIndex((x) => x.id === Number(data.id));
    if (idx >= 0) {
      const m = s.mails[idx];
      const r = m.resource || {};
      if (Number(r.clover_point) > 0) {
        s.res.clover_point += Number(r.clover_point);
        cookingMod.event(s, "cloverGain", { delta: Number(r.clover_point) }, ctx.push); // 月度烹饪 4
        ctx.push("clover_update", { clover: s.res.clover_point });
      }
      if (Number(r.ticket) > 0) {
        s.res.ticket += Number(r.ticket);
        ctx.push("item_update_ticket", { ticket: s.res.ticket });
      }
      for (const it of m.items || []) {
        addItem(s, Number(it.item_id), Number(it.count) || 1);
        const row = s.items.house.find((x) => x.item_id === Number(it.item_id));
        ctx.push("item_update", { item: { item_id: Number(it.item_id), count: row ? row.count : (Number(it.count) || 1) } });
      }
      s.mails.splice(idx, 1); // 删除: 已领取邮件不再出现在任何 mail_load 推送中
    }
    return { code: 0 };
  },
  // 客户端 onClose 日记视图时一次性回传本次已读集合: {id: [..]} (ProtocolList
  // travel_read_note:[["id"],!1], sendReadNote(noteReadIDs)) —— id 是数组。
  // 需持久化: 否则下次 travel_load_note 推送 (如蛙回家) read 全部回到未读,
  // 日记红点 (i_noteRedot ← hasUnreadNote) 重现
  "travel_read_note": (ctx, data) => {
    const ids = Array.isArray(data && data.id) ? data.id : [data && data.id];
    let read = 0;
    for (const raw of ids) {
      const note = ctx.save.note_list.find((n) => n.id === Number(raw));
      if (note) { note.read = 1; read++; }
    }
    if (read > 0) plansMod.event(ctx.save, "noteRead", null, ctx.push); // 周期计划 306 多记笔记
    return { code: 0 };
  },
  // 日记列表请求: 打开日记视图 / 处理 NewNote 事件时客户端主动拉取;
  // 缺此处理器回 {code:0} 无 note_list → 客户端 travelNodeList 被清空
  "travel_load_note": (ctx) => ({ note_list: ctx.save.note_list }),
  // 礼盒列表请求: 打开礼盒视图时 requestData() 主动拉取;
  // 缺此处理器回 {code:0} 无 pictures/specialtys → 礼盒列表被清空
  "travel_load_gift": (ctx) => travel.giftPayload(ctx.save),

  // ---------- 访客: 庭院小伙伴 + 串门邮差 ----------
  // guest_* 全部 needResponse:false —— 客户端本地先行, 服务器必须推送回显权威状态
  "guest_confirm": (ctx, data) => {
    const g = ctx.save.guest;
    if (g && Number(data.id) === g.id) {
      g.confirmed = true; // 后续推送保持 confirmed, 否则客户端重复拉起通知栏
      ctx.push("guest_load", guestMod.guestPayload(ctx.save));
    }
    return { code: 0 };
  },
  "guest_serve": (ctx, data) => {
    // 投喂: {id, item_id} 只收特产 (type 3); 消耗 1 件 + roll 奖励 (走推送)
    const s = ctx.save;
    const g = s.guest;
    if (!g) return { code: 0 };
    if (data.id != null && Number(data.id) !== g.id) return { code: 0 };
    const itemId = Number(data.item_id);
    const isSpecialty = travel.isType(itemId, travel.ITEM_TYPE.SPECIALTY);
    if (!isSpecialty || !takeItem(s, itemId, 1)) return { code: 0 };
    if (guestMod.serveGuest(s, ctx, itemId, addItem, Math.floor(Date.now() / 1000))) {
      cookingMod.event(s, "guestFeed", {}, ctx.push); // 月度烹饪 3: 喂养串门小伙伴
      ctx.push("item_load_items", travel.itemsPayload(s));
      ctx.push("guest_load", guestMod.guestPayload(s));
    }
    return { code: 0 };
  },
  "guest_finish": (ctx) => {
    const s = ctx.save;
    if (s.guest) {
      // 玩家手动送别: 与到期送客同款感谢邮件 (P9)
      const mailed = guestMod.farewellGuestMail(s, s.guest);
      s.guest = null;
      s.guestCoolUntil = Math.floor(Date.now() / 1000) + guestMod.PACE.GUEST_COOL_SEC;
      s.guestNextRollAt = 0;
      ctx.push("guest_load", guestMod.guestPayload(s));
      if (mailed) ctx.push("mail_load", s.mails);
    }
    return { code: 0 };
  },
  "guest_set_expire_time": (ctx, data) => {
    // 客户端只在 expire_time=0 时发送; 记录一次, 其余按服务器自己的时刻表
    const g = ctx.save.guest;
    if (g && !g.expire_time) {
      g.expire_time = Number(data.time) || (Math.floor(Date.now() / 1000) + guestMod.PACE.GUEST_STAY_SEC);
    }
    return { code: 0 };
  },
  "visit_load": (ctx) => guestMod.visitorPayload(ctx.save),
  "visit_open": (ctx) => {
    // 拆邮差礼物: needResponse:false, 奖励必须推送补账 (客户端 addClover/addTicket 均为 stub)
    const s = ctx.save;
    const v = s.visitor;
    if (!v) return { code: 0 };
    if (v.first) {
      // 首访省份: 记入收藏 (客户端把自己推入 acquireList, visit_load.acquire 持久化)
      if (!s.acquireProvinces.includes(v.province)) s.acquireProvinces.push(v.province);
    } else {
      const id = Number(v.gift && v.gift.item_id);
      const n = Number((v.gift && v.gift.count) || 0);
      if (n > 0) {
        if (id === guestMod.GIFT_TICKET_ID) {
          s.res.ticket += n;
          ctx.push("item_update_ticket", { ticket: s.res.ticket });
        } else if (id === guestMod.GIFT_CLOVER_ID) {
          s.res.clover_point += n;
          cookingMod.event(s, "cloverGain", { delta: n }, ctx.push); // 月度烹饪 4
          ctx.push("clover_update", { clover: s.res.clover_point });
        }
      }
    }
    s.visitor = null;
    s.visitorCoolUntil = Math.floor(Date.now() / 1000) + guestMod.PACE.VISITOR_COOL_SEC;
    s.visitorNextRollAt = 0;
    ctx.push("visit_load", guestMod.visitorPayload(s));
    return { code: 0 };
  },
  "visit_set_carpet": (ctx, data) => {
    // 客户端自己 roll 1..8 地毯并上报, 纯记录
    const v = ctx.save.visitor;
    if (v && Number(data.id) >= 1) v.carpet = Number(data.id);
    return { code: 0 };
  },
  "visit_set_expire_time": (ctx, data) => {
    const v = ctx.save.visitor;
    if (v && !v.expire_time) {
      v.expire_time = Number(data.time) || (Math.floor(Date.now() / 1000) + guestMod.PACE.VISITOR_STAY_SEC);
    }
    return { code: 0 };
  },

  // ---------- 涂鸦派对 (drawing.js: 邻居邀请/画具包/聚会) ----------
  // 客户端本地先行 (code==0 才推进本地状态), 服务器推送回显权威状态
  "guest_accept_invit": (ctx, data) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    if (d.state !== 1) return { code: 1 };
    const accept = data.is_accept === true || Number(data.is_accept) > 0;
    if (accept) {
      d.state = 2; // 小屋收拾画具包 (BagTable 派对模式)
    } else {
      drawingMod.reset(d, Math.floor(Date.now() / 1000)); // 拒绝: 冷却后再 roll
    }
    ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
    return { code: 0 };
  },
  // 画具包放入: pos 1=手信食物 (drawingCommonData 三选一) 2..4=特产手信
  "guest_putin_bag": (ctx, data) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    if (d.state !== 2) return { code: 1, conflict: false };
    const pos = Number(data.pos);
    const itemId = Number(data.id);
    if (pos < 1 || pos > d.bag.length) return { code: 1, conflict: false };
    if (d.bag[pos - 1] !== -1) return { code: 1, conflict: true };
    const valid = pos === 1
      ? drawingMod.FOOD_IDS.includes(itemId)
      : pos <= 4 && travel.isType(itemId, travel.ITEM_TYPE.SPECIALTY);
    if (!valid || !takeItem(s, itemId, 1)) return { code: 1, conflict: false };
    d.bag[pos - 1] = itemId;
    // 客户端 consumeHouseItem 只校验不扣减, house 数量靠推送同步
    ctx.push("item_load_items", travel.itemsPayload(s));
    return { code: 0, conflict: false };
  },
  // 画具包取出: 物品回屋
  "guest_takeout_bag": (ctx, data) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    if (d.state !== 2) return { code: 1 };
    const pos = Number(data.pos);
    if (pos < 1 || pos > d.bag.length || d.bag[pos - 1] === -1) return { code: 1 };
    addItem(s, d.bag[pos - 1], 1);
    d.bag[pos - 1] = -1;
    ctx.push("item_load_items", travel.itemsPayload(s));
    return { code: 0 };
  },
  // 画具包锁 toggle: accept→lock (完成, 排程出发) / lock→accept (反悔解锁)
  "guest_lock_bag": (ctx) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    const now = Math.floor(Date.now() / 1000);
    if (d.state === 2) {
      d.state = 3;
      d.departAt = now + randInt(drawingMod.PACE.DEPART_MIN, drawingMod.PACE.DEPART_MAX);
      ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
      return { code: 0 };
    }
    if (d.state === 3) {
      d.state = 2;
      d.departAt = 0;
      ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
      return { code: 0 };
    }
    return { code: 1 };
  },

  // ---------- 旅行事件 ----------
  "client_confirm_event": (ctx, data) => {
    // 客户端看完事件动画后确认; 事件从队列移除 (未确认期间重连会重发)
    const id = Number(data.id);
    const i = ctx.save.events.findIndex((e) => e.id === id);
    if (i >= 0) ctx.save.events.splice(i, 1);
    return { code: 0 };
  },

  // ---------- 相册 (四个桶: album/pending/recover/ads, 见 travel.js 头注) ----------
  "album_load": (ctx, data) => ({
    pictures: ctx.save.pictures.map(travel.withLayers),
    total: ctx.save.pictures.length,
    start: Number(data.start) || 1,
  }),
  "album_load_all": (ctx) => ({
    // id_list 为对象数组; 客户端忽略 total, 用 id_list.length
    id_list: ctx.save.pictures.map((p) => ({ id: p.id, pic_id: p.pic_id, for_ads: 0, visit: 0 })),
  }),
  "album_load_new": (ctx) => ({
    pictures: ctx.save.albumPending.map((p) => Object.assign(travel.withLayers(p), { for_ads: 0 })),
    visted_pic: [],
    has_ads: false,
    is_share: false,
  }),
  "album_load_by_id_list": (ctx, data) => ({
    // 响应键为 pic_list (非 pictures); id_list 为纯数字数组 —— 发错键整段变 no-op
    pic_list: ctx.save.pictures
      .filter((p) => (data.id_list || []).map(Number).includes(p.id))
      .map(travel.withLayers),
  }),
  "album_load_recover": (ctx) => ({
    pictures: ctx.save.albumDeleted.map(travel.withLayers),
    total: ctx.save.albumDeleted.length,
  }),
  "album_save_new": (ctx, data) => {
    // 0=归档 75=相册满(客户端会丢弃待归档行) 76=错误的新照片 id (errcode.json)
    const s = ctx.save;
    const i = s.albumPending.findIndex((p) => p.id === Number(data.id));
    if (i === -1) return { code: 76 };
    if (s.pictures.length >= travel.albumCapacity(s)) {
      s.albumPending.splice(i, 1);
      return { code: 75 };
    }
    s.pictures.push(s.albumPending.splice(i, 1)[0]);
    return { code: 0 };
  },
  "album_delete_new": (ctx, data) => {
    // fire-and-forget: 客户端发请求前已本地移除
    const i = ctx.save.albumPending.findIndex((p) => p.id === Number(data.id));
    if (i >= 0) ctx.save.albumPending.splice(i, 1);
    return { code: 0 };
  },
  "album_delete": (ctx, data) => {
    const s = ctx.save;
    const i = s.pictures.findIndex((p) => p.id === Number(data.id));
    if (i === -1) return { code: 74 }; // 74 = 删除错误的照片 id
    s.albumDeleted.push(s.pictures.splice(i, 1)[0]);
    return { code: 0 };
  },
  "album_recover": (ctx, data) => {
    const s = ctx.save;
    const i = s.albumDeleted.findIndex((p) => p.id === Number(data.id));
    if (i === -1) return { code: 75 };
    if (s.pictures.length >= travel.albumCapacity(s)) return { code: 101 };
    s.pictures.push(s.albumDeleted.splice(i, 1)[0]);
    return { code: 0 };
  },
  "item_load_handbook": (ctx) => travel.handbookPayload(ctx.save),
  // ---------- 礼盒转移 (offline-v2 语义; 客户端按 errcode.json 分支, 未知 code 走成功分支造成 UI 回弹) ----------
  // 特产: 礼盒 → 仓库 (travel_gift_to_bag)
  "travel_gift_to_bag": (ctx, data) => {
    const s = ctx.save;
    const itemId = Number(data.item_id);
    const i = s.specialtys.findIndex((x) => x.item_id === itemId);
    if (i === -1) return { code: 42 }; // 42 = 物品不足 (errcode.json)
    if (s.specialtys[i].count > 1) s.specialtys[i].count -= 1;
    else s.specialtys.splice(i, 1);
    addItem(s, itemId, 1);
    const row = s.items.house.find((x) => x.item_id === itemId);
    ctx.push("item_load_items", travel.itemsPayload(s));
    ctx.push("item_update", { item: { item_id: itemId, count: row ? row.count : 1 } });
    return { code: 0 };
  },
  // 特产: 仓库 → 礼盒 (travel_bag_to_gift)
  "travel_bag_to_gift": (ctx, data) => {
    const s = ctx.save;
    const itemId = Number(data.item_id);
    const SPECIALTY_MAX = 100; // 官方 Define.SPECIALTY_MAX
    const total = s.specialtys.reduce((n, x) => n + x.count, 0);
    if (!takeItem(s, itemId, 1)) return { code: 42 }; // 42 = 物品不足
    if (total >= SPECIALTY_MAX) {
      addItem(s, itemId, 1); // 回滚 (客户端分支 102 提示换存放)
      return { code: 102 }; // 102 = 礼品盒满了
    }
    plansMod.event(s, "giftStore", null, ctx.push); // 周期计划 402 互助的快乐 (收入礼品盒)
    const row = s.specialtys.find((x) => x.item_id === itemId);
    if (row) row.count += 1; else s.specialtys.push({ item_id: itemId, count: 1 });
    ctx.push("travel_load_gift", travel.giftPayload(s));
    return { code: 0 };
  },
  // 照片: 相册 → 礼盒 (travel_album_to_gift)
  "travel_album_to_gift": (ctx, data) => {
    const s = ctx.save;
    const picId = Number(data.picture_id);
    const i = s.pictures.findIndex((p) => p.id === picId);
    if (i === -1) return { code: 74 }; // 74 = 删除错误的照片id
    s.giftPictures.push(s.pictures.splice(i, 1)[0]);
    return { code: 0 };
  },
  // 照片: 礼盒 → 相册 (travel_gift_to_album)
  "travel_gift_to_album": (ctx, data) => {
    const s = ctx.save;
    const picId = Number(data.picture_id);
    const i = s.giftPictures.findIndex((p) => p.id === picId);
    if (i === -1) return { code: 74 };
    if (s.pictures.length >= travel.albumCapacity(s)) return { code: 101 }; // 101 = 相册满了
    s.pictures.push(s.giftPictures.splice(i, 1)[0]);
    return { code: 0 };
  },
  // 丢弃礼盒照片 (travel_gift_delete_album)
  "travel_gift_delete_album": (ctx, data) => {
    const s = ctx.save;
    const id = Number(data.id);
    const i = s.giftPictures.findIndex((p) => p.id === id);
    if (i === -1) return { code: 74 };
    s.giftPictures.splice(i, 1);
    return { code: 0 };
  },

  // ---------- 设置同步 ----------
  "client_set_client": (ctx, data) => {
    // 客户端设置回传: 存为 JSON 字符串
    try {
      const obj = typeof data.client === "string" ? data.client : JSON.stringify(data.client);
      ctx.save.settings.client = obj;
    } catch (e) { /* 忽略非法数据 */ }
    return { code: 0 };
  },

  // ---------- 开发者模式 ----------
  // 官方客户端隐藏 GM 控制台 (gameConfig.showGM 开启): 整行文本作为指令,
  // 返回 {succeed, info} 由控制台直接显示。带参数动作请用 /gm 面板
  "client_gm": (ctx, data) => {
    const gmMod = require("./gm");
    const action = String((data && data.cmd) || "").trim();
    const r = gmMod.run(ctx.save, action, {}, ctx.push);
    if (r.ok) {
      try { saveMod.persist(ctx.save); } catch (e) { /* 忽略 */ }
    }
    return { succeed: r.ok, info: r.info };
  },
};

module.exports = { handlers, pushAllState };
