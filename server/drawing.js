/**
 * 涂鸦派对引擎 (Drawing Party): 邻居邀请蛙去家里画画 → 收拾画具包 → 聚会 → 带回涂鸦页/收藏品
 *
 * 官方语义 (main.min.js 逆向):
 *   - DrawingState: wait=0 / invite=1 / accept=2 / lock=3 / visit=4
 *     wait     无派对
 *     invite   邻居邀请中 (庭院 inviteBtn: out_invite_wugui/maotouying/songshu_png)
 *     accept   已受邀, 小屋 BagTable 派对模式收拾画具包
 *     lock     画具包锁定 (客户端完成按钮, 全部灰化, 可反悔解锁)
 *     visit    聚会中 (蛙 status=3, 小屋 i_party 图标)
 *   - 邻居三选一: 0 困困(乌龟) / 1 胖胖(猫头鹰) / 2 跳跳(松鼠)
 *   - 解锁钥匙: 物品 7001 友情绘本 (客户端 isOpen 查 house 数量, 无绘本不邀请)
 *   - 协议 (全部 needResponse, 客户端本地先行, code==0 才推进本地状态):
 *       guest_accept_invit {is_accept}   接受/拒绝邀请 (同一个协议, 布尔区分)
 *       guest_putin_bag {pos, id}        画具包放入 (pos 1-based; 1=手信食物, 2..4=特产手信)
 *       guest_takeout_bag {pos}          画具包取出
 *       guest_lock_bag                   锁包 toggle (accept<->lock)
 *   - guest_load_drawing 推送: DrawingModel this.data = e 整模型替换,
 *     必须携带全部 7 字段 (state/guest/bag/pages/colls/show_coll/pen_motion)
 *   - 画具包: bag[0]=手信食物 (drawingCommonData.food 三选一 16/15/33, 按
 *     LunchBox 从 house 扣), bag[1..3]=特产手信 (ItemType.Specialty);
 *     出发即全部送给邻居 (消耗)
 *   - 事件: PartyGo(23) evt_value[0]>0 → "精力充沛地出去聚会了" (手食齐备);
 *     PartyResult(24) evt_id=guest, evt_value=[page, coll, clover, ticket, ...物品id]
 *     (客户端 load_events 对 PartyResult 也 subClover(evt_value[2]) 暂隐, 看完弹回)
 *   - show_coll: 新收藏品室内摆放 (updateDrawingCollect 按 scene+position 渲染,
 *     仅个别收藏品有场景坐标), 换新值时弹 "屋内似乎多了些东西";
 *     客户端零写入, 服务器权威控制
 *   - pen_motion: 小屋写字动作的画笔动画名 (hikki_ie 分支), 恒 "write"
 *
 * 节奏 (官方时刻表不可考, 自定默认, env 可覆盖):
 *   邀请 roll:  每 2h 一次 35% (蛙在家且有绘本)
 *   邀请过期:   2h 未应答邻居撤回
 *   锁包→出发: 30~90s (短窗口允许反悔解锁)
 *   聚会时长:   1~3h
 *   归来冷却:   2h
 *   env: FROG_PARTY_ROLL / FROG_PARTY_CHANCE / FROG_PARTY_INVITE_EXPIRE /
 *        FROG_PARTY_DEPART_MIN / FROG_PARTY_DEPART_MAX / FROG_PARTY_MIN_SEC /
 *        FROG_PARTY_MAX_SEC / FROG_PARTY_COOL / FROG_PARTY_COLL_PER /
 *        FROG_PARTY_TICKET_PER / FROG_PARTY_GIFT_PER
 */
const fs = require("fs");
const path = require("path");
const travel = require("./travel");
const storyMod = require("./story");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");

// ---------- 配置表 ----------
/** 表可能是数组或 {id: row} 对象, 统一转行数组 */
function rows(name, dir) {
  const t = JSON.parse(fs.readFileSync(path.join(CFG_DIR, dir || "Drawing", name), "utf-8"));
  if (Array.isArray(t)) return t;
  return Object.keys(t).map((k) => t[k]).filter((r) => r && typeof r === "object");
}

// 手信食物三选一 (客户端 openPlayerBagForSouvenirGift: value2/3/4 每项 "槽,物品id" 取 [1])
const DRAWING_COMMON = JSON.parse(
  fs.readFileSync(path.join(CFG_DIR, "Drawing", "drawingCommonData.json"), "utf-8"));
const FOOD_IDS = ["value2", "value3", "value4"]
  .map((k) => Number(String((DRAWING_COMMON.food[k] || [])[0] || "").split(",")[1]))
  .filter((v) => v > 0);

