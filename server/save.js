/**
 * 存档管理: server/data/user/<account>.json (用户数据独立分级;
 * 旧版平铺在 server/data/ 的存档读取时自动迁移)
 * 服务器权威存档 —— 对应官方架构中游戏状态全部在服务器端
 */
const fs = require("fs");
const path = require("path");
const { COMPOST_DEFAULT_ID, POCKET_DEFAULT_ID } = require("./furni");

const DATA_DIR = path.join(__dirname, "data");
const USER_DIR = path.join(DATA_DIR, "user");
fs.mkdirSync(USER_DIR, { recursive: true });

// 三叶草参数 (对齐官方 Define / 社区考据值)
// - FourLeafCloverID=1e3, StartCloverPoint=9999 来自客户端 Define 常量表
// - 重生时长 ~2h 正态分布: 日历提示"三叶草大概3小时就会长满"
// - 四叶草概率 1% (社区值)
const CLOVER = {
  // 官方 CloverFarm: cloverMax=20 (庭院 p_clover1~20 位置点, 日服反编译确认)
  SLOTS: 20,
  ELEMENT: { THREE: 0, FOUR: 1, ITEM: 2 },
  FOUR_LEAF_ID: 1000,
  FOUR_LEAF_CHANCE: 0.01,
  // 稀有物品: 三叶草地偶尔长出基础材料 (10001-10007, 工作台制作刚需)
  // 官方语义 element=2 + sprite=item_id, 收割时 pushItemSync(sprite) 入屋
  ITEM_CHANCE: 0.02,
  ITEM_POOL: [10001, 10002, 10003, 10004, 10005, 10006, 10007],
  REBIRTH_MEAN: 7200,
  REBIRTH_SD: 1800,
  REBIRTH_MIN: 300,
  REBIRTH_MAX: 14400,
  START_CLOVER: 9999,
};

// 新档/迁移档的首次出门准备窗口 (秒): 给玩家放便当的时间
const PREP_WINDOW = 120;

// 不可见旅行笔记 id 集 (Note.json 无 type 的 attach 子笔记): 客户端
// TravelNoteView 按 config.type 分 tab, 无 type 不进任何 tab → 无法读取。
// 历史 NOTE_IDS 未过滤曾误发 (如 20200/20010), 顶角标 (NEW_NOTE) 永久常亮,
// 加载时剔除 —— 与 travel.js NOTE_IDS 过滤同源, 读失败视为空集 (不迁移)
const NOTE_INVISIBLE = new Set((() => {
  try {
    const t = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "resource", "China", "config", "TravelNote", "Note.json"), "utf-8"));
    return (Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]))
      .filter((n) => n && typeof n === "object" && n.type !== 1 && n.type !== 2)
      .map((n) => n.id);
  } catch (e) { return []; }
})());

// 初始便当/道具 (原版新手配置的合理近似)
const START_ITEMS = [
  { item_id: 1, count: 3 },  // 三明治
  { item_id: 2, count: 2 },  // 葡萄司康
  // 特殊制作永久配方 (type13 图纸, 制作不消耗; 11101 合页/11102 编绳上台触发)
  { item_id: 10401, count: 1 }, // 不倒翁图鉴
  { item_id: 10601, count: 1 }, // 挂兜手工制作
];

/** 重生时长: 正态分布 (Box-Muller), 截断到 [MIN, MAX] */
function rollRebirth() {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const s = CLOVER.REBIRTH_MEAN + z * CLOVER.REBIRTH_SD;
  return Math.min(CLOVER.REBIRTH_MAX, Math.max(CLOVER.REBIRTH_MIN, Math.round(s)));
}

