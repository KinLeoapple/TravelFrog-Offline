/**
 * 成就任务 (taskData.json task_list, 30 项一次性成长成就)
 *
 * 客户端契约 (main.min.js GuideTaskModel 逆向):
 *   task_load {tasks: [{id, pro, is_reward}], list: []}   —— tasks 即成就进度表
 *   红点/领奖按钮: pro >= TaskDB.count && !is_reward
 *   task_get_reward {id} → code 0 后客户端本地置 is_reward 并调 addHouseItem
 *   (空壳 stub) —— 奖励入账必须由服务端推送 clover_update / item_update 完成
 *
 * 进度为纯计算 (count 字段语义见 PROGRESS 表注释), 服务端只持久化领奖台账
 * s.tasks (已领成就 id 数组), 不存进度 —— 数据源变化时进度自动回填。
 */
const fs = require("fs");
const path = require("path");
const photo = require("./photo");
const travel = require("./travel");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const readJson = (name, dir) =>
  JSON.parse(fs.readFileSync(path.join(CFG, dir, name), "utf-8"));
const rows = (name, dir) => {
  const t = readJson(name, dir);
  return Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]).filter((r) => r && typeof r === "object");
};

// taskData.json = {list_map, list_type, task_list, task_type};
// task_list 才是成就表 (list_map/list_type 为是日/当周等周期清单, 单机不做)
const TASK_DATA = readJson("taskData.json", "Task").task_list;
const TASK_LIST = Object.keys(TASK_DATA).map((k) => TASK_DATA[k]);
const TASK_BY_ID = new Map(TASK_LIST.map((t) => [t.id, t]));
// 货币 id (官方 Define): 任务奖励表里的 200000 = 三叶草
const CLOVER_CURRENCY_ID = 200000;
// 笔记 id → type (1=见闻 2=旅友)
const NOTE_TYPE = new Map(rows("Note.json", "TravelNote").map((n) => [n.id, n.type]));

// ---------- 照片判定 ----------
// 含蛙: Picture.json frogPose 非空 (官方设计该照片有蛙)
const PHOTO_HAS_FROG = new Set();
// 合影: 实际组合出的 layers 含旅伴 (照片按 pic_id 确定性组层, 可离线判定)
const PHOTO_HAS_COMPANION = new Set();
for (const [id, row] of photo.PICTURE_DB) {
  if (row.frogPose) PHOTO_HAS_FROG.add(id);
  if ((row.travelerPose || []).some(Boolean)) {
    const layers = photo.composeLayers(id);
    if (layers && layers.some((l) => {
      const name = photo.nameOfTexId(l.layer[0]);
      return name && /_(bh|cw|yhc)$/i.test(name); // 旅伴变体后缀 (photo.js 体系)
    })) PHOTO_HAS_COMPANION.add(id);
  }
}

// ---------- 家具套装 (成就 304 "整套风格真好看") ----------
// furnitureData.style 分组; 集齐一套 = 该 style 全部家具已拥有 (单件 style 不算"整套")
const STYLE_GROUPS = new Map();
for (const f of rows("furnitureData.json", "Furnitur")) {
  if (typeof f.style !== "number") continue;
  if (!STYLE_GROUPS.has(f.style)) STYLE_GROUPS.set(f.style, []);
  STYLE_GROUPS.get(f.style).push(f.id);
}
const STYLE_IDS = [...STYLE_GROUPS.entries()]
  .filter(([, ids]) => ids.length >= 3)
  .map(([style]) => style);

/** 全部照片桶 (归档/待归档/礼盒/回收站): 删除过的也算"曾经拍到" */
function allPictures(s) {
  return [].concat(s.pictures || [], s.albumPending || [], s.giftPictures || [], s.albumDeleted || []);
}

const photoCount = (s, set) => allPictures(s).filter((p) => set.has(Number(p.pic_id))).length;

