/**
 * 访客引擎: 庭院小伙伴 (困困/胖胖/跳跳) + 串门邮差
 *
 * 官方语义 (main.min.js 逆向 + offline-v2 对照):
 *   - 小伙伴到访: 服务器推 guest_load {id, confirmed, served, expire_time, pos}
 *     · 恰好 5 个键, 客户端 GuestData 对未知键上报错误 (jf_commit)
 *     · id=-1 是客户端自己的"无访客"值, 推送它 = 送客
 *     · 客户端 UI 用 Character.data[id] 找名字/立绘, taste 向量 (64 值对齐
 *       rowItemId 里的特产 id) 决定投喂好感 (>=80 开心/>=60 满意/>=20 无感/else 失望)
 *   - 投喂 (guest_serve): 只收特产 (type 3), 消耗 1 件; 奖励走推送
 *     (客户端 addClover/addHouseItem/addTicket 均为空 stub)
 *   - guest_* 系列全部 needResponse:false —— 客户端本地先行, 服务器必须
 *     主动推 guest_load 回显权威状态
 *   - 串门邮差: 服务器推 visit_load {acquire, visitor?}
 *     · visitor 首访省份 (first=true) → 客户端把省份加入自己的 acquireList,
 *       服务器用 visit_load.acquire 持久化; 复访送礼 item_id 100000=三叶草
 *       100001=抽奖券, 数量 CountFloor~CountUpper
 *     · visit_open (拆礼物): needResponse:false, 奖励必须由推送补账
 *
 * 节奏 (offline-v2 自定值, 原版时刻表不可考):
 *   小伙伴: 每 60s roll 一次 35% 概率, 停留 30min, 离开后冷却 5min
 *   邮差:   每 300s roll 一次 25% 概率, 停留 15min, 离开后冷却 10min
 *   env: FROG_GUEST_ROLL / FROG_GUEST_CHANCE / FROG_VISITOR_ROLL /
 *        FROG_VISITOR_CHANCE / FROG_VISITOR_STAY / FROG_VISITOR_COOL
 */
const fs = require("fs");
const path = require("path");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");

const CHARACTER = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "MainData", "Character.json"), "utf-8"));
const GUEST_ROW_ITEM_IDS = CHARACTER.rowItemId || [];
const GUEST_DATA = CHARACTER.data || [];
const VISITORS_RAW = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "VisitorsData", "visitors.json"), "utf-8"));
const VISITOR_TABLE = VISITORS_RAW.provinceList || {};
const VISITOR_PROVINCES = Object.keys(VISITOR_TABLE);
// 邮差食物索引 (actionList 键 0..N): 客户端 updateVisitor 用 food 查
// actionList[food].RoleRes 加载龙骨立绘, 越界 = undefined.RoleRes 抛异常 → 邮差隐形
const VISITOR_FOOD_MAX = Math.max(0, ...Object.keys(VISITORS_RAW.actionList || {}).map(Number));

const env = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);
const PACE = {
  GUEST_ROLL_SEC: env("FROG_GUEST_ROLL", 60),
  GUEST_CHANCE: env("FROG_GUEST_CHANCE", 35),
  GUEST_STAY_SEC: env("FROG_GUEST_STAY", 1800),
  GUEST_COOL_SEC: env("FROG_GUEST_COOL", 300),
  GUEST_FAREWELL_SEC: 20, // 投喂后送客窗口: friendFeedBack 还要读 guest id, 立即清空会让客户端取 undefined 崩溃
  VISITOR_ROLL_SEC: env("FROG_VISITOR_ROLL", 300),
  VISITOR_CHANCE: env("FROG_VISITOR_CHANCE", 25),
  VISITOR_STAY_SEC: env("FROG_VISITOR_STAY", 900),
  VISITOR_COOL_SEC: env("FROG_VISITOR_COOL", 600),
};

const GIFT_CLOVER_ID = 100000;
const GIFT_TICKET_ID = 100001;
// 奖励权重 (官方 Define.FRIEND_GIFTPER_*; 表不可考, offline-v2 同款默认)
const GIFT_WEIGHTS = { clover: 80, four_leaf: 18, ticket: 2 };
const GUEST_CLOVER_POW = env("FROG_GUEST_CLOVER_POW", 150);
const FOUR_LEAF_ID = 1000;
const GUEST_POS_MAX = 3; // 官方 Define.FRIEND_RNDPOS_MAX

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/**
 * 伙伴离开感谢邮件 (P9): 投喂过的小伙伴离开时寄来谢礼 (三叶草)。
 * 客户端按 senderCharaId 匹配 Character.data 显示发件人立绘/名字,
 * 邮件 resource 里的 clover_point 在拆信时由推送补账 (addClover 是空 stub)。
 * @returns {boolean} 是否发了邮件
 */