/** 重生时的元素重掷: 1% 四叶草, 2% 稀有材料, 其余普通三叶草 (sprite=1 为普通外观) */
function rollRegrow() {
  const r = Math.random();
  if (r < CLOVER.FOUR_LEAF_CHANCE) return { element: CLOVER.ELEMENT.FOUR, sprite: 1 };
  if (r < CLOVER.FOUR_LEAF_CHANCE + CLOVER.ITEM_CHANCE) {
    // 稀有物品: sprite = item_id (harvestClover element 2 分支按 sprite 入屋)
    const pool = CLOVER.ITEM_POOL;
    return { element: CLOVER.ELEMENT.ITEM, sprite: pool[Math.floor(Math.random() * pool.length)] };
  }
  return { element: CLOVER.ELEMENT.THREE, sprite: 1 };
}

/**
 * 重生检查 (服务器权威): 到期槽位重置为可收 + 重掷元素
 * 同时修复旧档 element=2 且 sprite 无效的槽位
 * @returns {boolean} 是否有槽位发生变化 (调用方据此推送 clover_load_clovers)
 */
function refreshClovers(save) {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const c of save.clovers) {
    if (c.element === CLOVER.ELEMENT.ITEM && !(c.sprite > 0)) {
      // 旧档脏数据: rollElement 曾掷出 2 但从未设置 sprite
      Object.assign(c, rollRegrow());
      changed = true;
    }
    if (c.last_harvest > 0 && c.last_harvest + c.rebirth_span <= now) {
      c.last_harvest = 0; // 0 = 已长成可收
      Object.assign(c, rollRegrow());
      changed = true;
    }
  }
  return changed;
}

