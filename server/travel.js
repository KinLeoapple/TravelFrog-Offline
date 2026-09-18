/**
 * 旅行循环引擎 (M2): 蛙出门/回家状态机 + 奖励 roll + 事件生成 + 相册 hydrate
 *
 * 官方语义 (main.min.js 逆向 + 客户端 Define 常量):
 *   - 蛙自行出门, 无客户端命令; 服务器推 GoTravel(1) / BackHome(2) 事件
 *   - 事件对象 = TravelEventInfo {id, evt_type, evt_id, evt_value[], evt_string[], evt_pic[]}
 *     · id         唯一实例 id (client_confirm_event 回传它)
 *     · evt_value  BackHome = [_, _, clover, ticket, CollectionId(-1=无), ...物品id]
 *     · GoTravel   evt_value[1] > 0 => "精力充沛地出去旅行了"
 *   - 蛙回家收入已在服务器入账; 客户端 load_events 时 subClover(evt_value[2])
 *     暂时隐藏, 点开事件动画 AddCloverTween 加回 —— 显示与真值最终一致
 *   - 照片: 相册(album_load)与待归档(album_load_new)两个桶; 客户端只渲染不组合,
 *     layers = [resources.json 索引, x, y], 画布 500x350 (photo.js 组合: 直查表 + 公式)
 *   - 日志: note_list {id, read, timestamp}, id 必须存在于 Note.json
 *
 * 节奏 (客户端 Define 官方值, env 可覆盖):
 *   TRAVEL_TIME_MIN=60min(地板, 上限取 6x), FROG_RESTTIME 400~900s,
 *   FROG_DRIFTRETURNTIME 10~20min(放浪=没带便当的短途)
 *   env: FROG_TRAVEL_MIN_SEC / FROG_TRAVEL_MAX_SEC / FROG_IDLE_MIN_SEC /
 *        FROG_IDLE_MAX_SEC / FROG_DRIFT_MIN_SEC / FROG_DRIFT_MAX_SEC
 */
const fs = require("fs");
const path = require("path");
const saveMod = require("./save");
const guestMod = require("./guest");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");

// ---------- 配置表 ----------
/** 表可能是数组或 {id: row} 对象 (各表导出格式不一), 统一转行数组 */
function rows(name, dir) {
  const t = JSON.parse(fs.readFileSync(path.join(CFG_DIR, dir || "MainData", name), "utf-8"));
  if (Array.isArray(t)) return t;
  return Object.keys(t).map((k) => t[k]).filter((r) => r && typeof r === "object");
}

// 照片图层: photo.js 组合 (官方抓包直查表 + Picture 表公式)
const photo = require("./photo");
const merchantMod = require("./merchant");
const flowerpotMod = require("./flowerpot");
const furniMod = require("./furni");
const decorationMod = require("./decoration");
const achieveMod = require("./achieve");
const PICTURE_DB = rows("Picture.json", "PictureData").filter((p) => typeof p.id === "number");

// 照片池: 官方组合可用 (背景坐标齐全 + 有蛙照片的姿势贴图可解析),
// 否则剔除 (下发后客户端遍历 undefined.layers 直接异常 → 拼接异常/空白)
// 直查表照片无条件信任: 官方蛙层命名无统一后缀 (roof1_2qw/wet0 等),
// officialHasFrog 识别不了 ≠ 缺蛙, 真机实录数据即最终显示效果。
const PICTURE_IDS = PICTURE_DB
  .filter((p) => {
    if (photo.hasOfficialLayers(p.id)) return true;
    const official = photo.composeLayers(p.id);
    if (official) {
      // 官方设计有蛙 (frogPose 非空) 但贴图映射缺失 → 组合结果缺蛙, 剔除
      if (p.frogPose && p.frogPose !== "" && !photo.officialHasFrog(p.id)) return false;
      return true;
    }
    return false;
  })
  .map((p) => p.id);
const SPECIALTY_IDS = rows("Specialty.json")
  .map((r) => r.itemId).filter((v) => v > 0);
const COLLECTION_IDS = rows("Collection.json")
  .map((c) => c.id).filter((v) => typeof v === "number");
const NOTE_IDS = rows("Note.json", "TravelNote")
  // 仅可见笔记: 客户端 TravelNoteView 按 config.type 分 tab (1=见闻 2=旅友);
  // 无 type 的 attach 子笔记 (20010/20200 等 Visit_Min 附属) 不进任何 tab,
  // 客户端无法读取 → NEW_NOTE 红点永久常亮, 一律不发
  .filter((n) => n.type === 1 || n.type === 2)
  .map((n) => n.id).filter((v) => typeof v === "number");
const ITEM_BY_ID = new Map(rows("Item.json").map((i) => [i.id, i]));

// 物品类型 (客户端 Define.ItemType / 社区考据)
const ITEM_TYPE = { LUNCHBOX: 0, AMULET: 1, TOOLS: 2, SPECIALTY: 3, MATERIAL: 16 };