// 涂鸦页/收藏品: 按邻居分组 (guest -1 的 301~308 是小伙伴收藏, 非派对产出)
const PAGE_IDS_BY_GUEST = [0, 1, 2].map((g) => rows("drawingPageData.json")
  .filter((r) => r.guest === g && typeof r.id === "number").map((r) => r.id).sort((a, b) => a - b));
const COLL_TABLE = rows("drawingCollectData.json");
const COLL_BY_ID = new Map(COLL_TABLE.map((c) => [c.id, c]));
const COLL_IDS_BY_GUEST = [0, 1, 2].map((g) => COLL_TABLE
  .filter((r) => r.guest === g && typeof r.id === "number").map((r) => r.id).sort((a, b) => a - b));

// 特产池 (邻居回礼)
const SPECIALTY_IDS = rows("Specialty.json", "MainData")
  .map((r) => r.itemId).filter((v) => v > 0);

// 邻居名字 (GM 信息用; 客户端 Character.data 同源)
const GUEST_NAMES = ["困困", "胖胖", "跳跳"];
const DRAWING_BOOK_ID = 7001; // Tabikaeru.ItemID.DRAWING_BOOK

const env = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const PACE = {
  ROLL_SEC: env("FROG_PARTY_ROLL", 2 * 3600),        // 邀请 roll 间隔
  CHANCE: env("FROG_PARTY_CHANCE", 35),              // 邀请概率 (%)
  INVITE_EXPIRE_SEC: env("FROG_PARTY_INVITE_EXPIRE", 2 * 3600), // 邀请应答窗口
  DEPART_MIN: env("FROG_PARTY_DEPART_MIN", 30),      // 锁包→出发窗口 (可反悔)
  DEPART_MAX: env("FROG_PARTY_DEPART_MAX", 90),
  MIN_SEC: env("FROG_PARTY_MIN_SEC", 3600),          // 聚会时长窗口
  MAX_SEC: env("FROG_PARTY_MAX_SEC", 3 * 3600),
  COOL_SEC: env("FROG_PARTY_COOL", 2 * 3600),        // 归来冷却
};
const ROLL = {
  COLL_PER: env("FROG_PARTY_COLL_PER", 45),   // 收藏品概率 (%)
  TICKET_PER: env("FROG_PARTY_TICKET_PER", 30), // 抽奖券概率 (%)
  GIFT_PER: env("FROG_PARTY_GIFT_PER", 60),   // 邻居回礼特产概率 (%)
  STORY_PER: env("FROG_PARTY_STORY_PER", 60), // 故事纪念品概率 (%)
  CLOVER_MIN: 1, CLOVER_MAX: 3,
};

const BAG_LEN = 6; // 离线服历史载荷宽度; 实际使用 1..4 槽
const emptyBag = () => new Array(BAG_LEN).fill(-1);

// ---------- 存档节点 ----------

/** 存档 drawing 节点兜底 (旧档/新档统一形状) */
function node(s) {
  if (!s.drawing) {
    s.drawing = {
      state: 0, guest: -1, bag: emptyBag(),
      pages: [], colls: [], show_coll: 0, pen_motion: "write",
      // 服务器私有计时 (不下发)
      nextRollAt: 0, inviteExpireAt: 0, departAt: 0, returnAt: 0,
    };
  }
  const d = s.drawing;
  if (!Array.isArray(d.bag) || d.bag.length !== BAG_LEN) {
    const bag = emptyBag();
    for (let i = 0; i < Math.min(BAG_LEN, (d.bag || []).length); i++) bag[i] = d.bag[i] == null ? -1 : d.bag[i];
    d.bag = bag;
  }
  if (!Array.isArray(d.pages)) d.pages = [];
  if (!Array.isArray(d.colls)) d.colls = [];
  if (d.show_coll == null) d.show_coll = 0;
  if (typeof d.pen_motion !== "string" || !d.pen_motion) d.pen_motion = "write";
  return d;
}

/** 派对结束/撤回: 回到 wait + 冷却 */
function reset(d, now) {
  d.state = 0;
  d.guest = -1;
  d.bag = emptyBag();
  d.inviteExpireAt = 0;
  d.departAt = 0;
  d.returnAt = 0;
  d.nextRollAt = now + PACE.COOL_SEC;
}

