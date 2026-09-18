/**
 * 开发者模式 (GM): 快速验证游戏界面与互动的调试接口
 *
 * 双入口:
 *   1. HTTP API: POST /gm/api {account, action, params} (浏览器 GM 面板调用,
 *      与游戏页面并排开 —— 动作结果实时推送, 游戏无需刷新)
 *   2. 官方客户端 GM 控制台: client_gm 协议 (gameConfig.showGM 开启的
 *      隐藏控制台, 文本命令直转本模块)
 *
 * 语义约定:
 *   - 动作直接在目标账户的存档对象上修改 (在线连接与 GM 共享同一引用,
 *     后续 tick 天然延续新状态)
 *   - 修改后通过 ctx.push 实时推送给在线客户端 (客户端 add* 多为空 stub,
 *     一切以服务器推送为准)
 *   - 每个动作返回人类可读 info (GM 面板/控制台直接显示)
 */
const saveMod = require("./save");
const travel = require("./travel");
const guestMod = require("./guest");
const merchantMod = require("./merchant");
const furniMod = require("./furni");
const flowerpotMod = require("./flowerpot");
const drawingMod = require("./drawing");
const { pushAllState } = require("./handlers");
const fs = require("fs");
const path = require("path");

// 物品表 (发放选择器数据源)
const ITEM_ROWS = (() => {
  const t = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "resource", "China", "config", "MainData", "Item.json"), "utf-8"));
  return Array.isArray(t) ? t : Object.values(t);
})();
const TYPE_LABEL = { 0: "便当", 1: "护身符", 2: "道具", 3: "特产", 16: "材料" };

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const now = () => Math.floor(Date.now() / 1000);
const itemName = (id) => ((ITEM_ROWS.find((r) => r.id === Number(id)) || {}).name) || `#${id}`;

/** house 物品增减 (与 handlers.js 同语义) */
function addItem(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += count;
  else s.items.house.push({ item_id: itemId, count });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
}

/** 按类型找一个代表物品 id (fill_bag/fill_desk 用) */
function firstOfType(type, preferSpendZero) {
  const pool = ITEM_ROWS.filter((r) => r.type === type
    && (preferSpendZero ? Number(r.spend) !== 1 : true));
  return (pool[0] || ITEM_ROWS.find((r) => r.type === type) || {}).id;
}

/** 每类物品各找一个 (背包槽位: 便当/护符/道具x2) */
function bagKit() {
  const lunch = ITEM_ROWS.find((r) => r.type === 0) || {};
  const amulet = ITEM_ROWS.find((r) => r.type === 1 && Number(r.spend) !== 1) || {};
  const tools = ITEM_ROWS.filter((r) => r.type === 2).slice(0, 2);
  return {
    bag: [lunch.id, amulet.id, ...(tools.map((t) => t.id)), -1, -1, -1].slice(0, 4),
    desk: [lunch.id, lunch.id, amulet.id, -1, -1, -1, -1, -1],
  };
}