const env = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);

// ---------- 蛙在家动作轮换 (客户端 Define 逆向) ----------
// Frogpattern: 3 种活动序列 (服务器私有表, 客户端只定义不读取)
// token → motion 映射 (FrogMotionNum): doku=0 读书, doku_s=1 打盹, write=2 写字,
// make=3 做东西, eat=4 吃饭; motion=2 (hikki_ie 书桌写字) 是日记入口:
// 客户端点击写字的蛙且 hasUnreadNote() 时打开日记视图
const FROGPATTERN = {
  0: ["eat", "eat", "eat", "eat", "doku", "doku", "doku", "doku", "doku_s", "doku_s", "make", "make", "make"],
  1: ["eat", "eat", "doku", "doku", "doku", "doku", "doku_s", "doku_s", "write", "write", "write", "write", "write"],
  2: ["write", "write", "write", "write", "eat", "eat", "make", "make", "make", "make", "write", "write", "write"],
};
const FROGMOTIONNUM = { doku: 0, doku_s: 1, write: 2, make: 3, eat: 4 };
const FROG_PATTERN_MAX = 3;
// 单个动作持续秒数 (官方无表, offline-v2 同款默认; env FROG_MOTION_SEC 可覆盖)
const FROG_MOTION_SEC = env("FROG_MOTION_SEC", 45);

/**
 * 在家动作轮换 (offline-v2 同款): 每 FROG_MOTION_SEC 秒按 Frogpattern 序列推进。
 * 轮换让蛙在读书/打盹/写字/做手工/吃饭间切换 —— 写字动作 (motion=2) 是客户端
 * 的日记入口, 缺轮换则蛙永远停在一个动作, 无新动作可看也无法点出日记。
 * 夜间 (21:00~06:00) 蛙睡觉 (motion 10-13 sleep_1~4), 客户端 isFrogSleep 关灯。
 * @returns {boolean} 动作是否变化 (调用方推送 client_load_role)
 */
function refreshFrogMotion(s, now) {
  const f = s.frog;
  if (f.status !== 0) return false;          // 只在在家时轮换
  if (now < (f.motionNextAt || 0)) return false;
  // 工作台制作中: 蛙在庭院工作台干活 —— FrogMotionName 5-9 (saw/brush/knock/knit/cut),
  // 庭院 updateFlogStatus 只认这 5 个 → player_mc 播 spine 工具动画; 室内版 switch
  // 无这些 case → 蛙不在室内 (在庭院干活)。轮换 = 换工具, 看起来像真的在做东西
  if (furniMod.crafting(s)) {
    f.motion = 5 + Math.floor(Math.random() * 5);
    f.motionNextAt = now + FROG_MOTION_SEC;
    return true;
  }
  // 夜间睡觉 (21:00~06:00): motion 10-13 = sleep_1~4, 客户端 isFrogSleep 判定关灯
  // 白天醒来恢复正常动作序列 (不推进 pattern step, 跳过睡眠时段)
  const ht = hoursTypeNow();
  if (ht === 3 || ht === 4) {
    f.motion = 10 + Math.floor(Math.random() * 4);
    f.motionNextAt = now + FROG_MOTION_SEC;
    return true;
  }
  if (f.motionPattern == null) {
    f.motionPattern = Math.floor(Math.random() * FROG_PATTERN_MAX);
    f.motionStep = 0;
  }
  const seq = FROGPATTERN[f.motionPattern];
  if (!Array.isArray(seq) || seq.length === 0) return false;
  // 工作台门控 (P12): 商贩来过 (lastVisit>0, 工作台常驻) 或正在场时才有"做东西"
  // 动作 —— 否则室内没有工作台, 蛙对空气制作穿帮, 跳到序列下一个非 make token
  const benchUnlocked = !!(s.merchant && (s.merchant.shop || s.merchant.lastVisit > 0));
  do {
    f.motionStep = ((f.motionStep || 0) + 1) % seq.length;
  } while (!benchUnlocked && seq[f.motionStep] === "make");
  f.motion = Number(FROGMOTIONNUM[seq[f.motionStep]]) || 0;
  f.motionNextAt = now + FROG_MOTION_SEC;
  return true;
}

// ---------- 节奏参数 ----------
const PACE = {
  TRAVEL_MIN: env("FROG_TRAVEL_MIN_SEC", 60 * 60),   // 官方 TRAVEL_TIME_MIN=60min
  TRAVEL_MAX: env("FROG_TRAVEL_MAX_SEC", 6 * 60 * 60), // 官方无上限, 取 6x
  IDLE_MIN: env("FROG_IDLE_MIN_SEC", 400),           // 官方 FROG_RESTTIME=400
  IDLE_MAX: env("FROG_IDLE_MAX_SEC", 900),           // 官方 FROG_RESTTIME_MAX=900
  DRIFT_MIN: env("FROG_DRIFT_MIN_SEC", 10 * 60),     // 官方 FROG_DRIFTRETURNTIME=10min
  DRIFT_MAX: env("FROG_DRIFT_MAX_SEC", 20 * 60),
  // 出门等待窗 (3~8min): 放好便当/点「准备完成」后, 蛙在这个节奏内自行出门
  // (正常游戏节奏 —— 2026-09-19 起「完成」不再立即出发, offline-v2 的即发语义废弃)
  WAIT_MIN: env("FROG_WAIT_MIN_SEC", 3 * 60),
  WAIT_MAX: env("FROG_WAIT_MAX_SEC", 8 * 60),
};