function farewellGuestMail(s, g) {
  if (!g || !g.served) return false; // 没投喂过: 不寄
  s.mailSeq = (s.mailSeq || 0) + 1;
  s.mails.push({
    id: s.mailSeq,
    type: 3, // Mail.EvtId.Gift
    title: "谢谢款待",
    message: "多谢你的招待, 下次再来玩呀! 随信附上一点小心意。",
    // 客户端 MailView 按 sender 匹配发件人贴图: 0=mail_wugui(困困)/1=mail_maotouying(胖胖)/2=mail_songshu(跳跳)
    sender: g.id,
    auto_open: false,
    expire: 0,
    read: false,
    opened: false,
    resource: { clover_point: randInt(10, 30), ticket: 0, reward_gacha: 0, ads_id: "", share_id: "" },
    items: [],
    pictures: [],
  });
  return true;
}

/** 投喂好感: Character.taste 向量按 rowItemId (特产 id) 对齐 */
function guestFeeling(guestId, itemId) {
  const row = GUEST_DATA[guestId];
  if (!row || !Array.isArray(row.taste)) return 0;
  const i = GUEST_ROW_ITEM_IDS.indexOf(Number(itemId));
  if (i < 0) return 0;
  return Number(row.taste[i]) || 0;
}

/** guest_load 载荷: 恰好 5 个键 (客户端 GuestData 固定形状) */
function guestPayload(s) {
  const g = s.guest;
  if (!g) return { id: -1, confirmed: false, served: false, expire_time: 0, pos: 0 };
  return {
    id: g.id, confirmed: !!g.confirmed, served: !!g.served,
    expire_time: g.expire_time, pos: g.pos,
  };
}

/** visit_load 载荷: acquire 持久化省花收集 */
function visitorPayload(s) {
  const out = { acquire: (s.acquireProvinces || []).slice() };
  const v = s.visitor;
  if (v) {
    out.visitor = {
      partner: v.partner || 0,
      name: v.name || "",
      title: v.title || 0,
      expire_time: v.expire_time || 0,
      city: v.city || "",
      food: v.food || 0,
      first: !!v.first,
      gift: { item_id: v.gift ? v.gift.item_id : 0, count: v.gift ? v.gift.count : 0 },
      carpet: v.carpet || 0,
    };
  }
  return out;
}

function pickGuest(now) {
  const n = GUEST_DATA.length || 3;
  return {
    id: randInt(0, n - 1),
    confirmed: false,
    served: false,
    expire_time: now + PACE.GUEST_STAY_SEC,
    pos: randInt(0, Math.max(0, GUEST_POS_MAX - 1)),
    startAt: now, // 服务器私有: 投喂奖励的停留时长因子
  };
}

function pickVisitor(now) {
  const prov = VISITOR_PROVINCES[randInt(0, VISITOR_PROVINCES.length - 1)];
  const row = VISITOR_TABLE[prov] || {};
  const lo = Number(row.CountFloor) || 1;
  const hi = Math.max(lo, Number(row.CountUpper) || lo);
  const giftId = Number(row.OtherGiftID) || GIFT_CLOVER_ID;
  return {
    province: prov,
    partner: 0,
    name: prov,
    title: Number(row.ID) || 0,
    expire_time: now + PACE.VISITOR_STAY_SEC,
    city: prov,
    // food 是 actionList 的索引 (官方表键 0~VISITOR_FOOD_MAX), 越界会让客户端
    // actionList[food].RoleRes 抛异常 → updateVisitor 渲染中断 (邮差隐形)
    food: randInt(0, VISITOR_FOOD_MAX),
    first: false, // 调用方按 acquireProvinces 重算
    gift: { item_id: giftId, count: randInt(lo, hi) },
    carpet: 0,
  };
}

/**
 * tick: 到期送客 / 冷却后 roll 到访。由 travelTick 驱动 (30s 粒度)。
 * push 为空时 (离线追平) 只改状态不推送, 登录后由全量下发呈现。
 * @returns {boolean} 状态是否变化 (调用方据此存档)
 */