// ---------- GM 动作表 ----------
const actions = {
  // --- 青蛙 ---
  "frog_depart": (ctx) => {
    if (ctx.save.frog.status === 1) return "蛙已在旅行中";
    if (ctx.save.frog.status === 3) return "蛙在聚会中 (先 drawing_advance 回家结算)";
    const d = drawingMod.node(ctx.save);
    if (d.state >= 2 && d.state <= 3) return "画具包收拾中 (先 drawing_advance 出发或 drawing_reset)";
    travel.departFrog(ctx.save, ctx.push, now()); // 内部已推 role/items/事件
    return "蛙已立即出门";
  },
  "frog_home": (ctx) => {
    if (ctx.save.frog.status === 0) return "蛙已在家";
    // 聚会中回家走派对结算 (涂鸦页/收藏品/回礼), 不走旅行奖励
    if (ctx.save.frog.status === 3) {
      drawingMod.returnParty(ctx.save, ctx.push, now());
      return "蛙已从聚会回家 (派对奖励照常结算)";
    }
    travel.returnFrog(ctx.save, ctx.push, now()); // 内部已推全套回家结算
    return "蛙已立即回家 (奖励照常结算)";
  },
  "frog_stray": (ctx) => {
    if (ctx.save.frog.status === 1) return "蛙已在旅行中";
    if (ctx.save.frog.status === 3) return "蛙在聚会中 (先 drawing_advance 回家结算)";
    if (drawingMod.node(ctx.save).state >= 2 && drawingMod.node(ctx.save).state <= 3) return "画具包收拾中 (先 drawing_advance 或 drawing_reset)";
    // 清空携带 → 放浪短途 (10~20 分钟窗口, GM 快速验证短循环)
    ctx.save.items.bag = [-1, -1, -1, -1];
    ctx.save.items.desk = ctx.save.items.desk.map(() => -1);
    travel.departFrog(ctx.save, ctx.push, now());
    return "蛙已空手放浪 (短途)";
  },

  // --- 三叶草/货币 ---
  "clover_all": (ctx) => {
    const s = ctx.save;
    for (const c of s.clovers) {
      c.last_harvest = 0;
      if (!(c.element >= 0 && c.sprite > 0)) { c.element = 0; c.sprite = 1; }
    }
    ctx.push("clover_load_clovers", s.clovers);
    return `三叶草全部成熟 (${s.clovers.length} 槽)`;
  },
  "clover_clear": (ctx) => {
    const s = ctx.save;
    for (const c of s.clovers) {
      c.last_harvest = now();
      c.rebirth_span = saveMod.rollRebirth();
    }
    ctx.push("clover_load_clovers", s.clovers);
    return "三叶草地已清空 (等待重生)";
  },
  "add_clover": (ctx, p) => {
    const n = Math.max(1, Math.min(Number(p.n) || 100, 999999));
    ctx.save.res.clover_point += n;
    ctx.push("clover_update", { clover: ctx.save.res.clover_point });
    return `+${n} 三叶草 (现 ${ctx.save.res.clover_point})`;
  },
  "add_ticket": (ctx, p) => {
    const n = Math.max(1, Math.min(Number(p.n) || 10, 999));
    ctx.save.res.ticket += n;
    ctx.push("item_update_ticket", { ticket: ctx.save.res.ticket });
    return `+${n} 抽奖券 (现 ${ctx.save.res.ticket})`;
  },

  // --- 物品 ---
  "give_item": (ctx, p) => {
    const itemId = Number(p.item_id);
    const count = Math.max(1, Math.min(Number(p.count) || 1, 99));
    const meta = ITEM_ROWS.find((r) => r.id === itemId);
    if (!meta) return `未知物品 id: ${itemId}`;
    addItem(ctx.save, itemId, count);
    ctx.push("item_load_items", travel.itemsPayload(ctx.save));
    return `已发放 ${meta.name} x${count}`;
  },
  "fill_bag": (ctx) => {
    const s = ctx.save;
    if (s.frog.status === 1) return "旅行中包随蛙走, 回家后再装";
    const kit = bagKit();
    // 槽位被占先清 (装备回屋)
    for (let i = 0; i < s.items.bag.length; i++) {
      if (s.items.bag[i] !== -1) { addItem(s, s.items.bag[i], 1); s.items.bag[i] = -1; }
    }
    kit.bag.forEach((id, i) => { if (id != null && id !== -1 && i < s.items.bag.length) s.items.bag[i] = id; });
    ctx.push("item_load_items", travel.itemsPayload(s));
    return "背包已装满 (便当+护符+道具)";
  },
  "clear_bag": (ctx) => {
    const s = ctx.save;
    for (let i = 0; i < s.items.bag.length; i++) {
      if (s.items.bag[i] !== -1) { addItem(s, s.items.bag[i], 1); s.items.bag[i] = -1; }
    }
    ctx.push("item_load_items", travel.itemsPayload(s));
    return "背包已清空 (物品回仓库)";
  },

  // --- 访客 (互斥: 官方玩法表同屏只渲染一个 —— 串门 Sort=1 / 邻居 Sort=2,
  //     未过期的小伙伴会把邮差从渲染列表挤掉, 所以到访前先送走另一位) ---
  "guest_come": (ctx, p) => {
    const s = ctx.save;
    if (s.guest) return `小伙伴已在家 (id=${s.guest.id})`;
    if (s.visitor) { // 送走邮差 (客户端 guest 到场需串门玩法退场)
      s.visitor = null;
      s.visitorNextRollAt = 0;
      ctx.push("visit_load", guestMod.visitorPayload(s));
    }
    s.guest = guestMod.pickGuest(now());
    if (p.id != null && Number(p.id) >= 0) s.guest.id = Math.min(Number(p.id), 2);
    ctx.push("guest_load", guestMod.guestPayload(s));
    return `小伙伴已到访 (id=${s.guest.id})`;
  },
  "guest_leave": (ctx) => {
    const s = ctx.save;
    if (!s.guest) return "当前没有小伙伴";
    s.guest = null;
    s.guestNextRollAt = 0;
    ctx.push("guest_load", guestMod.guestPayload(s));
    return "小伙伴已离开";
  },
  "visitor_come": (ctx) => {
    const s = ctx.save;
    if (s.visitor) return "邮差已在庭院";
    if (s.guest) { // 送走小伙伴 (未过期的小伙伴独占显示, 不清则邮差不可见)
      s.guest = null;
      s.guestNextRollAt = 0;
      ctx.push("guest_load", guestMod.guestPayload(s));
    }
    const v = guestMod.pickVisitor(now());
    v.first = !s.acquireProvinces.includes(v.province);
    s.visitor = v;
    ctx.push("visit_load", guestMod.visitorPayload(s));
    return `串门邮差已到访 (${v.name}${v.first ? " 首访" : " 复访"})`;
  },

  // --- 涂鸦派对 (drawing.js 引擎驱动; invite→accept→lock→visit→结算) ---
  // 强制邀请: 无绘本自动补发 7001 (客户端 isOpen 同源判定), 立即 state=1
  "drawing_invite": (ctx, p) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    if (d.state !== 0) return `派对进行中 (state=${d.state}), 先 drawing_reset`;
    if (s.frog.status !== 0) return "蛙不在家 (先 frog_home, 邀请按钮要庭院可见)";
    if (!drawingMod.isOpen(s)) {
      addItem(s, 7001, 1); // 友情绘本: 派对解锁钥匙
      ctx.push("item_load_items", travel.itemsPayload(s));
    }
    d.state = 1;
    d.guest = p.guest != null ? Math.max(0, Math.min(Number(p.guest), 2)) : randInt(0, 2);
    d.inviteExpireAt = now() + drawingMod.PACE.INVITE_EXPIRE_SEC;
    ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
    return `已强制邀请 ${drawingMod.GUEST_NAMES[d.guest]} (guest=${d.guest}) — 庭院查看邀请按钮`;
  },
  // 快进一档: 0→邀请 / 1→接受 / 2→自动装包+出发 / 3→立即出发 / 4→回家结算
  "drawing_advance": (ctx) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    const t = now();
    if (d.state === 0) {
      return actions["drawing_invite"](ctx, {});
    }
    if (d.state === 1) { // 接受邀请 → 收拾画具包
      d.state = 2;
      d.inviteExpireAt = 0;
      ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
      return `已接受 ${drawingMod.GUEST_NAMES[d.guest]} 的邀请 — 小屋背包收拾画具包`;
    }
    if (d.state === 2) { // 自动装包 (食物槽+3 特产槽) + 锁包出发
      if (s.frog.status !== 0) return "蛙不在家 (先 frog_home)";
      // 手信食物: 屋内三选一优先, 缺则补发 (openPlayerBagForSouvenirGift 同源)
      let food = drawingMod.FOOD_IDS.find((id) => drawingMod.houseCount(s, id) > 0);
      if (food == null) { food = drawingMod.FOOD_IDS[0]; addItem(s, food, 1); }
      d.bag[0] = food;
      addItem(s, food, -1);
      // 特产手信 3 槽: 屋内库存优先, 不足随机补发
      for (let i = 1; i <= 3; i++) {
        const stock = s.items.house.find((x) => travel.isType(x.item_id, travel.ITEM_TYPE.SPECIALTY) && x.count > 0);
        const sp = stock ? stock.item_id
          : drawingMod.SPECIALTY_IDS[randInt(0, drawingMod.SPECIALTY_IDS.length - 1)];
        if (!stock) addItem(s, sp, 1);
        d.bag[i] = sp;
        addItem(s, sp, -1);
      }
      ctx.push("item_load_items", travel.itemsPayload(s));
      drawingMod.departParty(s, ctx.push, t); // 内部: state=4 + status=3 + PartyGo 推送
      return `画具包已收拾完毕, 蛙出发去 ${drawingMod.GUEST_NAMES[d.guest]} 家聚会 (state=4)`;
    }
    if (d.state === 3) { // 立即出发
      if (s.frog.status !== 0) return "蛙不在家 (先 frog_home)";
      drawingMod.departParty(s, ctx.push, t);
      return `蛙出发去 ${drawingMod.GUEST_NAMES[d.guest]} 家聚会 (state=4)`;
    }
    // state=4: 立即回家结算
    drawingMod.returnParty(s, ctx.push, t);
    return "蛙已从聚会回家 (涂鸦页/收藏品/回礼已结算, PartyResult 事件已推送)";
  },
  // 全重置: 派对状态 + 涂鸦页 + 收藏品 (含室内摆放); 聚会中的蛙强制回家
  "drawing_reset": (ctx) => {
    const s = ctx.save;
    const d = drawingMod.node(s);
    const wasParty = s.frog.status === 3;
    drawingMod.reset(d, now());
    d.pages = [];
    d.colls = [];
    d.show_coll = 0;
    d.nextRollAt = 0;
    if (wasParty) {
      s.frog.status = 0;
      s.frog.motion = 0;
      s.frog.motionPattern = null;
      s.frog.motionStep = 0;
      ctx.push("client_load_role", travel.rolePayload(s));
    }
    ctx.push("guest_load_drawing", drawingMod.drawingPayload(s));
    return `涂鸦派对已重置${wasParty ? " (聚会中的蛙已回家)" : ""} (涂鸦页/收藏品已清空)`;
  },

  // --- 旅行商人嘟嘟 (家具商店, 独立玩法不与小伙伴/邮差互斥) ---
  "merchant_come": (ctx, p) => {
    const s = ctx.save;
    const m = s.merchant || (s.merchant = {});
    const stay = Math.max(60, Number(p.stay) || 7200);
    m.shop = { start_time: now(), leave_time: now() + stay, shop_list: merchantMod.genShopList(s) };
    ctx.push("furniture_load_furniture", merchantMod.furniturePayload(s));
    return `嘟嘟已到访 (停留 ${Math.round(stay / 60)} 分钟, ${m.shop.shop_list.length} 件商品)`;
  },
  "merchant_leave": (ctx) => {
    const s = ctx.save;
    const m = s.merchant || {};
    if (!m.shop) return "嘟嘟不在";
    m.lastVisit = m.shop.start_time;
    m.shop = null;
    m.coolUntil = 0;
    m.nextRollAt = 0;
    ctx.push("furniture_load_furniture", merchantMod.furniturePayload(s));
    return "嘟嘟已收拾回家";
  },

  // --- 家具工坊 (测试快捷方式) ---
  // 备齐图纸+材料直接开工 (正常流: 买图纸+材料, 图纸放上工作台自动开工)
  "craft_start": (ctx, p) => {
    const s = ctx.save;
    const f = furniMod.node(s);
    if (f.craft) return `制作中 (还差 ${Math.max(0, f.craft.finishAt - now())}s): ${itemName(f.craft.furnitureId)}`;
    // 找图纸: 指定家具 id 反查其 type 的图纸; 未指定则挑第一张没买过的
    let target = Number(p.furniture_id);
    if (!target) {
      const paper = [...furniMod.BLUEPRINT_TYPE.entries()].find(([draw, type]) => {
        const c = furniMod.CRAFTABLE_BY_TYPE.get(type);
        return c && !f.owned.includes(c.furnitureId);
      });
      if (!paper) return "27 种图纸全做完了";
      target = furniMod.CRAFTABLE_BY_TYPE.get(paper[1]).furnitureId;
    }
    // 发图纸 + 材料进包, 图纸放上工作台 → 自动开工
    const draw = furniMod.FURNITURE_BY_ID.get(target);
    if (!draw) return `未知家具 id: ${target}`;
    const mats = furniMod.craftMaterialsFor(target) || [];
    const give = (itemId, count) => {
      const row = s.items.house.find((x) => x.item_id === itemId);
      if (row) row.count = Math.max(row.count, count);
      else s.items.house.push({ item_id: itemId, count });
    };
    give(Number(draw.drawing), 1); // 图纸本身也要在包里 (putinBench 查库存)
    for (const m of mats) give(m.item_id, m.count);
    const r = furniMod.putinBench(s, 6, Number(draw.drawing));
    if (r.code !== 0) return `开工失败: code=${r.code}`;
    ctx.push("item_load_items", travel.itemsPayload(s));
    ctx.push("furniture_load_furniture", merchantMod.furniturePayload(s));
    return `开始制作 ${draw.name} (id=${target}, 材料: ${mats.map((m) => `${itemName(m.item_id)}x${m.count}`).join("+")}, ${Math.round(furniMod.CRAFT_SECONDS / 60)} 分钟)`;
  },
  // 制作立即完成 (跳过等待)
  "craft_done": (ctx) => {
    const f = furniMod.node(ctx.save);
    if (!f.craft) return "没有进行中的制作";
    f.craft.finishAt = 0;
    const furni2 = merchantMod.merchantTick(ctx.save, ctx.push, now());
    return furni2 ? "制作已完成 (家具入库)" : "结算未触发 (稍后 tick 补)";
  },
  // 花盆: 全部催熟 (stage→3)
  "flowerpot_grown": (ctx) => {
    const s = ctx.save;
    flowerpotMod.flowerpotTick(s, now());
    const fp = s.flowerpot;
    for (const slot of fp.slots) {
      if (slot.id) { slot.plantedAt = now() - flowerpotMod.PLANT_STAGE_SEC * 3; slot.stage = 3; }
    }
    ctx.push("furniture_load_flowerpot", flowerpotMod.flowerpotPayload(s));
    return `花盆 ${fp.slots.length} 槽全部成熟 (可收获)`;
  },

  // --- 照片/日记/邮件 ---
  "photo_new": (ctx, p) => {
    const s = ctx.save;
    const n = Math.max(1, Math.min(Number(p.n) || 3, 10));
    let added = 0;
    for (let i = 0; i < n; i++) {
      const picId = travel.randomPictureId();
      if (s.pictures.some((x) => x.pic_id === picId) || s.albumPending.some((x) => x.pic_id === picId)) continue;
      s.pictureSeq = (s.pictureSeq || 0) + 1;
      s.albumPending.push({ id: s.pictureSeq, pic_id: picId, read: 0, new: 1 });
      added++;
    }
    ctx.push("album_load_new", {
      pictures: s.albumPending.map((x) => Object.assign(travel.withLayers(x), { for_ads: 0 })),
      visted_pic: [], has_ads: false, is_share: false,
    });
    return `已发放 ${added} 张新照片 (待归档桶, 点蛙查看)`;
  },
  "photo_album": (ctx, p) => {
    const s = ctx.save;
    const n = Math.max(1, Math.min(Number(p.n) || 3, 30));
    let added = 0;
    for (let i = 0; i < n && s.pictures.length < travel.albumCapacity(s); i++) {
      const picId = travel.randomPictureId();
      if (s.pictures.some((x) => x.pic_id === picId)) continue;
      s.pictureSeq = (s.pictureSeq || 0) + 1;
      s.pictures.push({ id: s.pictureSeq, pic_id: picId, read: 0, new: 0 });
      added++;
    }
    ctx.push("album_load", { pictures: s.pictures.map(travel.withLayers), total: s.pictures.length, start: 1 });
    return `已归档 ${added} 张照片 (相册共 ${s.pictures.length})`;
  },
  "note_new": (ctx, p) => {
    const s = ctx.save;
    const n = Math.max(1, Math.min(Number(p.n) || 2, 10));
    let added = 0;
    for (let i = 0; i < n; i++) {
      const noteId = travel.randomNoteId();
      if (noteId < 0 || s.note_list.some((x) => x.id === noteId)) continue;
      s.note_list.push({ id: noteId, read: 0, timestamp: now() });
      added++;
    }
    if (added) {
      ctx.push("travel_load_note", { note_list: s.note_list });
    }
    return `已发放 ${added} 条未读日记 (蛙写字时可查看)`;
  },
  "mail_new": (ctx, p) => {
    const s = ctx.save;
    const n = Math.max(1, Math.min(Number(p.n) || 1, 5));
    for (let i = 0; i < n; i++) {
      s.mailSeq = (s.mailSeq || 0) + 1;
      s.mails.push({
        id: s.mailSeq,
        type: 3, // Mail.EvtId.Gift
        title: "GM 测试邮件",
        message: "开发者模式发放的测试邮件",
        // 客户端 MailInfo 只认 sender 字段 (Gift 类型按 sender 匹配发件人贴图)
        sender: -1,
        auto_open: false,
        expire: 0,
        read: false,
        opened: false,
        // resource 与 pictures 是客户端 revice_mails 的必读字段 (缺会抛异常)
        resource: { clover_point: 100, ticket: 0, reward_gacha: 0, ads_id: "", share_id: "" },
        items: [],
        pictures: [],
      });
    }
    ctx.push("mail_load", s.mails);
    return `已发放 ${n} 封测试邮件 (含 100 三叶草附件)`;
  },

  // --- 引导 ---
  // 完成新手引导: 屋内 updateFlogStatus 对 guideStep != Complete 的存档强制
  // sitaku_ie (门口背包准备) 姿势, 无视服务器 motion 轮换 —— 测试号/跳过教程用
  "guide_complete": (ctx) => {
    const s = ctx.save;
    let client = {};
    try { client = JSON.parse(s.settings.client || "{}"); } catch (e) { client = {}; }
    if (client.guideStep === "Complete") return "引导已是完成状态";
    client.guideStep = "Complete";
    s.settings.client = JSON.stringify(client);
    ctx.push("client_load_role", travel.rolePayload(s)); // settings.client 随推, 客户端即时重摆姿势
    return "新手引导已标记完成 (guideStep=Complete) — 蛙姿势交还 motion 轮换";
  },

  // --- 商店/存档 ---
  "shop_reset": (ctx) => {
    const s = ctx.save;
    s.items.purchased = {};
    ctx.push("item_load_shop_info", {
      purchased: Object.entries(s.items.purchased)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => ({ item_id: Number(id), count: n })),
    });
    return "商店限购计数已清零";
  },
  "reset_save": (ctx) => {
    const fresh = saveMod.newSave(ctx.save.account);
    // 原位替换 (保持在线连接持有的引用不变)
    Object.keys(ctx.save).forEach((k) => delete ctx.save[k]);
    Object.assign(ctx.save, fresh);
    return "存档已重置 (教程从新档开始; 若卡引导请刷新页面)";
  },
  "push_refresh": (ctx) => {
    pushAllState(ctx); // 全量状态重推, 客户端各模型整体刷新
    return "已全量推送全部状态";
  },

  // --- 查询 ---
  "status": (ctx) => {
    const s = ctx.save;
    const phase = s.travel.phase === "traveling"
      ? `旅行中 (还有 ${Math.max(0, s.travel.returnAt - now())}s 回家)`
      : `在家 (下一趟 ${Math.max(0, s.travel.departAt - now())}s 后)`;
    const d = drawingMod.node(s);
    const party = d.state === 0
      ? (drawingMod.isOpen(s) ? "未开启 (有绘本)" : "未开启 (无绘本)")
      : `state=${["wait", "invite", "accept", "lock", "visit"][d.state]} 邻居=${d.guest >= 0 ? drawingMod.GUEST_NAMES[d.guest] : "?"} (页${d.pages.length} 收藏${d.colls.length})`;
    return [
      `账户: ${s.account}`,
      `青蛙: ${s.frog.status === 1 ? "旅行中" : s.frog.status === 3 ? "聚会中" : "在家"} | ${phase}`,
      `三叶草: ${s.res.clover_point} | 抽奖券: ${s.res.ticket}`,
      `物品栏: ${s.items.house.length} 种 | 相册: ${s.pictures.length} 张 (+${s.albumPending.length} 待归档)`,
      `日记: ${s.note_list.length} 条 | 特产图鉴: ${s.handbook.specialtys.length} 种`,
      `小伙伴: ${s.guest ? `在家 (id=${s.guest.id})` : "无"} | 邮差: ${s.visitor ? s.visitor.name : "无"}`,
      `涂鸦派对: ${party}`,
    ].join("\n");
  },
};