// 奖励概率 (官方 Define: SPECIALTY_PER=60, COLLECT_PER=15, BASE_PICTURE_PER=70, PICTURE_GETMAX=4)
const ROLL = {
  CLOVER_MIN: 1, CLOVER_MAX: 3,
  TICKET_CHANCE: 0.45,
  SPECIALTY_PER: 0.60,
  COLLECT_PER: 0.15,
  PICTURE_PER: 0.70,
  PICTURE_MAX: 4,
  ITEM_MAX: 10,       // 官方 TRAVEL_ITEM_GETMAX
  NOTE_CHANCE: 0.5,   // 一段旅行带一条日志 (自定: 官方由地图途经点决定)
};

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function chance(p) { return Math.random() < p; }

// ---------- 装备与准备 ----------

/** 包或桌上是否有可携带之物 (便当/护身符/道具; 客户端首次引导文案: 桌上放好东西蛙也会自己挑) */
function tripPrepared(s) {
  if ((s.items.bag || []).some((id) => id != null && id !== -1)) return true;
  return (s.items.desk || []).some((id) => isType(id, ITEM_TYPE.LUNCHBOX)
    || isType(id, ITEM_TYPE.AMULET) || isType(id, ITEM_TYPE.TOOLS));
}

function isType(id, type) {
  const it = ITEM_BY_ID.get(Number(id));
  return !!it && it.type === type;
}

/**
 * 出门携带结算 (offline-v2 语义):
 *   - 便当: 包的便当槽(bag[0]) → 桌上任一便当; 出门即消耗
 *   - 桌上补齐: 包内缺护身符时从桌上拿 1 个; 道具补足 2 个
 *     (客户端首跑文案「桌上放好东西蛙也会自己挑」)
 *   - 消耗品 (Item.spend===1, 如四叶草护身符): 旅行即消耗, 不归还
 *   - 耐用品 (spend!==1, 如幸运铃/帐篷): 随行, 回家后桌上物品归桌、
 *     包内物品入仓库, 再由 autoPackFromDesk 从桌上自行装包
 *     (桌上空则包保持清空 —— 官方回家清包语义)
 * 返回 { lunchId, lunchPrice, carried: [{id, slot, from}] }
 */
function provisionTrip(s) {
  const bag = s.items.bag;
  const desk = s.items.desk;
  const carried = [];
  let lunchId = -1;

  // 便当: 包的便当槽(bag[0]) → 桌上任一便当
  if (isType(bag[0], ITEM_TYPE.LUNCHBOX)) {
    lunchId = bag[0];
    bag[0] = -1; // 便当出门即消耗
  } else {
    const di = desk.findIndex((id) => isType(id, ITEM_TYPE.LUNCHBOX));
    if (di >= 0) { lunchId = desk[di]; desk[di] = -1; }
  }
  // 随行装备 (回家还原): 包内其余物品
  for (let i = 0; i < bag.length; i++) {
    if (bag[i] !== -1 && i !== 0) { carried.push({ id: bag[i], slot: i, from: "bag" }); bag[i] = -1; }
  }
  // 桌上补齐: 缺护身符拿 1 个, 道具补足 2 个 (offline-v2 deskPick 语义)
  const bagTools = carried.filter((r) => isType(r.id, ITEM_TYPE.TOOLS)).length;
  const hasAmulet = carried.some((r) => isType(r.id, ITEM_TYPE.AMULET));
  const deskPick = (wantType, limit) => {
    let taken = 0;
    for (let i = 0; i < desk.length; i++) {
      if (taken >= limit || desk[i] === -1 || !isType(desk[i], wantType)) continue;
      carried.push({ id: desk[i], slot: i, from: "desk" });
      desk[i] = -1;
      taken++;
    }
  };
  if (!hasAmulet) deskPick(ITEM_TYPE.AMULET, 1);
  deskPick(ITEM_TYPE.TOOLS, Math.max(0, 2 - bagTools));

  const lunch = ITEM_BY_ID.get(lunchId);
  return { lunchId, lunchPrice: lunch ? lunch.price : 0, carried };
}

/** 物品是否消耗品 (官方 Item.spend: 1=一次性, 其余=耐用) */
function isConsumable(id) {
  const it = ITEM_BY_ID.get(Number(id));
  return !it || Number(it.spend) === 1; // 未知物品按消耗处理 (保守: 不回滚库存)
}

