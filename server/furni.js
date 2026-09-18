/**
 * 家具工坊 (工作台制作 + 家具摆放 + 堆肥盒)
 *
 * 官方语义 (main.min.js + offline-engine 逆向):
 *   - 客户端没有 craft 命令也没有配方表: 玩家把图纸 (ItemType 13) 放进工作台
 *     5-9 号"物品位", 服务器看到图纸 + 材料够 → 自动开工 (锁台), 到点结算推送
 *     TimerEvent.FurnitureFinish(21)
 *   - 图纸决定家具 type 槽位, 同 type 多风格; benchData = 工作台能做的家具清单,
 *     规则取该 type 下 benchData 内 style 最高的那件
 *   - 材料配方原版在服务端不可考 → 【自设计】按 style 给固定配方
 *     (客户端 FurnitureBenchView 渲染材料 10001-10007, count = 拥有 - mate_list 需求)
 *   - furniture_replace_fur {id: 家具id}: code 1=撤下该 type, 0=摆上; 客户端自维护 put_fur
 *   - 堆肥盒 (compost box) 6 格: 槽值 0=空 (非 bench 的 -1), 放入/取出同 bench 语义
 */
const fs = require("fs");
const path = require("path");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");
const read = (p) => JSON.parse(fs.readFileSync(path.join(CFG_DIR, p), "utf-8"));

// ---- 配置表 ----
// benchData: 工作台可制作家具 id 清单 ({id, type})
const BENCH_IDS = new Set(read(path.join("Furnitur", "benchData.json")).map((r) => Number(r && r.id)));
// furnitureData: 家具定义 (id/type/style/drawing/name/icon/...) — 顶层 {id: row}
const FURNI_RAW = read(path.join("Furnitur", "furnitureData.json"));
const FURNI_ROWS = Array.isArray(FURNI_RAW) ? FURNI_RAW : Object.values(FURNI_RAW);
const FURNITURE_BY_ID = new Map(FURNI_ROWS.map((r) => [Number(r.id), r]));

// Item 表 (图纸物品 type=13 判定)
const ITEM_ROWS = read(path.join("MainData", "Item.json"));
const ITEM_BY_ID = new Map(ITEM_ROWS.map((r) => [Number(r.id), r]));

const ITEM_TYPE_DRAWING = 13; // FURNITURE_PAPER 制作教程

// 图纸物品 id -> 家具 type; type -> 可制作家具 {furnitureId, style} (benchData 内 style 最高)
const BLUEPRINT_TYPE = new Map();
const CRAFTABLE_BY_TYPE = new Map();
(() => {
  const byDrawing = new Map();
  for (const v of FURNI_ROWS) {
    const fid = Number(v.id);
    const draw = Number(v.drawing);
    if (!Number.isFinite(fid) || !Number.isFinite(draw)) continue;
    if (!byDrawing.has(draw)) byDrawing.set(draw, []);
    byDrawing.get(draw).push(v);
    if (!BENCH_IDS.has(fid)) continue; // benchData 说了才算"能做"
    const type = Number(v.type);
    const cur = CRAFTABLE_BY_TYPE.get(type);
    const style = Number(v.style);
    if (!cur || style > cur.style || (style === cur.style && fid > cur.furnitureId)) {
      CRAFTABLE_BY_TYPE.set(type, { furnitureId: fid, style });
    }
  }
  for (const [draw, group] of byDrawing) {
    const types = new Set(group.map((v) => Number(v.type)));
    if (types.size !== 1) continue; // 说不清就不认这张图纸
    BLUEPRINT_TYPE.set(draw, [...types][0]);
  }
})();

// 【自设计】材料配方 (原版在服务端): 按家具 style 给看得懂的配方
const CRAFT_MATERIALS_BY_STYLE = {
  11: [{ item_id: 10001, count: 2 }, { item_id: 10005, count: 1 }],  // 田园庆典: 松木x2 + 粗布x1
  101: [{ item_id: 10003, count: 2 }, { item_id: 10007, count: 1 }], // 许愿池: 砂石x2 + 铜块x1
};
const CRAFT_DEFAULT_MATERIALS = [{ item_id: 10001, count: 2 }]; // 默认: 松木x2
const CRAFT_SECONDS = Math.max(5, Number(process.env.FROG_CRAFT_SEC || 15 * 60));