function guestTick(s, push, now) {
  let changed = false;
  // --- 庭院小伙伴 ---
  if (s.guest) {
    if (now >= s.guest.expire_time) {
      // 投喂过的伙伴离开时寄感谢邮件 (P9): 在线时 mail_load 全量推送
      const mailed = farewellGuestMail(s, s.guest);
      s.guest = null;
      s.guestCoolUntil = now + PACE.GUEST_COOL_SEC;
      s.guestNextRollAt = 0;
      changed = true;
      if (push) {
        push("guest_load", guestPayload(s));
        if (mailed) push("mail_load", s.mails);
      }
    }
  } else if (!s.visitor) {
    // 互斥 (客户端 getGameplayList): 未过期的小伙伴独占显示, 邮差在场时
    // 不 roll 小伙伴 —— 官方玩法表 串门 Sort=1 / 邻居 Sort=2, 同屏只渲染一个
    if (!s.guestNextRollAt) {
      s.guestNextRollAt = now + PACE.GUEST_ROLL_SEC;
      changed = true;
    } else if (now >= s.guestNextRollAt) {
      s.guestNextRollAt = now + PACE.GUEST_ROLL_SEC;
      if (now >= (s.guestCoolUntil || 0) && Math.random() * 100 < PACE.GUEST_CHANCE) {
        s.guest = pickGuest(now);
        s.stats.guestVisits = (s.stats.guestVisits || 0) + 1; // 成就 401 门口的小卡片
        changed = true;
        if (push) push("guest_load", guestPayload(s));
      }
    }
  }
  // --- 串门邮差 ---
  if (s.visitor) {
    if (now >= s.visitor.expire_time) {
      s.visitor = null;
      s.visitorCoolUntil = now + PACE.VISITOR_COOL_SEC;
      s.visitorNextRollAt = 0;
      changed = true;
      if (push) push("visit_load", visitorPayload(s));
    }
  } else if (!s.guest) {
    // 互斥: 小伙伴在场时邮差不 roll (客户端不会渲染, 到访即被邻居玩法遮蔽)
    if (!s.visitorNextRollAt) {
      s.visitorNextRollAt = now + PACE.VISITOR_ROLL_SEC;
      changed = true;
    } else if (now >= s.visitorNextRollAt) {
      s.visitorNextRollAt = now + PACE.VISITOR_ROLL_SEC;
      if (now >= (s.visitorCoolUntil || 0) && Math.random() * 100 < PACE.VISITOR_CHANCE) {
        const v = pickVisitor(now);
        v.first = (s.acquireProvinces || []).indexOf(v.province) === -1;
        s.visitor = v;
        changed = true;
        if (push) push("visit_load", visitorPayload(s));
      }
    }
  }
  return changed;
}

/**
 * 投喂结算 (guest_serve): 消耗特产 + roll 奖励 + 安排送客窗口。
 * 奖励公式 (日服反编译): clover = pow * (100+feeling)/100 * active/1800 * debuff/15
 * debuff 为重复投喂衰减 [0.6, 0.75, 0.9] (FRIEND_ITEM_DEBUFF)。
 * 奖励入账后必须推送 (客户端 stub 不加账)。
 */
function serveGuest(s, ctx, itemId, addItemFn, now) {
  const g = s.guest;
  if (!g || g.served) return false;
  g.served = true;
  s.guestFeeds = (s.guestFeeds || 0) + 1;
  require("./plans").event(s, "guestFeed", { guest: g.id }, ctx.push); // 周期计划 201/404-406
  const feeling = guestFeeling(g.id, itemId);
  const active = Math.max(0, Math.min(1800, now - (g.startAt || now)));
  // roll 奖励类别
  const roll = Math.random() * 100;
  let got = "clover";
  if (roll >= GIFT_WEIGHTS.clover) {
    got = roll < GIFT_WEIGHTS.clover + GIFT_WEIGHTS.four_leaf ? "four_leaf" : "ticket";
  }
  let clover = 0, ticket = 0;
  if (got === "four_leaf") {
    addItemFn(s, FOUR_LEAF_ID, 1);
    const row = s.items.house.find((x) => x.item_id === FOUR_LEAF_ID);
    ctx.push("item_update", { item: { item_id: FOUR_LEAF_ID, count: row ? row.count : 1 } });
  } else if (got === "ticket") {
    ticket = 1;
  } else {
    const debuff = [0.6, 0.75, 0.9][Math.min(s.guestFeeds - 1, 2)];
    clover = Math.floor(GUEST_CLOVER_POW * ((100 + feeling) / 100) * (active / 1800) * debuff / 15);
  }
  if (clover > 0) {
    s.res.clover_point += clover;
    require("./cooking").event(s, "cloverGain", { delta: clover }, ctx.push); // 月度烹饪 4
    ctx.push("clover_update", { clover: s.res.clover_point });
  }
  if (ticket > 0) {
    s.res.ticket += ticket;
    ctx.push("item_update_ticket", { ticket: s.res.ticket });
  }
  // 送客窗口: 客户端 friendFeedBack 还要读 guest id, 立即清空会 undefined 崩溃
  g.expire_time = now + PACE.GUEST_FAREWELL_SEC;
  s.guestCoolUntil = g.expire_time + PACE.GUEST_COOL_SEC;
  s.guestNextRollAt = 0;
  return true;
}

module.exports = {
  guestTick, serveGuest, guestPayload, visitorPayload, guestFeeling,
  pickGuest, pickVisitor, farewellGuestMail,
  GIFT_CLOVER_ID, GIFT_TICKET_ID, PACE,
};