/**
 * 装备归位 (回家清包语义):
 *   - 消耗品 (spend=1) 已用掉不归还
 *   - 桌上耐用品归还原桌槽 (回家后蛙会从桌上自行装包)
 *   - 包内耐用品入仓库 (house) —— 蛙回家清包, 不把上次带的装备留在包里,
 *     否则桌上空时背包仍非空 (穿帮), 也挡住了下一轮从桌上自行装包
 */
function returnGear(s, carried) {
  for (const g of carried || []) {
    if (isConsumable(g.id)) continue; // 四叶草等一次性护身符, 旅行已消耗
    if (g.from === "desk") {
      const slot = Math.min(Math.max(g.slot, 0), s.items.desk.length - 1);
      if (s.items.desk[slot] === -1) s.items.desk[slot] = g.id;
      else if (s.items.desk.indexOf(g.id) === -1) addItemSafe(s, g.id, 1);
    } else {
      // 包内耐用品入仓库 (回家清包)
      addItemSafe(s, g.id, 1);
    }
  }
}

/**
 * 回家自行装包 (官方语义: 蛙回家后看桌上有什么就拿什么装包, 准备下一趟):
 *   - bag 槽位类型: [0]=便当 [1]=护身符 [2][3]=道具
 *   - 从桌上按类型各取一件填入空槽; 桌上空则包保持清空
 *   只填空槽, 不覆盖 (returnGear 已清包, 正常路径 bag 全空)
 */
function autoPackFromDesk(s) {
  const bag = s.items.bag;
  const desk = s.items.desk;
  const take = (type, bagSlot) => {
    if (bag[bagSlot] != null && bag[bagSlot] !== -1) return;
    const di = desk.findIndex((id) => id != null && id !== -1 && isType(id, type));
    if (di >= 0) { bag[bagSlot] = desk[di]; desk[di] = -1; }
  };
  take(ITEM_TYPE.LUNCHBOX, 0);
  take(ITEM_TYPE.AMULET, 1);
  for (const slot of [2, 3]) take(ITEM_TYPE.TOOLS, slot);
}

function addItemSafe(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += count;
  else s.items.house.push({ item_id: itemId, count });
}

// ---------- 奖励 roll ----------

/**
 * 旅行收获 roll (官方概率, 无地图系统的均匀采样近似)
 * 便当品质(价格)提升照片概率与"精力充沛"标志 —— 便当 effects 数据属官方服务器
 * 私有, 本地无表, 以价格代理 (自定换算, 10~100 元 → 0~30% 加成)
 * 放浪 (没带便当的短途) 只带 1~2 三叶草回家, 无照片/特产/收藏/票据
 * (offline-v2: "a stray trip brings back neither a photo nor a souvenir")
 */
function rollTripRewards(lunchPrice, stray, lunchId, s) {
  const out = { clover: 0, ticket: 0, items: [], collection: -1, pictures: [], noteId: -1 };
  if (stray) {
    out.clover = randInt(1, 2);
    return out;
  }
  // 月度烹饪食物 (cookingData.item_id) 必出对应照片 (官方 "月度烹饪食物必出特殊SSR");
  // 已拥有的不重复发 (下方入桶按 pic_id 去重)
  if (lunchId != null && lunchId !== -1 && s) {
    const pic = require("./cooking").guaranteedPic(lunchId, s.pictures, s.albumPending);
    if (pic > 0) out.pictures.push(pic);
  }
  out.clover = randInt(ROLL.CLOVER_MIN, ROLL.CLOVER_MAX);
  if (chance(ROLL.TICKET_CHANCE)) out.ticket = 1;
  if (SPECIALTY_IDS.length && chance(ROLL.SPECIALTY_PER)) {
    out.items.push(SPECIALTY_IDS[randInt(0, SPECIALTY_IDS.length - 1)]);
  }
  if (COLLECTION_IDS.length && chance(ROLL.COLLECT_PER)) {
    out.collection = COLLECTION_IDS[randInt(0, COLLECTION_IDS.length - 1)];
  }
  const lunchBonus = Math.min(Math.max((lunchPrice - 10) / 90, 0), 1) * 0.30; // 0~30%
  const picPer = Math.min(ROLL.PICTURE_PER * (1 + lunchBonus), 0.95);
  for (let i = 0; i < ROLL.PICTURE_MAX; i++) {
    if (!chance(picPer)) break;
    out.pictures.push(PICTURE_IDS[randInt(0, PICTURE_IDS.length - 1)]);
  }
  if (NOTE_IDS.length && chance(ROLL.NOTE_CHANCE)) {
    out.noteId = NOTE_IDS[randInt(0, NOTE_IDS.length - 1)];
  }
  out.items = out.items.slice(0, ROLL.ITEM_MAX);
  return out;
}