const EMPTY_BENCH = () => [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

// compostData 表: 庭院物什"堆肥箱"外观 (21000 木头堆堆 = 初始款)
// 官方获取链是"聚会学图纸(10501)+工作台制作"; 离线服无聚会系统,
// 对齐 flowerpot 默认送 23001 陶瓷花盆的先例: 默认拥有初始款并展示。
const COMPOST_TABLE = read(path.join("Furnitur", "compostData.json"));
const COMPOST_DEFAULT_ID = Number(Object.keys(COMPOST_TABLE)[0] || 21000);

// ---- 不倒翁 (tumbler) / 挂兜 (pocket) ----
// tumblerData: 36 模板 (20011..20183) {bg,id,info,mask,name};
// tumblerPathData: 68 部件 {adorn,id,res}, 低系 <10000 (模板 ≤20099 用) /
// 高系 ≥10000 (模板 ≥20100 用), 官方真机抓包两系不混用
const TUMBLER_ROWS = read(path.join("Thumbler", "tumblerData.json"));
const TUMBLER_PATHS = read(path.join("Thumbler", "tumblerPathData.json"));
const TUMBLER_LOW_PARTS = TUMBLER_PATHS.filter((p) => Number(p.id) < 10000).map((p) => Number(p.id));
const TUMBLER_HIGH_PARTS = TUMBLER_PATHS.filter((p) => Number(p.id) >= 10000).map((p) => Number(p.id));

// pocketData: 7 款挂兜 {id: {desc,full_pic,have_pic,none_pic,name,res}};
// 22001 小挂兜 = 初始款 (官方抓包 list 含之), benchData type4 内 5 款可制作
const POCKET_TABLE = read(path.join("Pocket", "pocketData.json"));
const POCKET_DEFAULT_ID = 22001;
const POCKET_CRAFTABLE = read(path.join("Furnitur", "benchData.json"))
  .filter((r) => Number(r.type) === 4).map((r) => Number(r.id));

// 制作触发物 (Item.json type11 特殊物品, 官方物品描述即暗示用途):
//   11101 手工合页 "转动一下 便是一片新的天地" → 不倒翁 (配图纸 10401)
//   11102 彩色编绳 "把忙碌的日子 编进一个挂兜里" → 挂兜 (配图纸 10601)
// 客户端工作台物品位 UI 只列 type11 (FurnitureBenchView.itemsGetter),
// type13 图纸永远放不上去 → 图纸只作"永久配方"存 house, 特殊物品上台触发
const TUMBLER_TRIGGER_ID = 11101;
const POCKET_TRIGGER_ID = 11102;
const TUMBLER_BLUEPRINT_ID = 10401; // 不倒翁图鉴 (type13)
const POCKET_BLUEPRINT_ID = 10601;   // 挂兜手工制作 (type13)

// 【自设计】特殊制作配方 (原版服务端不可考): 小件手工艺, 材料轻量
const TUMBLER_MATERIALS = [{ item_id: 10001, count: 2 }, { item_id: 10005, count: 1 }]; // 松木x2+粗布x1
const POCKET_MATERIALS = [{ item_id: 10005, count: 2 }];                                // 粗布x2

// 【自设计】挂兜攒钱节奏 (原版不可考): 展示中每 30min +2, 上限 99
const POCKET_SEC = Math.max(30, Number(process.env.FROG_POCKET_SEC || 1800));
const POCKET_GAIN = Math.max(1, Number(process.env.FROG_POCKET_GAIN || 2));
const POCKET_MAX = 99;

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const nowSec = () => Math.floor(Date.now() / 1000);

/** 存档 furniture 节点兜底 (newSave 已有, 防外部构造的裸档) */
function node(s) {
  const f = s.furniture || (s.furniture = {});
  if (!Array.isArray(f.bench) || f.bench.length !== 10) f.bench = EMPTY_BENCH();
  if (typeof f.benchLock !== "number") f.benchLock = 0;
  if (!f.craft) f.craft = null;
  if (!Array.isArray(f.owned)) f.owned = [];
  if (!Array.isArray(f.placed)) f.placed = [];
  // 默认床铺 (素 1009): 官方新档自带初始家具; 客户端 sleep_2/3/4 吊床睡姿按
  // getHomeFurniture(type9) 渲染"蛙+床"合成, placed 缺床则蛙整夜不可见
  if (!f.placed.some((p) => p.type === 9)) f.placed.push({ type: 9, id: 1009 });
  if (!Array.isArray(f.replaceFur)) f.replaceFur = [];
  if (!f.compost) f.compost = {};
  if (!Array.isArray(f.compost.boxes) || f.compost.boxes.length !== 6) {
    f.compost.boxes = [0, 0, 0, 0, 0, 0];
  }
  if (!Array.isArray(f.compost.list)) {
    // 无外观列表 (新档/旧档升级): 补送初始堆肥箱; 未主动隐藏过则默认展示
    f.compost.list = [COMPOST_DEFAULT_ID];
    if (!f.compost.showIndex) f.compost.showIndex = 1;
  }
  // 不倒翁: 官方抓包语义 tumbler_list 每只独立 {id, layers}(允许同款多只)
  if (!f.tumbler) f.tumbler = { list: [], showIndex: 0, replaceIndex: 0 };
  if (!Array.isArray(f.tumbler.list)) f.tumbler.list = [];
  // 挂兜: 22001 初始款 (对齐堆肥箱先例: 默认拥有并展示)
  if (!f.pocket) {
    f.pocket = { list: [POCKET_DEFAULT_ID], showIndex: 1, replaceIndex: 0, clover: 0, lastGainAt: 0 };
  }
  if (!Array.isArray(f.pocket.list)) f.pocket.list = [POCKET_DEFAULT_ID];
  // 装饰插花 (decoration.js 深层字段由其 node() 兜底, 这里补外层)
  if (!f.decorate) f.decorate = { putId: 0, status: 0, putAt: 0 };
  return f;
}

// ---- house 库存 (与 handlers.js 同语义) ----
function addItem(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += count;
  else s.items.house.push({ item_id: itemId, count });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
}
const haveItem = (s, itemId) => {
  const row = s.items.house.find((x) => x.item_id === itemId);
  return row ? row.count : 0;
};

// ---- 制作判定 ----

/** 【自设计】某件家具需要的材料 */
function craftMaterialsFor(furnitureId) {
  const def = FURNITURE_BY_ID.get(Number(furnitureId));
  if (!def) return null;
  const byStyle = CRAFT_MATERIALS_BY_STYLE[Number(def.style)];
  return (byStyle || CRAFT_DEFAULT_MATERIALS).map((m) => ({ item_id: m.item_id, count: m.count }));
}

/** 台面上那张图纸 (5-9 号物品位) -> 将要做出的家具; 没有返回 null */
function benchBlueprint(s) {
  const bench = node(s).bench;
  for (let i = 5; i < 10; i++) {
    const itemId = Number(bench[i]);
    if (!(itemId > 0)) continue;
    const it = ITEM_BY_ID.get(itemId);
    if (!it || Number(it.type) !== ITEM_TYPE_DRAWING) continue;
    if (!BLUEPRINT_TYPE.has(itemId)) continue;          // 不认识的图纸
    const target = CRAFTABLE_BY_TYPE.get(BLUEPRINT_TYPE.get(itemId));
    if (!target) continue;                              // 该 type 无可做家具
    return { slot: i, itemId, furnitureId: target.furnitureId, type: BLUEPRINT_TYPE.get(itemId) };
  }
  return null;
}

/** 台面上的特殊制作触发物 (11101 合页/11102 编绳, 5-9 号物品位) */
function benchSpecial(s) {
  const bench = node(s).bench;
  for (let i = 5; i < 10; i++) {
    const itemId = Number(bench[i]);
    if (!(itemId > 0)) continue;
    if (itemId === TUMBLER_TRIGGER_ID && haveItem(s, TUMBLER_BLUEPRINT_ID) > 0) {
      return { slot: i, itemId, kind: "tumbler" };
    }
    if (itemId === POCKET_TRIGGER_ID && haveItem(s, POCKET_BLUEPRINT_ID) > 0) {
      return { slot: i, itemId, kind: "pocket" };
    }
  }
  return null;
}

/** 材料清单平铺 (客户端 count = 拥有 - required; 制作中用 craft.materials) */
function craftMateList(s) {
  const f = node(s);
  const flat = (mats) => {
    const out = [];
    for (const m of mats) for (let i = 0; i < m.count; i++) out.push(m.item_id);
    return out;
  };
  if (f.craft && Array.isArray(f.craft.materials)) return flat(f.craft.materials);
  const bp = benchBlueprint(s);
  if (!bp) return [];
  return flat(craftMaterialsFor(bp.furnitureId) || []);
}

/** 台面图纸/触发物 + 材料齐 → 开工 (扣材料, 锁台); 返回 true 表示开工 */
function maybeStartCraft(s) {
  const f = node(s);
  if (f.craft) return false;
  const now = Math.floor(Date.now() / 1000);
  const bp = benchBlueprint(s);
  if (bp) {
    const mats = craftMaterialsFor(bp.furnitureId) || [];
    if (mats.some((m) => haveItem(s, m.item_id) < m.count)) return false;
    for (const m of mats) addItem(s, m.item_id, -m.count);
    f.bench[bp.slot] = -1; // 图纸被用掉
    f.craft = { kind: "furniture", furnitureId: bp.furnitureId, drawing: bp.itemId, materials: mats, startedAt: now, finishAt: now + CRAFT_SECONDS };
    f.benchLock = 1;
    // 开工蛙上工: motion 5-9 (saw/brush/knock/knit/cut) 让庭院 player_mc 播工具动画;
    // 旅行中不开工动作 (庭院 updateFlogStatus 不检查 isHome, 出门时 departFrog 会归零)
    if (s.frog && s.frog.status === 0) s.frog.motion = 5 + Math.floor(Math.random() * 5);
    return true;
  }
  // 特殊制作 (不倒翁/挂兜): 触发物上台 + 拥有永久图纸 + 材料齐 → 开工
  // 图纸不消耗 (永久配方); 触发物被用掉; 不倒翁产物完工时随机, 挂兜开工时定
  const sp = benchSpecial(s);
  if (!sp) return false;
  const mats = sp.kind === "tumbler" ? TUMBLER_MATERIALS : POCKET_MATERIALS;
  if (mats.some((m) => haveItem(s, m.item_id) < m.count)) return false;
  let productId = 0;
  if (sp.kind === "pocket") {
    const notOwned = POCKET_CRAFTABLE.filter((pid) => f.pocket.list.indexOf(pid) === -1);
    if (!notOwned.length) return false; // 挂兜全拥有: 不再开工 (触发物留台)
    productId = notOwned[Math.floor(Math.random() * notOwned.length)];
  }
  for (const m of mats) addItem(s, m.item_id, -m.count);
  f.bench[sp.slot] = -1; // 触发物被用掉
  f.craft = {
    kind: sp.kind, furnitureId: productId,
    drawing: sp.kind === "tumbler" ? TUMBLER_BLUEPRINT_ID : POCKET_BLUEPRINT_ID,
    materials: mats, startedAt: now, finishAt: now + CRAFT_SECONDS,
  };
  f.benchLock = 1;
  if (s.frog && s.frog.status === 0) s.frog.motion = 5 + Math.floor(Math.random() * 5);
  return true;
}

/**
 * 【自设计】随机捏一只不倒翁: 模板 36 选 1 (允许同款多只, 每只独立);
 * layers 1-4 层, 每层 [partId, x, y, rotation角度, flip];
 * 部件按模板系列取池 (≤20099 低系 <10000 / ≥20100 高系 ≥10000, 官方抓包两系不混用);
 * x/y/rot 取官方观测范围, flip 20% 翻转
 */
function rollTumbler() {
  const tpl = TUMBLER_ROWS[randInt(0, TUMBLER_ROWS.length - 1)];
  const pool = Number(tpl.id) <= 20099 ? TUMBLER_LOW_PARTS : TUMBLER_HIGH_PARTS;
  const layers = [];
  const n = randInt(1, 4);
  for (let i = 0; i < n; i++) {
    layers.push({
      layer: [
        pool[randInt(0, pool.length - 1)], // partId
        randInt(-20, 12),                 // x
        randInt(-15, 23),                  // y
        randInt(-15, 15),                  // rotation (角度制)
        Math.random() < 0.2 ? 1 : 0,       // flip
      ],
    });
  }
  return { id: Number(tpl.id), layers };
}

/**
 * craftTick: 制作到点结算 (travelTick 驱动)。
 * 三类产物分流 (客户端 FurnitureFinish 事件按 evt_id 依次查
 * FurnitureDB → TumblerData → CompostData → pocketData 决定弹窗):
 *   furniture → owned 入库, evt_id=家具id (修复: 原误推常量 21, 客户端
 *              四库全查空 → "获得新家具"通知从不弹出)
 *   tumbler   → 随机捏一只追加 tumbler.list, evt_id=模板id,
 *              evt_value=[5, ...每层5值平铺] (客户端 for(t=1;t<len;t+=5) 切层)
 *   pocket    → 追加 pocket.list, evt_id=挂兜id
 * 完工统一推 furniture_load_furniture(merchant 完整版: 客户端 serverData 整对象
 * 替换, 缺 shop 字段会 TypeError) + 对应族载荷 + notify_new_event + loadRole
 */
function craftTick(s, push, now) {
  const f = node(s);
  // 台面留着图纸/触发物但材料此前不足 → 材料补齐后自动开工
  // (putinBench 只在放入瞬间判定一次, 旅行奖励入账等后到途径靠这里重试)
  if (!f.craft && !f.benchLock && maybeStartCraft(s)) {
    // 开工蛙上工 (motion 5-9): 推送让客户端实时切换工具动画
    if (push) push("client_load_role", require("./travel").rolePayload(s));
    return true;
  }
  const craft = f.craft;
  if (!craft || now < Number(craft.finishAt || 0)) return false;
  const kind = craft.kind || "furniture"; // 旧档 craft 无 kind 字段
  f.craft = null;
  f.benchLock = 0;
  require("./plans").onCraft(s, kind, craft.furnitureId, push); // 周期计划 602-630 学会制作
  let evt = null;
  const familyLoads = [];
  if (kind === "tumbler") {
    const one = rollTumbler();
    f.tumbler.list.push(one);
    familyLoads.push(["furniture_load_tumbler", tumblerPayload(s)]);
    const flat = [5];
    for (const l of one.layers) flat.push(...l.layer);
    evt = { evt_id: one.id, evt_value: flat };
  } else if (kind === "pocket") {
    const pid = Number(craft.furnitureId);
    if (f.pocket.list.indexOf(pid) === -1) f.pocket.list.push(pid);
    familyLoads.push(["furniture_load_pocket", pocketPayload(s)]);
    evt = { evt_id: pid, evt_value: [pid, craft.drawing || 0] };
  } else {
    const fid = Number(craft.furnitureId);
    if (f.owned.indexOf(fid) === -1) f.owned.push(fid);
    evt = { evt_id: fid, evt_value: [fid, craft.drawing || 0] };
  }
  // 完工蛙下工: 工具动作 (5-9) 归零, 轮换 pattern 重掷 (只在还挂着工具动作时动,
  // 蛙旅行中完工 motion 已是 0, 不误清旅行状态)
  let motionChanged = false;
  if (s.frog && s.frog.motion >= 5 && s.frog.motion <= 9) {
    s.frog.motion = 0;
    s.frog.motionPattern = null;
    s.frog.motionStep = 0;
    s.frog.motionNextAt = 0;
    motionChanged = true;
  }
  if (push) {
    push("furniture_load_furniture", require("./merchant").furniturePayload(s));
    if (kind === "furniture") {
      push("item_load_items", { house: s.items.house, bag: s.items.bag, desk: s.items.desk, bag_completed: s.items.bag_completed, bag_conflict: false, desk_conflict: false, gacha: s.items.gacha });
    }
    for (const [cmd, data] of familyLoads) push(cmd, data);
    // 客户端事件系统分支 TimerEvent.Type.FurnitureFinish=21
    push("notify_new_event", {
      event: { id: Date.now(), evt_type: 21, evt_id: evt.evt_id, evt_value: evt.evt_value, evt_string: [], evt_pic: [] },
    });
    // 下工推送 client_load_role: 蛙从工具动画切回室内动作 (motion 5-9 → 0)
    if (motionChanged) push("client_load_role", require("./travel").rolePayload(s));
  }
  return true;
}

/** 制作进行中 (travel.refreshFrogMotion 用: 制作期间轮换工具动作 5-9) */
function crafting(s) {
  return !!(s.furniture && s.furniture.craft);
}

// ---- 工作台槽位 (bench) ----

/**
 * 放入工作台 (furniture_putin_bench {pos, id}): pos 1-based (1-5 工具位 6-10 物品位)。
 * 官方语义: 制作中锁台 (code 6); 已占用槽位顶替 (旧物品回仓);
 * 图纸进台面后材料够即自动开工 (响应 crafting: 1)。
 */
function putinBench(s, pos, itemId) {
  const f = node(s);
  if (f.benchLock) return { code: 6 };
  const p = Number(pos);
  if (!(p >= 1 && p <= 10)) return { code: 1 };
  const id = Number(itemId);
  const it = ITEM_BY_ID.get(id);
  if (!it || haveItem(s, id) <= 0) return { code: 1 };
  const prev = f.bench[p - 1];
  if (prev > 0) addItem(s, prev, 1); // 顶替: 被挤下的回仓
  addItem(s, id, -1);
  f.bench[p - 1] = id;
  const started = maybeStartCraft(s); // 图纸 + 材料齐 → 自动开工
  return started ? { code: 0, crafting: 1 } : { code: 0 };
}

/** 取出工作台 (furniture_takeout_bench {pos}): 槽位物品回仓; 制作中锁台 */
function takeoutBench(s, pos) {
  const f = node(s);
  if (f.benchLock) return { code: 6 };
  const p = Number(pos);
  if (!(p >= 1 && p <= 10)) return { code: 1 };
  const id = f.bench[p - 1];
  if (!(id > 0)) return { code: 1 };
  f.bench[p - 1] = -1;
  addItem(s, id, 1);
  return { code: 0, item_id: id };
}

// ---- 堆肥盒 (compost box) ----

/** 放入堆肥盒 (furniture_putin_box {pos, id}): pos 1-based 1-6, 空槽值 0; 顶替回仓 */
function putinBox(s, pos, itemId) {
  const f = node(s);
  const p = Number(pos);
  if (!(p >= 1 && p <= 6)) return { code: 1 };
  const id = Number(itemId);
  if (!ITEM_BY_ID.has(id) || haveItem(s, id) <= 0) return { code: 1 };
  const prev = f.compost.boxes[p - 1];
  if (prev > 0) addItem(s, prev, 1);
  addItem(s, id, -1);
  f.compost.boxes[p - 1] = id;
  return { code: 0 };
}

/** 取出堆肥盒 (furniture_takeout_box {pos}) */
function takeoutBox(s, pos) {
  const f = node(s);
  const p = Number(pos);
  if (!(p >= 1 && p <= 6)) return { code: 1 };
  const id = f.compost.boxes[p - 1];
  if (!(id > 0)) return { code: 1 };
  f.compost.boxes[p - 1] = 0;
  addItem(s, id, 1);
  return { code: 0, item_id: id };
}

/**
 * 切换/隐藏堆肥箱 (furniture_replace_compost {index}, 1-based)。
 * 客户端契约 (offline-engine 同款, tumbler/compost/pocket 共用):
 *   index = 列表序号, 与当前展示相同 → 隐藏 (code 1); 否则展示该款 (code 0)。
 * 客户端用响应码自行维护 show_index/replace_index 并派发 UPDATE_COMPOST。
 */
function replaceCompost(s, index) {
  const f = node(s);
  const wire = Number(index);
  if (!Number.isInteger(wire) || wire < 1) return { code: -1 };
  if (wire > f.compost.list.length) return { code: -1 };
  if (f.compost.showIndex === wire) {
    f.compost.showIndex = 0;
    f.compost.replaceIndex = 0;
    return { code: 1 };
  }
  f.compost.showIndex = wire;
  f.compost.replaceIndex = wire;
  return { code: 0 };
}

// ---- 不倒翁 (tumbler) ----

/**
 * 切换/隐藏不倒翁 (furniture_replace_tumbler {index}, 1-based)。
 * 与 compost/pocket 共用语义: index = 列表序号, 与当前展示相同 → 隐藏
 * (code 1); 否则展示该款 (code 0)。客户端按响应码自维护 show/replace_index。
 */
function replaceTumbler(s, index) {
  const f = node(s);
  const wire = Number(index);
  if (!Number.isInteger(wire) || wire < 1) return { code: -1 };
  if (wire > f.tumbler.list.length) return { code: -1 };
  if (f.tumbler.showIndex === wire) {
    f.tumbler.showIndex = 0;
    f.tumbler.replaceIndex = 0;
    return { code: 1 };
  }
  f.tumbler.showIndex = wire;
  f.tumbler.replaceIndex = wire;
  return { code: 0 };
}

/** furniture_load_tumbler 载荷 (客户端 tumblerData 整对象替换) */
function tumblerPayload(s) {
  const f = node(s);
  return {
    show_index: f.tumbler.showIndex,
    replace_index: f.tumbler.replaceIndex,
    tumbler_list: f.tumbler.list.slice(),
  };
}

// ---- 挂兜 (pocket) ----

/** 切换/隐藏挂兜 (furniture_replace_pocket {index}, 1-based; 语义同 tumbler) */
function replacePocket(s, index) {
  const f = node(s);
  const wire = Number(index);
  if (!Number.isInteger(wire) || wire < 1) return { code: -1 };
  if (wire > f.pocket.list.length) return { code: -1 };
  if (f.pocket.showIndex === wire) {
    f.pocket.showIndex = 0;
    f.pocket.replaceIndex = 0;
    return { code: 1 };
  }
  f.pocket.showIndex = wire;
  f.pocket.replaceIndex = wire;
  return { code: 0 };
}

/**
 * 挂兜攒钱 (travelTick 驱动): 展示中每 POCKET_SEC +POCKET_GAIN, 上限 99。
 * 返回 true 表示状态变化 (调用方推 furniture_load_pocket 刷新红点)。
 * 红点逻辑 (客户端 updatePocketRedot): clover ≥ pocketCommonData.base_info(50)
 * 才亮 FURNITURE_POCKET 红点; ≥1 显示 have_pic, 0 显示 none_pic。
 */
function pocketTick(s, now) {
  const f = node(s);
  const p = f.pocket;
  if (!p.showIndex || p.showIndex > p.list.length) return false;
  if (p.clover >= POCKET_MAX) return false;
  if (!p.lastGainAt) { p.lastGainAt = now; return false; }
  const elapsed = now - p.lastGainAt;
  if (elapsed < POCKET_SEC) return false;
  const cycles = Math.floor(elapsed / POCKET_SEC);
  p.lastGainAt += cycles * POCKET_SEC;
  p.clover = Math.min(POCKET_MAX, p.clover + cycles * POCKET_GAIN);
  return true;
}

/**
 * 领取挂兜三叶草 (furniture_pocket_get 无参):
 * 客户端成功后本地 clover=0 (入账全靠服务器推送) → handler 需推
 * clover_update + furniture_load_pocket
 * @returns {{code:number, clover:number}} code 0=领取成功, clover=入账数
 */
function pocketGet(s) {
  const f = node(s);
  const p = f.pocket;
  if (!(p.clover > 0)) return { code: 1, clover: 0 };
  const gain = p.clover;
  p.clover = 0;
  s.res.clover_point += gain;
  require("./cooking").event(s, "cloverGain", { delta: gain }); // 月度烹饪 4 (挂兜无 push 上下文, 登录全量同步补)
  return { code: 0, clover: gain };
}

/** furniture_load_pocket 载荷 (客户端 pocketData 整对象替换) */
function pocketPayload(s) {
  const f = node(s);
  return {
    list: f.pocket.list.slice(),
    show_index: f.pocket.showIndex,
    clover: f.pocket.clover,
    replace_index: f.pocket.replaceIndex,
  };
}

// ---- 家具摆放 ----

/**
 * 摆放/撤下家具 (furniture_replace_fur {id: 家具id}):
 * 同 type 原来就摆着这件 → 撤下 (code 1); 否则摆上 (code 0, 顶替同 type 旧家具)。
 */
function replaceFur(s, furId) {
  const f = node(s);
  const id = Number(furId);
  const def = FURNITURE_BY_ID.get(id);
  if (!def) return { code: -1 };
  if (f.owned.indexOf(id) === -1) return { code: 2 }; // 未拥有的家具不可摆
  const type = Number(def.type);
  const showing = f.placed.find((p) => p.type === type);
  f.placed = f.placed.filter((p) => p.type !== type);
  if (showing && showing.id === id) {
    f.replaceFur = f.replaceFur.filter((t) => t !== type);
    return { code: 1 }; // 该 type 撤下
  }
  f.placed.push({ type, id });
  if (f.replaceFur.indexOf(type) === -1) f.replaceFur.push(type);
  return { code: 0 }; // 摆上
}

// ---- 载荷 ----

/** furniture_load_furniture 中工坊负责的字段 (商店部分由 merchant.js 拼) */
function furniturePayload(s) {
  const f = node(s);
  return {
    bench_lock: f.benchLock ? 1 : 0,
    bench: f.bench.slice(0, 10),
    put_fur: f.placed,
    has_fur: f.owned,
    mate_list: craftMateList(s),
    replace_fur: f.replaceFur,
  };
}

/**
 * 堆肥肥力等级 (客户端 update_compost 土地贴图依据):
 * 非零格 0 → 1 贫瘠 (td_pj) / 1-2 格 → 2 正常 (td_zc) / 3+ 格 → 3 肥沃 (td_fw)
 */
function compostState(s) {
  const boxes = node(s).compost.boxes;
  let filled = 0;
  for (const v of boxes) if (v > 0) filled++;
  return filled >= 3 ? 3 : filled === 0 ? 1 : 2;
}

/** furniture_load_compost 载荷 */
function compostPayload(s) {
  const f = node(s);
  return {
    show_index: f.compost.showIndex,
    replace_index: f.compost.replaceIndex,
    state: compostState(s),
    box_index: 0,
    box_list: f.compost.boxes.slice(0, 6),
    compost_list: f.compost.list.slice(),
  };
}

module.exports = {
  node, putinBench, takeoutBench, putinBox, takeoutBox, replaceCompost, replaceFur,
  maybeStartCraft, craftTick, crafting, benchBlueprint, benchSpecial, craftMaterialsFor, craftMateList,
  furniturePayload, compostPayload, compostState,
  replaceTumbler, tumblerPayload, rollTumbler,
  replacePocket, pocketTick, pocketGet, pocketPayload,
  FURNITURE_BY_ID, CRAFTABLE_BY_TYPE, BLUEPRINT_TYPE, CRAFT_SECONDS, COMPOST_DEFAULT_ID,
  POCKET_DEFAULT_ID, POCKET_CRAFTABLE,
};