/** 新档默认状态 */
function newSave(account) {
  const now = Math.floor(Date.now() / 1000);
  return {
    account,
    uid: String(Math.floor(Math.random() * 1e9)),
    create_time: now,
    // 货币 (官方 Define.StartCloverPoint)
    res: { clover_point: CLOVER.START_CLOVER, ticket: 0 },
    // 客户端设置 (settings.client 为 JSON 字符串)
    settings: {
      client: JSON.stringify({ guideStep: "New", bgSound: 1, effectSound: 1 }),
      push_switch: true,
      rank_switch: false,
    },
    misc: { picture_cnt: 0, wx_push_reward: 0, wx_my_reward: 1, create_time: now },
    // 青蛙
    frog: {
      name: "",
      cur_achieve: 0,
      achieves: [],
      achieves_time: [],
      status: 0,    // 0 = 在家, 1 = 旅行中 (客户端 isHome 判 0)
      motion: 0,    // 在家动作 (0~13; -1 会让客户端 FrogMotionName[-1]=undefined → 蛙不渲染)
      icon: 0,
      pic_show: 0,
      today_step: 0,
      decoration: [],
      taobao_data: null,
      // 动作轮换状态 (travel.js refreshFrogMotion 使用, 不下发客户端)
      motionPattern: null, // Frogpattern 表序号 0~2
      motionStep: 0,       // 序列内步进
      motionNextAt: 0,     // 下次轮换时刻 (秒)
    },
    // 旅行状态机 (travel.js 引擎驱动)
    travel: {
      phase: "home",      // home | traveling
      departAt: now + PREP_WINDOW, // 计划出门时刻 (先给一段准备窗口)
      returnAt: 0,         // 回家时刻 (旅行中)
      stray: false,        // 放浪 (没带便当的短途)
      plan: null,          // 出门携带 {lunchId, lunchPrice, carried[]}
      tripCount: 0,
      eventSeq: 1,         // 事件实例 id 序列 (client_confirm_event 回传)
    },
    // 三叶草地: last_harvest=0 表示立即可收
    clovers: Array.from({ length: CLOVER.SLOTS }, (_, i) => ({
      clover_id: i + 1,
      element: CLOVER.ELEMENT.THREE,
      sprite: 1,
      last_harvest: 0,
      rebirth_span: CLOVER.REBIRTH_MIN,
    })),
    // 物品: house=[{item_id,count}] bag/desk=位置数组(-1空) purchased=商店限购计数
    // 槽位类型 (客户端 BagItem/DeskItem 枚举): bag=便当1/护符1/工具2,
    // desk=便当2/护符2/工具4 —— UI 按索引绘制不做类型检查, 必须放对槽
    items: {
      house: START_ITEMS.map((x) => ({ ...x })),
      bag: [-1, -1, -1, -1],
      desk: [-1, -1, -1, -1, -1, -1, -1, -1],
      bag_completed: false,
      // color_ball: 待领取的抽奖球 rank (Prize.Rank 0..5), -1 = 无
      // (0 是合法的白球值 —— 初始必须 -1, 否则进抽奖界面即播白球动画)
      gacha: { color_ball: -1 },
      purchased: {},   // shop_id -> 已购次数
    },
    events: [],        // 旅行事件队列 (待 client_confirm_event 确认)
    note_list: [],     // 旅行日志 [{id, read, timestamp}]
    pictures: [],      // 相册已归档照片 [{id, pic_id, read, new}]
    albumPending: [],  // 新照片待归档桶 (album_load_new 下发)
    albumDeleted: [],  // 相册回收站 (album_load_recover)
    pictureSeq: 0,     // 照片唯一 id 序列
    specialtys: [],    // 礼盒特产 [{item_id, count}]
    giftPictures: [],  // 礼盒照片桶 (travel_gift_to_album 转入 / travel_album_to_gift 转出)
    // 访客系统 (guest.js 引擎驱动):
    // guest = 庭院小伙伴 (困困/胖胖/跳跳, Character.json), 玩家用特产投喂
    guest: null,       // {id, confirmed, served, expire_time, pos, startAt} | null=无到访
    guestCoolUntil: 0, // 小伙伴离开后的冷却
    guestNextRollAt: 0,
    guestFeeds: 0,     // 累计投喂次数 (FRIEND_ITEM_DEBUFF 衰减档位)
    // visitor = 串门邮差 (visitors.json 省份表), 首访送省花/复访送礼
    visitor: null,     // {province, name, title, expire_time, city, food, first, gift, carpet} | null
    visitorCoolUntil: 0,
    visitorNextRollAt: 0,
    acquireProvinces: [], // 已获得省花 (visit_load.acquire 下发)
    // merchant = 旅行商人嘟嘟 (家具商店), 与小伙伴/邮差独立
    merchant: null,     // {shop: {start_time, leave_time, shop_list} | null, lastVisit, coolUntil, nextRollAt}
    // furniture = 家具工坊 (furni.js 引擎驱动):
    //   bench 10 槽 ([0..4]=工具 [5..9]=物品, -1=空), benchLock 制作中锁台,
    //   craft 进行中制作 {furnitureId, drawing, materials, startedAt, finishAt},
    //   owned 已拥有家具 id 列表 (has_fur), placed 已摆放 [{type,id}] (put_fur),
    //   replaceFur 已展示 type 列表, compost 堆肥盒 {boxes[6](0=空), showIndex,
    //   replaceIndex, list 拥有外观 (compostData 表 id, 初始默认款并展示)}
    furniture: {
      bench: [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
      benchLock: 0,
      craft: null,
      owned: [],
      placed: [],
      replaceFur: [],
      compost: { boxes: [0, 0, 0, 0, 0, 0], showIndex: 1, replaceIndex: 0, list: [COMPOST_DEFAULT_ID] },
      // 不倒翁: 每只独立 {id, layers:[{layer:[part,x,y,rot,flip]}]}, 允许同款多只
      tumbler: { list: [], showIndex: 0, replaceIndex: 0 },
      // 挂兜: 22001 初始款默认展示 (对齐堆肥箱先例); clover 攒钱 ≤99
      pocket: { list: [POCKET_DEFAULT_ID], showIndex: 1, replaceIndex: 0, clover: 0, lastGainAt: 0 },
      // 装饰插花: putId=当前花 (decoration id), status 1=花苞 2=绽放
      decorate: { putId: 0, status: 0, putAt: 0 },
    },
    // flowerpot = 栽培花盆 (flowerpot.js 引擎驱动, 官方语义: 全服务器驱动无种植命令)
    flowerpot: {
      slots: [],       // [{id, stage(1..3), plantedAt}] 长度 = pos_list 槽位数
      grown: [],       // 已收获过的植物 id (图鉴记录)
    },
    handbook: { specialtys: [], collections: [] }, // 图鉴
    // 涂鸦派对 (drawing.js 引擎驱动): null=未开启 (house 有 7001 涂鸦本后
    // drawingTick 惰性建档); 结构见 drawing.js node()
    drawing: null,
    stories: [],       // 涂鸦派对故事纪念品 [{id, gift: -1|item_id, giftAt}] (story.js)
    new_story_id: 0,
    tasks: [],         // 成就领奖台账 (已领 taskData.task_list id 数组)
    moments: [],       // 彩蛋时刻已解锁 id (momentData.json list, misc_moment_unlock)
    // 彩蛋引擎 (egg.js): 蛙稀有动作状态机 {type, until, nextRollAt, pushed};
    // 首掷延迟 (默认 1h, 避开新手引导时段; 测试用 FROG_EGG_FIRST_SEC 调短)
    egg: { type: 0, until: 0, nextRollAt: now + Number(process.env.FROG_EGG_FIRST_SEC || 3600), pushed: [] },
    // 周期计划 (plans.js): {key: 计划type→周期键, prog: 任务id→进度, claimed: 计划type→已领档}
    plans: { key: {}, prog: {}, claimed: {} },
    // 月度烹饪 (cooking.js): null=未开启 (登录 tick 惰性建档); 结构见 cooking.js ensure()
    cooking: null,
    // 祈愿/手工 (pray.js): {wish_new: null|{content,stamp,stamp_state,make_time,stamp_time}, wishs: []}
    pray: null,
    // 图鉴 (ency.js): {eat: {itemId: 携带次数}, plants: [long_id], grow: {条目id: 次数}, show: {条目id: long_id}}
    ency: null,
    // 动态照片 (animpic.js): {guide, phase, item_num, exp, exp_pic: [], pic_list: [], lastAt}
    animpic: null,
    // 周末小插曲 (lottery.js): null=未开启 (周末 node() 建档); 结构见 lottery.js
    lottery: null,
    mails: [],         // 邮件 (read/opened 状态在邮件对象上, mail_read/mail_open 直标)
    // 日历: 新手签到领取标记 (下标=天数-1, 1=已领); 幸运日 (当月, day→item_id,
    // 领取后删除); lucky_month = 幸运日所属 "YYYY-MM" (跨月重掷, handlers.js)
    calendar: {
      new_flag: [0, 0, 0, 0, 0, 0, 0],
      lucky_days: {}, st_days: {}, lucky_month: "",
    },
    // 称号/成就统计 (achieve.js, task.js):
    // loginDays=累计登录天数 (utcDay 去重), gachaCount=抽奖次数,
    // lunchHistory=最近 4 次出发便当 id (连续果汁判定),
    // cloverHarvested=累计收割株数 / fourLeafGained=累计四叶草 (成就 901/902),
    // guestVisits=小伙伴到访次数 (成就 401), partyDone=聚会完成次数 (成就 403)
    stats: {
      loginDays: 0, lastLoginDay: 0, gachaCount: 0, lunchHistory: [],
      cloverHarvested: 0, fourLeafGained: 0, guestVisits: 0, partyDone: 0,
    },
  };
}

/** 读档 (不存在则建档); 每 account 一档 */
function load(account) {
  const safe = String(account).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_");
  const file = path.join(USER_DIR, safe + ".json");
  const legacy = path.join(DATA_DIR, safe + ".json");
  // 旧版平铺存档迁移: 读到即搬到 user/ 分级目录 (原文件删除)
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    try { fs.copyFileSync(legacy, file); fs.unlinkSync(legacy); }
    catch (e) { /* 迁移失败则继续走原路径读取 */ }
  }
  if (fs.existsSync(file)) {
    try {
      const save = JSON.parse(fs.readFileSync(file, "utf-8"));
      // 版本迁移: 补齐新增字段
      if (!save.calendar) save.calendar = { new_flag: [0, 0, 0, 0, 0, 0, 0], lucky_days: {}, st_days: {} };
      if (save.calendar.lucky_month === undefined) save.calendar.lucky_month = "";
      // 抽奖旧档迁移: 实现协议前的初始污染值 0 (白球) —— 当时 item_gacha 无
      // handler, 兜底响应无 ticket 字段, 抽奖必然崩溃, 不可能存在真实待领球
      if (!save.items.gacha) save.items.gacha = { color_ball: -1 };
      if (save.items.gacha.color_ball === 0 && !save.items.gacha.rolled) save.items.gacha.color_ball = -1;
      if (!save.items.purchased) save.items.purchased = {};
      if (!save.travel) save.travel = {
        phase: "home", departAt: Math.floor(Date.now() / 1000) + PREP_WINDOW, returnAt: 0,
        stray: false, plan: null, tripCount: 0, eventSeq: 1,
      };
      if (!save.pictures) save.pictures = [];
      if (!save.albumPending) save.albumPending = [];
      if (!save.albumDeleted) save.albumDeleted = [];
      if (!save.specialtys) save.specialtys = [];
      if (!save.handbook) save.handbook = { specialtys: [], collections: [] };
      if (save.frog && save.frog.status === -1) save.frog.status = 0; // 旧档 -1 → 0 (在家)
      if (save.frog) {
        // 旧档 motion=-1 → 0 (undefined 动作名导致蛙不渲染)
        if (!(save.frog.motion >= 0)) save.frog.motion = 0;
        // 动作轮换字段补齐
        if (save.frog.motionPattern === undefined) save.frog.motionPattern = null;
        if (save.frog.motionStep === undefined) save.frog.motionStep = 0;
        if (save.frog.motionNextAt === undefined) save.frog.motionNextAt = 0;
      }
      // note read 字段统一为 0/1 (客户端 hasUnreadNote 以 0 == read 判未读)
      for (const n of save.note_list || []) {
        if (n.read === true) n.read = 1;
        else if (n.read !== 1) n.read = 0;
      }
      // 剔除历史误发的不可见笔记 (无 type 的 attach 子笔记, 任何 tab 都不显示)
      if (NOTE_INVISIBLE.size && save.note_list && save.note_list.some((n) => NOTE_INVISIBLE.has(n.id))) {
        save.note_list = save.note_list.filter((n) => !NOTE_INVISIBLE.has(n.id));
      }
      // 邮件已读迁移: 旧版 mail_read 只写 mails_read 旁路字典不回填邮件对象,
      // mail_load 全量推送时已读邮件重新显示未读 —— 回填后清空字典
      if (save.mails_read && Object.keys(save.mails_read).length) {
        for (const m of save.mails || []) {
          if (!m.read && save.mails_read[m.id]) m.read = true;
        }
        save.mails_read = {};
      }
      if (save.items.bag_completed === undefined) save.items.bag_completed = false;
      // 旧档 bug 修正: 蛙回家未重置的行囊锁定 (客户端 bagLock 永久锁死背包)。
      // 「准备完成」与出发在同一请求内原子完成 (item_set_bag_completed),
      // 在家 + 锁定的持久态只可能是回家残留
      if (save.items.bag_completed === true && save.frog && save.frog.status === 0) {
        save.items.bag_completed = false;
      }
      // 访客系统字段补齐 (v3)
      if (save.drawing === undefined) save.drawing = null; // 涂鸦派对 (drawing.js)
      if (save.guest === undefined) save.guest = null;
      if (save.guestCoolUntil === undefined) save.guestCoolUntil = 0;
      if (save.guestNextRollAt === undefined) save.guestNextRollAt = 0;
      if (save.guestFeeds === undefined) save.guestFeeds = 0;
      if (save.visitor === undefined) save.visitor = null;
      if (save.visitorCoolUntil === undefined) save.visitorCoolUntil = 0;
      if (save.visitorNextRollAt === undefined) save.visitorNextRollAt = 0;
      if (save.acquireProvinces === undefined) save.acquireProvinces = [];
      if (save.merchant === undefined || save.merchant === null) save.merchant = {};
      if (save.merchant.shop === undefined) save.merchant.shop = null;
      if (save.giftPictures === undefined) save.giftPictures = [];
      // 家具工坊字段补齐 (v5); 旧档 bench 挂在 merchant 下 → 迁至 furniture
      if (!save.furniture) {
        save.furniture = {
          bench: [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
          benchLock: 0, craft: null, owned: [], placed: [], replaceFur: [],
          compost: { boxes: [0, 0, 0, 0, 0, 0], showIndex: 0, replaceIndex: 0 },
        };
      }
      if (save.merchant.bench !== undefined) {
        if (save.merchant.bench.length === 10) save.furniture.bench = save.merchant.bench;
        delete save.merchant.bench;
      }
      if (save.furniture.benchLock === undefined) save.furniture.benchLock = 0;
      if (save.furniture.craft === undefined) save.furniture.craft = null;
      if (!Array.isArray(save.furniture.owned)) save.furniture.owned = [];
      if (!Array.isArray(save.furniture.placed)) save.furniture.placed = [];
      if (!Array.isArray(save.furniture.replaceFur)) save.furniture.replaceFur = [];
      if (!save.furniture.compost) {
        save.furniture.compost = { boxes: [0, 0, 0, 0, 0, 0], showIndex: 1, replaceIndex: 0, list: [COMPOST_DEFAULT_ID] };
      }
      if (!Array.isArray(save.furniture.compost.boxes)) {
        save.furniture.compost.boxes = [0, 0, 0, 0, 0, 0];
      }
      while (save.furniture.compost.boxes.length < 6) save.furniture.compost.boxes.push(0);
      if (!Array.isArray(save.furniture.compost.list)) {
        // 旧档补送初始堆肥箱外观 (未曾拥有列表 = 未初始化); 未主动隐藏过则默认展示
        save.furniture.compost.list = [COMPOST_DEFAULT_ID];
        if (!save.furniture.compost.showIndex) save.furniture.compost.showIndex = 1;
      }
      // 不倒翁/挂兜/装饰 节点补齐 (v6); 旧档 craft 无 kind 字段 → craftTick 按 furniture
      if (!save.furniture.tumbler) save.furniture.tumbler = { list: [], showIndex: 0, replaceIndex: 0 };
      if (!Array.isArray(save.furniture.tumbler.list)) save.furniture.tumbler.list = [];
      if (!save.furniture.pocket) {
        // 补送初始挂兜 22001 并默认展示 (官方抓包 list 含之, 对齐堆肥箱先例)
        save.furniture.pocket = { list: [POCKET_DEFAULT_ID], showIndex: 1, replaceIndex: 0, clover: 0, lastGainAt: 0 };
      }
      if (!Array.isArray(save.furniture.pocket.list)) save.furniture.pocket.list = [POCKET_DEFAULT_ID];
      if (!save.furniture.decorate) save.furniture.decorate = { putId: 0, status: 0, putAt: 0 };
      // 补送特殊制作永久图纸 (一次性, 幂等): 不倒翁图鉴 + 挂兜手工制作
      for (const pid of [10401, 10601]) {
        if (!save.items.house.find((x) => x.item_id === pid)) {
          save.items.house.push({ item_id: pid, count: 1 });
        }
      }
      // 栽培花盆字段补齐 (v5); slots 由 flowerpot.js 首次 tick 按配置播种
      if (!save.flowerpot) save.flowerpot = { slots: [], grown: [] };
      // 称号统计节点补齐 (v7): 旧档没有 loginDays/gachaCount/lunchHistory
      if (!save.stats) save.stats = { loginDays: 0, lastLoginDay: 0, gachaCount: 0, lunchHistory: [] };
      if (!Array.isArray(save.stats.lunchHistory)) save.stats.lunchHistory = [];
      for (const k of ["cloverHarvested", "fourLeafGained", "guestVisits", "partyDone"]) {
        if (typeof save.stats[k] !== "number") save.stats[k] = 0;
      }
      // 彩蛋时刻 (v8) + 故事纪念品字段规整 (gift 未送 = -1)
      if (!Array.isArray(save.moments)) save.moments = [];
      if (!Array.isArray(save.stories)) save.stories = [];
      for (const st of save.stories) {
        if (typeof st.gift !== "number") st.gift = -1;
        if (typeof st.giftAt !== "number") st.giftAt = 0;
      }
      // 彩蛋引擎节点 (v8)
      if (!save.egg) save.egg = { type: 0, until: 0, nextRollAt: 0, pushed: [] };
      if (!Array.isArray(save.egg.pushed)) save.egg.pushed = [];
      // 周期计划节点 (v8)
      if (!save.plans) save.plans = { key: {}, prog: {}, claimed: {} };
      // 月度烹饪节点 (v9): null=未开启, 登录 tick 惰性建档
      if (save.cooking === undefined) save.cooking = null;
      // 祈愿节点 (v9): null=未开启, pray.js node() 惰性建档
      if (save.pray === undefined) save.pray = null;
      // 图鉴节点 (v9): null=未开启, ency.js node() 惰性建档
      if (save.ency === undefined) save.ency = null;
      // 动态照片节点 (v9): null=未开启, animpic.js node() 惰性建档
      if (save.animpic === undefined) save.animpic = null;
      // 周末小插曲节点: null=未开启, 周末登录时 lottery.js node() 建档
      if (save.lottery === undefined) save.lottery = null;
      if (!Array.isArray(save.flowerpot.slots)) save.flowerpot.slots = [];
      if (!Array.isArray(save.flowerpot.grown)) save.flowerpot.grown = [];
      // 特产入栏迁移 (v4): 特产旧存档在礼盒(specialtys)中不可投喂 ——
      // 客户端投喂弹窗 PlayerBag(Specialty) 只读物品栏(house)。
      // 迁移: 礼盒特产全部转入 house, 礼盒清空 (玩家可再用 travel_bag_to_gift 收藏)。
      if (Array.isArray(save.specialtys) && save.specialtys.length) {
        for (const row of save.specialtys) {
          const count = Number(row.count) || 0;
          if (!(row.item_id > 0) || count <= 0) continue;
          const house = save.items.house.find((x) => x.item_id === row.item_id);
          if (house) house.count += count;
          else save.items.house.push({ item_id: row.item_id, count });
          if (save.handbook && !save.handbook.specialtys.includes(row.item_id)) {
            save.handbook.specialtys.push(row.item_id);
          }
        }
        save.specialtys = [];
      }
      // 槽位扩容: clovers 4→20 (官方 cloverMax=20), desk 3→8 (DeskItem 枚举)
      while (save.clovers.length < CLOVER.SLOTS) {
        save.clovers.push({
          clover_id: save.clovers.length + 1,
          element: CLOVER.ELEMENT.THREE,
          sprite: 1,
          last_harvest: 0, // 新槽立即可收
          rebirth_span: CLOVER.REBIRTH_MIN,
        });
      }
      while (save.items.desk.length < 8) save.items.desk.push(-1);
      refreshClovers(save); // 服务器权威: 离线期间到期的三叶草重生长
      return save;
    } catch (e) {
      console.error(`[save] 读档失败 ${safe}: ${e.message}, 重建`);
    }
  }
  const save = newSave(safe);
  fs.writeFileSync(file, JSON.stringify(save, null, 1), "utf-8");
  return save;
}

/** 写档 (原子写; Windows 下 rename 可能被杀软/索引短暂锁定 EPERM, 重试) */
function persist(save) {
  const file = path.join(USER_DIR, save.account + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(save), "utf-8");
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EACCES") throw e;
      const wake = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      void wake;
    }
  }
  throw lastErr;
}

module.exports = { load, persist, newSave, rollRebirth, rollRegrow, refreshClovers, CLOVER };