// ---------- 事件 ----------

function makeEvent(s, evtType, evtValue, evtString) {
  return {
    id: s.travel.eventSeq++,
    evt_type: evtType,
    evt_id: s.travel.eventSeq, // 关联 id (GoTravel/BackHome 无配置语义, 顺延)
    evt_value: evtValue || [],
    evt_string: evtString || [],
    evt_pic: [],
  };
}

// ---------- 状态机 ----------

/**
 * 惰性推进旅行状态机: 每次协议交互前调用, 追平真实时间 (可穿越多轮旅行)。
 * ctx.push 在线时实时推送; 离线结算 (登录追平) 时不推, 由 load_all_info 全量下发。
 * 同时推进: 三叶草到期重生 (客户端无本地生长计时, 状态由服务器权威下发)、
 *           在家动作轮换 (写字动作是客户端日记入口)、
 *           天气 (season+hours_type 驱动庭院场景/昼夜贴图)、
 *           访客 (庭院小伙伴 + 串门邮差)。
 */
function travelTick(s, push) {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  // 三叶草重生: 到期槽位重置可收 + 重掷元素。
  // 客户端 CloverFarm.initData 只在庭院场景重建时按 cloverGrowList 渲染成熟
  // 槽位, 不推送则客户端列表停在收割时刻的状态, 切场景后看不到新长出的草
  if (saveMod.refreshClovers(s)) {
    if (push) push("clover_load_clovers", s.clovers);
    changed = true;
  }
  // 在家动作轮换 (45s): 读书/打盹/写字/做手工/吃饭/睡觉 —— 推送 client_load_role
  // 让客户端实时切换蛙动画 (updateFlogStatus)。否则会话内只看到登录时的一种动作。
  // MainOutView.reset() 会触发视角回中, 但动作变化的重要性 > 偶尔的视角调整
  if (refreshFrogMotion(s, now)) {
    if (push) push("client_load_role", rolePayload(s));
    changed = true;
  }
  // 天气/季节: 变化时推送 (客户端 getSeasonKey 用 season""hours_type 选场景)
  if (refreshWeather(s)) {
    if (push) push("weather_load", weatherPayload(s));
    changed = true;
  }
  // 访客: 小伙伴到访/送客 + 邮差到访/离开
  if (guestMod.guestTick(s, push, now)) changed = true;
  // 旅行商人嘟嘟: 限时家具商店到访/离场 + 工作台制作结算 (与小伙伴/邮差独立, 客户端渲染在家具工作台旁)
  if (merchantMod.merchantTick(s, push, now)) changed = true;
  // 栽培花盆: 空槽自动播种 + 成长推进; 升阶吸收堆肥 → 推送刷新土地肥力贴图
  // (植物 stage 客户端进庭院时拉取 furniture_load_flowerpot, 不在此推)
  if (flowerpotMod.flowerpotTick(s, now)) {
    if (push) push("furniture_load_compost", furniMod.compostPayload(s));
    changed = true;
  }
  // 挂兜攒钱: 展示中每 POCKET_SEC 攒草 (红点 clover≥50 亮, 推送刷新)
  if (furniMod.pocketTick(s, now)) {
    if (push) push("furniture_load_pocket", furniMod.pocketPayload(s));
    changed = true;
  }
  // 装饰插花绽放: status 1→2 (花苞→绽放, 客户端 pic[status-1] 换图)
  if (decorationMod.decorateTick(s, now)) {
    if (push) push("client_load_decorate", decorationMod.decoratePayload(s));
    changed = true;
  }
  for (let guard = 0; guard < 32; guard++) {
    if (s.travel.phase === "home") {
      if (s.travel.departAt > now) break;
      // 涂鸦派对守卫: 已受邀/锁包 (drawing.state 2~3) 或蛙在聚会 (status 3)
      // —— 旅行出门顺延 (不直接清 departAt, 保持 home 相位等待派对结算)
      if (s.frog.status === 3 || (s.drawing && s.drawing.state >= 2 && s.drawing.state <= 3)) {
        s.travel.departAt = now + randInt(PACE.WAIT_MIN, PACE.WAIT_MAX);
        break;
      }
      if (!tripPrepared(s)) {
        // 没准备就不出门 (官方语义: 蛙等玩家收拾包/桌), 按 WAIT 节奏重查;
        // 中途收走便当会让已排程的出门落回这里 → 蛙继续在家等
        s.travel.departAt = now + randInt(PACE.WAIT_MIN, PACE.WAIT_MAX);
        break;
      }
      departFrog(s, push, now);
      changed = true;
    } else {
      if (s.travel.returnAt > now) break;
      returnFrog(s, push, now);
      changed = true;
    }
  }
  // 称号兜底检查 (30s 粒度): 物品数量/24h 未归/插花绽放/登录天数等条件变化
  if (achieveMod.check(s, now)) changed = true;
  return changed;
}