/**
 * 各成就进度 (id → 当前值)
 * 数据源映射 (官方无公开文档, 按 title/count 语义对齐单机玩法):
 *   1/2   等蛙旅行回来/旅行成了常态     travel.tripCount (回家结算)
 *   3     回家还带吃的                  图鉴特产种类 (旅行带回的吃喝)
 *   4     吃不完就是囤                  屋内便当类 (type 0) 总件数
 *   5/6   途中淘了个纪念品/一屋子纪念品 图鉴收藏品种类
 *   7/8   照片里有蛙                    含蛙设计照片张数
 *   9     蛙蛙联合做大事                含旅伴合影张数
 *   101/102 旅行有感/见闻叙事           笔记总数
 *   103   蛙友的结伴记录                旅友笔记 (type 2) 数
 *   104   蛙友待续的故事                涂鸦派对故事纪念品数
 *   105   见一见旅行的朋友              串门邮差送过的省花种数
 *   201~205 祈愿/手工 (pray 未实现)     恒 0
 *   301   蛙~做什么工作呀               旅行商人嘟嘟到访过
 *   302   买了肯定有用                  商店累计购买次数
 *   303   开始装饰小屋                  已摆放家具数
 *   304   整套风格真好看                集齐的家具套装数
 *   401   门口的小卡片                  小伙伴到访次数
 *   402   揭秘~小伙伴身份               投喂小伙伴次数
 *   403   等一个聚会惊喜                涂鸦聚会完成次数
 *   901   屯点家底                      累计收割株数 (stats.cloverHarvested)
 *   902   攒点运气                      累计获得四叶草 (stats.fourLeafGained)
 *   903   日历里的时光美食              新手签到已领天数
 *   904   相册~急需扩容 (无扩容机制)    恒 0
 */
function progressMap(s) {
  const notes = s.note_list || [];
  const friendNotes = notes.filter((n) => NOTE_TYPE.get(n.id) === 2).length;
  const lunches = (s.items.house || [])
    .filter((x) => travel.isType(x.item_id, travel.ITEM_TYPE.LUNCHBOX))
    .reduce((n, x) => n + x.count, 0);
  const bought = Object.values(s.items.purchased || {}).reduce((n, v) => n + v, 0);
  const merchantVisited = (s.merchant && (s.merchant.shop || (s.merchant.lastVisit || 0) > 0)) ? 1 : 0;
  const owned = new Set(s.furniture.owned || []);
  const fullStyles = STYLE_IDS
    .filter((style) => STYLE_GROUPS.get(style).every((id) => owned.has(id))).length;
  const st = s.stats || {};
  const signed = (s.calendar.new_flag || []).reduce((n, v) => n + (v ? 1 : 0), 0);
  const val = {
    1: s.travel.tripCount, 2: s.travel.tripCount,
    3: (s.handbook.specialtys || []).length,
    4: lunches,
    5: (s.handbook.collections || []).length, 6: (s.handbook.collections || []).length,
    7: photoCount(s, PHOTO_HAS_FROG), 8: photoCount(s, PHOTO_HAS_FROG),
    9: photoCount(s, PHOTO_HAS_COMPANION),
    101: notes.length, 102: notes.length,
    103: friendNotes,
    104: (s.stories || []).length,
    105: (s.acquireProvinces || []).length,
    301: merchantVisited, 302: bought,
    303: (s.furniture.placed || []).length, 304: fullStyles,
    401: st.guestVisits || 0, 402: s.guestFeeds || 0, 403: st.partyDone || 0,
    901: st.cloverHarvested || 0, 902: st.fourLeafGained || 0,
    903: signed, 904: 0,
  };
  const out = {};
  for (const t of TASK_LIST) out[t.id] = Math.min(val[t.id] || 0, t.count);
  return out;
}

/** task_load 载荷 (客户端 GuideTaskModel.task_load 契约) */
function payload(s) {
  const pro = progressMap(s);
  const claimed = new Set(s.tasks || []);
  return {
    tasks: TASK_LIST.map((t) => ({ id: t.id, pro: pro[t.id], is_reward: claimed.has(t.id) ? 1 : 0 })),
    list: [], // 周期清单 (是日/当周...) 单机不做
  };
}

/** 领奖校验 + 台账登记; 返回 {ok, reward:{type,id,num}} */
function claim(s, id) {
  const t = TASK_BY_ID.get(Number(id));
  if (!t) return { ok: false };
  if ((s.tasks || []).includes(t.id)) return { ok: false };
  const pro = progressMap(s);
  if (pro[t.id] < t.count) return { ok: false };
  if (!Array.isArray(s.tasks)) s.tasks = [];
  s.tasks.push(t.id);
  return {
    ok: true,
    reward: t.reward_id === CLOVER_CURRENCY_ID
      ? { type: "clover", num: t.num }
      : { type: "item", id: t.reward_id, num: t.num },
  };
}

module.exports = { payload, claim, progressMap, TASK_LIST };