/** house 物品计数 */
function houseCount(s, itemId) {
  const row = s.items.house.find((x) => x.item_id === Number(itemId));
  return row ? row.count : 0;
}
/** 解锁钥匙: 友情绘本在屋 (客户端 isOpen 同源) */
function isOpen(s) {
  return houseCount(s, DRAWING_BOOK_ID) > 0;
}
/** 收藏品可室内摆放 (客户端 updateDrawingCollect 要 scene+position 齐全才渲染) */
function displayable(collId) {
  const c = COLL_BY_ID.get(Number(collId));
  return !!(c && c.scene && c.scene.index && c.position);
}

// ---------- 下发 payload ----------

/** guest_load_drawing 载荷: DrawingModel 整模型替换, 7 字段必齐 */
function drawingPayload(s) {
  const d = node(s);
  return {
    state: d.state,
    guest: d.guest,
    bag: d.bag.slice(),
    pages: d.pages.slice(),
    colls: d.colls.slice(),
    show_coll: d.show_coll,
    pen_motion: d.pen_motion,
  };
}

// ---------- 状态机 ----------

/**
 * 惰性推进涂鸦派对状态机 (server.js 在 travelTick 前调用, 30s 粒度 + 协议交互前)。
 * @returns {boolean} 状态是否变化 (调用方持久化)
 */
function drawingTick(s, push, now) {
  // server.js 消息路径/30s 定时器只传 (save, push), 与 travelTick 内部自算同源兜底;
  // 缺省时 undefined >= 任何时间戳恒 false, 时间推进 (邀请/过期/出发/回家) 会全部停摆
  if (now == null) now = Math.floor(Date.now() / 1000);
  const d = node(s);
  let changed = false;
  // 邀请 roll: 蛙在家 + 有绘本 + 空闲状态 + 到节奏
  if (d.state === 0 && s.frog.status === 0 && isOpen(s) && now >= (d.nextRollAt || 0)) {
    d.nextRollAt = now + PACE.ROLL_SEC;
    if (Math.random() * 100 < PACE.CHANCE) {
      d.state = 1;
      d.guest = randInt(0, 2);
      d.inviteExpireAt = now + PACE.INVITE_EXPIRE_SEC;
      if (push) push("guest_load_drawing", drawingPayload(s));
      changed = true;
    }
  }
  // 邀请过期: 邻居撤回
  if (d.state === 1 && d.inviteExpireAt && now >= d.inviteExpireAt) {
    reset(d, now);
    if (push) push("guest_load_drawing", drawingPayload(s));
    changed = true;
  }
  // 锁包到点: 出发去聚会
  if (d.state === 3 && d.departAt && now >= d.departAt) {
    if (s.frog.status === 0) {
      departParty(s, push, now);
      changed = true;
    } else {
      // 蛙不在家 (如受邀后又被 GM 送去旅行): 顺延重试, 回家即出发
      d.departAt = now + 60;
    }
  }
  // 聚会到点: 回家结算
  if (d.state === 4 && d.returnAt && now >= d.returnAt) {
    returnParty(s, push, now);
    changed = true;
  }
  return changed;
}

/** 出发去聚会: 手信全部送给邻居 + 蛙 status=3 + PartyGo 事件 */
function departParty(s, push, now) {
  const d = node(s);
  // 手食齐备判定 (drawingCommonData 三选一): 决定 PartyGo "精力充沛" 标志
  const foodOk = FOOD_IDS.indexOf(d.bag[0]) >= 0;
  d.bag = emptyBag(); // 手信送出 (消耗)

  s.frog.status = 3; // 聚会中 (客户端小屋 i_party 图标)
  s.frog.motion = 0;
  d.state = 4;
  d.departAt = 0;
  d.returnAt = now + randInt(PACE.MIN_SEC, PACE.MAX_SEC);

  const ev = travel.makeEvent(s, 23 /* PartyGo */, [foodOk ? 1 : 0]);
  s.events.push(ev);
  if (push) {
    push("client_load_role", travel.rolePayload(s));
    push("guest_load_drawing", drawingPayload(s));
    push("notify_new_event", { event: ev });
  }
  return ev;
}