/** 完成背包后的出门排程: WAIT 窗口内自行出发 (travelTick 到点触发并推送,
 *  离线关窗也由登录追平; 窗口内玩家仍可改包, 出发按最终内容结算) */
function scheduleDeparture(s) {
  if (s.travel.phase !== "home") return;
  s.travel.departAt = Math.floor(Date.now() / 1000) + randInt(PACE.WAIT_MIN, PACE.WAIT_MAX);
}

function departFrog(s, push, now) {
  const plan = provisionTrip(s);
  s.frog.status = 1; // 1 = 旅行中 (客户端 Tabikaeru.Game.isHome 判 0)
  s.frog.motion = 0;
  s.travel.phase = "traveling";
  s.travel.stray = plan.lunchId === -1;
  s.travel.plan = plan;
  s.travel.departAt = now;

  // 时长窗口: 放浪用短窗; 正常旅行 1~6h × 便当品质修正 (价格代理)
  let window = s.travel.stray
    ? randInt(PACE.DRIFT_MIN, PACE.DRIFT_MAX)
    : randInt(PACE.TRAVEL_MIN, PACE.TRAVEL_MAX);
  if (!s.travel.stray) {
    const factor = 1 + Math.min(Math.max(plan.lunchPrice - 10, 0) / 90, 1) * 0.6; // 10~100元 → 1.0~1.6x
    window = Math.round(window * factor);
  }
  // 窗口地板 20s 防闪回; 但不超过 env 节奏下限 (快节奏测试 TRAVEL_MIN=3 时取 3)
  s.travel.returnAt = now + Math.max(Math.min(20, PACE.TRAVEL_MIN), window);
  s.travel.tripCount = (s.travel.tripCount || 0) + 1;
  achieveMod.onDepart(s, plan.lunchId); // 称号: 连续 4 次带果汁出发
  require("./plans").onDepart(s, plan, push); // 周期计划: 便当/满包/满桌出门 (懒加载避循环依赖)
  require("./cooking").event(s, "depart", {}, push); // 月度烹饪 5: 出门旅行 (懒加载避循环依赖)
  require("./pray").onDepart(s, now); // 祈愿: 60% 开始制作愿望牌 (懒加载避循环依赖)
  if (plan.lunchId !== -1) require("./ency").onEatFood(s, plan.lunchId); // 图鉴: 携带食物解锁

  const ev = makeEvent(s, 1 /* GoTravel */, [0, plan.lunchPrice >= 50 ? 1 : 0]);
  s.events.push(ev);
  if (push) {
    push("client_load_role", rolePayload(s));
    push("item_load_items", itemsPayload(s));
    push("notify_new_event", { event: ev });
  }
  return ev;
}