/** 指令列表 (GM 面板/控制台帮助) */
function help() {
  return Object.keys(actions).join(", ");
}

/**
 * 执行 GM 动作。
 * @param {object} save  目标存档 (在线连接传其 save 引用; 离线传 load 结果)
 * @param {string} action 动作名
 * @param {object} params 参数
 * @param {function} push 推送函数 (在线=ws.push, 离线=丢弃)
 * @returns {{ok: boolean, info: string}} 执行结果 (调用方负责 persist)
 */
function run(save, action, params, push) {
  const fn = actions[action];
  if (!fn) return { ok: false, info: `未知指令 "${action}"。可用: ${help()}` };
  const ctx = { save, push: push || (() => {}) };
  try {
    const info = fn(ctx, params || {});
    return { ok: true, info: String(info) };
  } catch (e) {
    return { ok: false, info: `执行异常: ${e.message}` };
  }
}

/** 物品列表 (GM 面板选择器): [{id, name, type, type_label}] */
function itemCatalog() {
  return ITEM_ROWS
    .filter((r) => typeof r.id === "number" && r.name)
    .map((r) => ({ id: r.id, name: r.name, type: r.type, type_label: TYPE_LABEL[r.type] || "type" + r.type }))
    .sort((a, b) => a.type - b.type || a.id - b.id);
}

module.exports = { run, help, itemCatalog, actions };