/** 聚会回家: 结算涂鸦页/收藏品/三叶草/券/回礼 + PartyResult 事件 + 室内摆放 */
function returnParty(s, push, now) {
  const d = node(s);
  const guestId = d.guest >= 0 && d.guest <= 2 ? d.guest : randInt(0, 2);

  // 涂鸦页: 顺序补齐该邻居的页 (集齐则 -1, 客户端 page>0 才弹新页视图)
  const pagePool = PAGE_IDS_BY_GUEST[guestId];
  const page = pagePool.find((id) => d.pages.indexOf(id) < 0);
  const pageId = page === undefined ? -1 : page;
  // 收藏品: 概率 roll 未收集的 (集齐/未中则 -1)
  let collId = -1;
  const collPool = COLL_IDS_BY_GUEST[guestId].filter((id) => d.colls.indexOf(id) < 0);
  if (collPool.length && Math.random() * 100 < ROLL.COLL_PER) {
    collId = collPool[randInt(0, collPool.length - 1)];
  }
  const clover = randInt(ROLL.CLOVER_MIN, ROLL.CLOVER_MAX);
  const ticket = Math.random() * 100 < ROLL.TICKET_PER ? 1 : 0;
  // 邻居回礼: 概率一件随机特产 (入屋 + 图鉴)
  const items = [];
  if (SPECIALTY_IDS.length && Math.random() * 100 < ROLL.GIFT_PER) {
    items.push(SPECIALTY_IDS[randInt(0, SPECIALTY_IDS.length - 1)]);
  }

  if (pageId > 0) d.pages.push(pageId);
  if (collId > 0) {
    d.colls.push(collId);
    // 室内摆放: 仅 scene+position 齐全的收藏品可摆 (客户端按表渲染);
    // 不可摆的收藏品只在绘本/弹窗呈现, 不动 show_coll (保持现有摆放)
    if (displayable(collId)) d.show_coll = collId;
  }
  s.res.clover_point += clover;
  if (clover > 0) require("./cooking").event(s, "cloverGain", { delta: clover }, push); // 月度烹饪 4
  s.res.ticket += ticket;
  for (const id of items) {
    const row = s.items.house.find((x) => x.item_id === id);
    if (row) row.count += 1;
    else s.items.house.push({ item_id: id, count: 1 });
    if (travel.isType(id, travel.ITEM_TYPE.SPECIALTY) && !s.handbook.specialtys.includes(id)) {
      s.handbook.specialtys.push(id);
    }
  }

  // 蛙回家: 重掷在家行为序列 (与 returnFrog 同款)
  s.frog.status = 0;
  s.frog.motion = 0;
  s.frog.motionPattern = null;
  s.frog.motionStep = 0;
  s.frog.motionNextAt = 0; // 立即触发下一拍轮换 (与 returnFrog 同款)
  reset(d, now);
  // 成就 403 等一个聚会惊喜: 聚会完成计数
  s.stats.partyDone = (s.stats.partyDone || 0) + 1;
  require("./plans").event(s, "partyAttend"); // 周期计划 403 到邻居家串个门
  // 故事纪念品 (story.js): 概率带回未拥有的派对故事, 置新故事红点
  let storyId = null;
  if (Math.random() * 100 < ROLL.STORY_PER) storyId = storyMod.dropStory(s);
  // 回家后旅行系统也要休息 (与 returnFrog 同款 IDLE 窗口):
  //   聚会期间 travelTick 一直顺延 departAt, 蛙回家瞬间 departAt 已过期,
  //   不设 IDLE 则蛙背包有物时会被旅行引擎立即送走, 没有休息过渡
  s.travel.departAt = now + randInt(travel.PACE.IDLE_MIN, travel.PACE.IDLE_MAX);
  // 行囊解锁: 蛙回家即新一轮收拾 (与 returnFrog 同款), 否则客户端 bagLock
  // 永久锁死背包 (聚会前玩家可能已 item_set_bag_completed=true 锁包)
  s.items.bag_completed = false;

  const ev = travel.makeEvent(s, 24 /* PartyResult */, [pageId, collId, clover, ticket, ...items]);
  ev.evt_id = guestId; // 客户端 PartyResultView 按 evt_id 找邻居头像/礼物图
  s.events.push(ev);
  if (push) {
    push("client_load_role", travel.rolePayload(s));
    push("guest_load_drawing", drawingPayload(s));
    push("clover_update", { clover: s.res.clover_point });
    push("item_update_ticket", { ticket: s.res.ticket });
    if (items.length) push("item_load_items", travel.itemsPayload(s));
    push("item_load_handbook", travel.handbookPayload(s));
    if (push) push("museum_load", require("./museum").payload(s)); // 博物馆照片墙随收藏点亮
    if (storyId != null) push("story_load", { stories: s.stories, new_story_id: s.new_story_id });
    push("notify_new_event", { event: ev });
  }
  return ev;
}

module.exports = {
  node, drawingTick, drawingPayload, departParty, returnParty,
  isOpen, displayable, houseCount, reset,
  FOOD_IDS, GUEST_NAMES, PAGE_IDS_BY_GUEST, COLL_IDS_BY_GUEST, SPECIALTY_IDS,
  PACE, ROLL,
};