function returnFrog(s, push, now) {
  const plan = s.travel.plan || { carried: [], lunchPrice: 0 };
  const r = rollTripRewards(plan.lunchPrice || 0, s.travel.stray, plan.lunchId, s);

  s.frog.status = 0; // 回家
  s.frog.motion = 0; // 有效动作 (FrogMotionName[-1]=undefined 会让客户端 switch 直接 return, 蛙不渲染); 下一拍 refreshFrogMotion 轮换
  // 回家重掷行为序列 (Frogpattern 0~2): 固定单序列会让部分存档长期以某个动作为主
  // (如 pattern2 写字占 7/13) —— 每次旅行归来换一套在家节奏, 观感更接近官方
  s.frog.motionPattern = null; // 下次轮换时重掷
  s.frog.motionStep = 0;
  s.frog.motionNextAt = 0; // 立即触发下一拍轮换 (不沿用旅行前的旧计时器)
  s.res.clover_point += r.clover;
  s.res.ticket += r.ticket;
  if (r.clover > 0) require("./cooking").event(s, "cloverGain", { delta: r.clover }, push); // 月度烹饪 4
  returnGear(s, plan.carried);
  autoPackFromDesk(s); // 桌上有东西则自行装包 (桌上空则包保持清空)

  // 物品全部入屋 (物品栏)。特产(type3)同时记入图鉴 handbook;
  // 官方语义: 投喂小伙伴的弹窗 = PlayerBag(Specialty) 读 house 列表,
  // consumeHouseItem 也从 house 扣 —— 特产必须进 house 才可见可投喂。
  // 礼盒(s.specialtys)是玩家用 travel_bag_to_gift 主动存放的收藏, 不自动写。
  for (const id of r.items) {
    const meta = ITEM_BY_ID.get(id);
    if (meta && meta.type === ITEM_TYPE.SPECIALTY) {
      addItemSafe(s, id, 1);
      if (!s.handbook.specialtys.includes(id)) s.handbook.specialtys.push(id);
      continue;
    }
    addItemSafe(s, id, 1);
  }
  if (r.collection >= 0 && !s.handbook.collections.includes(r.collection)) {
    s.handbook.collections.push(r.collection);
  }
  // 日志 (id 必须在 Note 表内, 客户端会静默丢弃未知 id; 去重)
  if (r.noteId >= 0 && !s.note_list.some((n) => n.id === r.noteId)) {
    s.note_list.push({ id: r.noteId, read: 0, timestamp: now }); // read 0/1 (客户端 0 == read 判未读)
  }
  // 旅行伙伴日记 (P10): 2000~2002 是"和伙伴同行"特殊日记, 也是阁楼礼品盒的
  // 解锁钥匙 (GiftBoxModel.isOpen: note_list 含 2000~2002 任一即永久解锁)。
  // 通用日志池 191 条随机命中仅 ~1.6%/次, 宝箱形同虚设 —— 单独以 40% 概率 roll,
  // 集齐 3 条后不再发
  if (Math.random() < 0.4) {
    const friendNote = [2000, 2001, 2002].filter((id) => !s.note_list.some((n) => n.id === id));
    if (friendNote.length) {
      s.note_list.push({ id: friendNote[randInt(0, friendNote.length - 1)], read: 0, timestamp: now });
    }
  }
  // 祈愿木片 (pray.js): 25% 带回 1 枚随机木片 (拼接紫檀木护符的材料)
  const prayChip = require("./pray").rollChip();
  if (prayChip > 0) addItemSafe(s, prayChip, 1);
  // 动态照片材料 (animpic.js): 12% 带回显影液/动态相框
  const apDrop = require("./animpic").rollDrop();
  if (apDrop > 0) addItemSafe(s, apDrop, 1);
  // 照片: 入待归档桶 (album_load_new 下发, album_save_new 归档), pic_id 去重
  require("./plans").onReturn(s, r, push); // 周期计划: 目的地照/新地点/材料 (入桶前快照判新)
  let newPics = 0;
  for (const pic of r.pictures) {
    if (s.pictures.some((p) => p.pic_id === pic) || s.albumPending.some((p) => p.pic_id === pic)) continue;
    s.pictureSeq = (s.pictureSeq || 0) + 1;
    s.albumPending.push({ id: s.pictureSeq, pic_id: pic, read: 0, new: 1 });
    newPics++;
  }
  if (newPics > 0) require("./cooking").event(s, "photoGain", { delta: newPics }, push); // 月度烹饪 6
  // 祈愿: 归档途中完成的愿望牌 (wish_new → wishs), 推 pray_load_grays 刷新红点/列表
  if (require("./pray").onReturn(s) && push) {
    push("pray_load_grays", require("./pray").payload(s));
  }

  // 下一轮: 在家休息后再考虑出门
  s.travel.phase = "home";
  s.travel.plan = null;
  s.travel.returnAt = 0;
  s.travel.departAt = now + randInt(PACE.IDLE_MIN, PACE.IDLE_MAX);
  // 行囊解锁: 「准备完成」只管一次出门, 蛙到家即新一轮收拾 —— 客户端 bagLock
  // (item_load_items 的 bag_completed) 不重置则背包永久锁定, 无法取出/放入
  // (回家清包 + 桌上自行装包已在 returnGear + autoPackFromDesk 完成)
  s.items.bag_completed = false;

  const ev = makeEvent(s, 2 /* BackHome */,
    [0, 0, r.clover, r.ticket, r.collection, ...r.items]);
  s.events.push(ev);
  // 称号结算: 旅行次数/收藏/三叶草/短途 (出发不到 30 分钟回家) 等在此刻判定
  achieveMod.check(s, now, { tripWindow: now - s.travel.departAt });
  if (push) {
    push("client_load_role", rolePayload(s));
    push("clover_update", { clover: s.res.clover_point });
    push("item_update_ticket", { ticket: s.res.ticket });
    push("item_load_items", itemsPayload(s));
    push("item_load_handbook", handbookPayload(s));
    if (push) push("museum_load", require("./museum").payload(s)); // 博物馆照片墙随收藏点亮
    push("travel_load_gift", giftPayload(s));
    push("travel_load_note", { note_list: s.note_list });
    // 新照片实时推送: 客户端"新照片"桶(newPictureInfoList)只由 album_load_new 驱动,
    // 缺推送则相册入口无红点/新照片不可见, 刷新后才由全量同步呈现
    if (newPics > 0) {
      push("album_load_new", {
        pictures: s.albumPending.map((p) => Object.assign(withLayers(p), { for_ads: 0 })),
        visted_pic: [],
        has_ads: false,
        is_share: false,
      });
    }
    push("notify_new_event", { event: ev });
    // 新笔记不推 NewNote(15) 事件: 客户端事件队列的 NewNote case 只 loadNote 不调
    // p() 确认 (default 分支都调), 事件会永久卡在 travelEventList → 庭院事件感叹号
    // 不消失。笔记 model 更新由上面已推的 travel_load_note 承担, NewNote 纯冗余
  }
  return ev;
}

// ---------- 天气 (客户端 WeatherModel 用 season+hours_type 选庭院场景贴图) ----------

function seasonNow() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 1;   // spring
  if (m >= 6 && m <= 8) return 2;   // summer
  if (m >= 9 && m <= 11) return 3;  // autumn
  return 4;                         // winter
}
function hoursTypeNow() {
  const h = new Date().getHours();
  if (h >= 6 && h < 18) return 1;   // day
  if (h >= 18 && h < 21) return 2;  // evening
  if (h >= 21) return 3;            // night
  return 4;                         // late night (0..5)
}
/** 天气枚举 1..9 按日确定性变化 (原版由服务器调度, 不可考; offline-v2 同款) */
function weatherNow() {
  const d = new Date();
  return ((d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate()) % 9) + 1;
}
function weatherPayload(s) {
  if (!s.weather) s.weather = { season: seasonNow(), hours_type: hoursTypeNow(), weather: weatherNow() };
  return { season: s.weather.season, hours_type: s.weather.hours_type, weather: s.weather.weather };
}
/** 天气刷新: 变化时返回 true (调用方推送 weather_load 驱动庭院换景) */
function refreshWeather(s) {
  const season = seasonNow(), hours_type = hoursTypeNow(), weather = weatherNow();
  if (s.weather && s.weather.season === season && s.weather.hours_type === hours_type
    && s.weather.weather === weather) return false;
  s.weather = { season, hours_type, weather };
  return true;
}

// ---------- 下发 payload ----------

function rolePayload(s) {
  // frog 构造干净对象: 内部字段 (motionPattern/motionStep/motionNextAt) 不下发
  return {
    uid: s.uid,
    res: { clover_point: s.res.clover_point, ticket: s.res.ticket },
    settings: {
      client: s.settings.client,
      push_switch: s.settings.push_switch,
      rank_switch: s.settings.rank_switch,
    },
    misc: s.misc,
    frog: {
      name: s.frog.name,
      cur_achieve: s.frog.cur_achieve,
      achieves: s.frog.achieves,
      achieves_time: s.frog.achieves_time,
      status: s.frog.status,
      motion: s.frog.motion,
      icon: s.frog.icon,
      pic_show: s.frog.pic_show,
      today_step: s.frog.today_step,
      decoration: s.frog.decoration,
      taobao_data: s.frog.taobao_data,
    },
  };
}

function itemsPayload(s) {
  return {
    house: s.items.house,
    bag: s.items.bag,
    desk: s.items.desk,
    bag_completed: s.items.bag_completed,
    bag_conflict: false,
    desk_conflict: false,
    gacha: s.items.gacha,
  };
}

function handbookPayload(s) {
  return { collections: s.handbook.collections, specialtys: s.handbook.specialtys };
}

/** 礼盒 (travel_load_gift): 特产堆 + 礼盒照片桶 (travel_album_to_gift 转入的照片) */
function giftPayload(s) {
  return {
    pictures: (s.giftPictures || []).map(withLayers),
    specialtys: s.specialtys,
  };
}

/** 照片补图层: photo.js 组合 (直查表 + 公式, 蛙层用真机实测坐标)。
 *  官方 layers = 背景 + 1 蛙 + 前景, 无旅伴层
 *  (travellers 字段客户端不渲染 —— 官方抓包 43/43 验证) */
function withLayers(p) {
  if (!p) return p;
  const official = photo.composeLayers(p.pic_id);
  return official ? Object.assign({}, p, { layers: official }) : p;
}

/** 相册容量: 基础页 + 商店扩容 (相册扩容 itemId=204002, 每张 1 页×6 格) */
const ALBUM_BASE_PAGES = 30;
const ALBUM_PAGE_SIZE = 6;
const ALBUM_EXPAND_ITEM = 204002;
function albumCapacity(s) {
  const row = (s.items.house || []).find((h) => Number(h.item_id) === ALBUM_EXPAND_ITEM);
  const expansions = row ? Math.max(0, Math.min(Number(row.count) || 0, 20)) : 0;
  return (ALBUM_BASE_PAGES + expansions) * ALBUM_PAGE_SIZE;
}

/** GM: 随机一张照片池内的 pic_id */
function randomPictureId() {
  return PICTURE_IDS[randInt(0, PICTURE_IDS.length - 1)];
}

/** GM: 随机一条 Note 表内的日记 id */
function randomNoteId() {
  return NOTE_IDS.length ? NOTE_IDS[randInt(0, NOTE_IDS.length - 1)] : -1;
}

module.exports = {
  travelTick, rollTripRewards, makeEvent, scheduleDeparture,
  withLayers, albumCapacity,
  rolePayload, itemsPayload, handbookPayload, giftPayload, weatherPayload,
  departFrog, returnFrog, tripPrepared, refreshFrogMotion, refreshWeather,
  autoPackFromDesk, returnGear, hoursTypeNow,
  randomPictureId, randomNoteId,
  PACE, ITEM_TYPE, isType,
};
