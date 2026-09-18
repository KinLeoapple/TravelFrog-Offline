/**
 * 旅行商人嘟嘟 (家具商店引擎)
 *
 * 官方语义 (main.min.js 逆向 + 官方任务/百科文案):
 *   - 嘟嘟是限时到访的家具商人 ("行程不定的旅行商人, 晚饭的时候一般都回来了")
 *   - 客户端 FurnitureModel.serverData.shop:
 *       isOpen()     = start_time > 0          → 曾到访 (家具工作台 imgFurnitureBench 出现)
 *       isOpenShop() = start < now < leave     → 嘟嘟在场 (drummer 骨骼立绘 shop_mc 显示)
 *   - shop_list: [{shop_id, item_id, num}] — shop_id 对客户端 FurnitureShopDB (furnitureShopData.json),
 *     item_id 必填 (客户端 updateSelect/FurnitureShopItem 直接读 shop_list 元素的 item_id,
 *     缺失会 Cannot read properties of undefined (reading 'info')),
 *     num = 剩余可购数; 客户端 furniture_buy_shop {shop_id} 成功后本地 num--
 *   - bench = 工作台 10 槽: [0..4]=工具 (FURNITURE_TOOL), [5..9]=物品 (FURNITURE_ITEM),
 *     -1 = 空槽; 客户端 getBenchTools()=bench.slice(0,5), getBenchItems()=bench.slice(5)
 *   - furniture_putin_bench {pos,id} / furniture_takeout_bench {pos}: pos 为 1-based
 *   - mood != very_angry 时工作台正常, 罢工贴图仅极端饥饿
 *   - 商品类型 (ItemType): 5=Gift 礼包(客户端 addHouseItem 入屋), 13=FURNITURE_PAPER
 *     图纸(客户端仅弹提示, 服务器须入包+推送), 其余按 house 处理
 *
 * 节奏 (官方"概率刷新"不可考, 取自定): 每 2h roll 20%, 停留 2h, 冷却 4h
 *   env: FROG_MERCHANT_ROLL / FROG_MERCHANT_CHANCE / FROG_MERCHANT_STAY / FROG_MERCHANT_COOL
 */
const fs = require("fs");
const path = require("path");
const furni = require("./furni");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");

// 商店表: id(=shop_id) → {item_id, price, limit, shop_limit, order, type, icon, sign}
// 表内 type 为货架分类: 1=工具 2=基础材料(松木/楠竹/砂石/灯芯草/粗布/毛边纸/铜块)
//   3=家具物品 4=家具图纸(500/单件) 6=庭院装饰 998=分享商品(离线不上架)
//   price/order/sign(角标)/shop_limit 均为官方真值, 客户端按本地同表渲染
const SHOP_RAW = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "Furnitur", "furnitureShopData.json"), "utf-8"));
const SHOP = new Map(Object.values(SHOP_RAW).map((r) => [Number(r.id), r]));

// 商品池 (按 shop.type 分类)
const byShopType = (t) => [...SHOP.values()].filter((r) => Number(r.type) === t);
const POOL_TOOL = byShopType(1);     // 实用工具 5 种 (锯子/毛刷/锤子/棒针/小刀, 750)
const POOL_MATERIAL = byShopType(2); // 基础材料 7 种 (10001-10007, 20) — 工作台材料槽刚需
const POOL_PART = byShopType(3);      // 家具物品 11 种 (200)
const POOL_PAPER = byShopType(4);    // 家具图纸 27 种 (500, limit=1 单件限购)
const TOOL_ITEM_IDS = new Set(POOL_TOOL.map((r) => Number(r.item_id))); // 工具物品 id 集

const env = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);
const PACE = {
  ROLL_SEC: env("FROG_MERCHANT_ROLL", 7200),
  CHANCE: env("FROG_MERCHANT_CHANCE", 20),
  STAY_SEC: env("FROG_MERCHANT_STAY", 7200),
  COOL_SEC: env("FROG_MERCHANT_COOL", 14400),
};
const GOODS_COUNT = 16;

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
/** 不重复随机抽样 */
function sample(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(randInt(0, pool.length - 1), 1)[0]);
  return out;
}

/** 槽位库存: shop_limit>0 → "仅N个"角标库存; limit=1 (图纸) → 单件; 其余按参数 */
const stockOf = (r, def) => (Number(r.shop_limit) > 0 ? Number(r.shop_limit) : Number(r.limit) > 0 ? Number(r.limit) : def);

/**
 * 生成一次到访的货架 (多样化: 材料+工具+图纸+家具物品, 每次随机组合)
 *   - 基础材料 7 种全上 (工作台制作刚需, 消耗品备 10)
 *   - 工具随机 2 种 (耐用品, 单件; 买过的不再上架 — 5 种集齐后不上工具)
 *   - 制作教程 (图纸) 一次只带 1 本: 收集品语义, 只从没买过的里挑,
 *     买过的不重复上架; 27 种集齐后不再上图纸 (m.papers 记录已购)
 *   - 家具物品随机 2 种 (装饰品)
 */
function genShopList(s) {
  syncBoughtTools(s); // 工具收集语义: 从工作台/仓库回填已购 (兼容老档)
  const m = (s && s.merchant) || {};
  const goods = [];
  const push = (r, num) => goods.push({ shop_id: Number(r.id), item_id: Number(r.item_id), num });
  for (const r of POOL_MATERIAL) push(r, 10);
  for (const r of sample(unboughtTools(m), 2)) push(r, stockOf(r, 1));
  for (const r of sample(unboughtPapers(m), 1)) push(r, stockOf(r, 1));
  for (const r of sample(POOL_PART, 2)) push(r, stockOf(r, 2));
  return goods.slice(0, GOODS_COUNT);
}

/** 未购买过的图纸 (m.papers = {shop_id: 1} 已购集合; 集齐返回空) */
function unboughtPapers(m) {
  return POOL_PAPER.filter((r) => !m.papers || !m.papers[Number(r.id)]);
}

/** 未购买过的工具 (m.tools = {shop_id: 1} 已购集合; 集齐返回空) */
function unboughtTools(m) {
  return POOL_TOOL.filter((r) => !m.tools || !m.tools[Number(r.id)]);
}

/**
 * 已购工具回填: 工具是耐用品 (制作只耗材料不耗工具), 买过就永久下架;
 * 老档没有 m.tools 记录 → 从工作台槽位/仓库实际持有扫描补记
 */
function syncBoughtTools(s) {
  if (!s) return;
  const m = s.merchant || (s.merchant = {});
  const bought = m.tools || (m.tools = {});
  const owned = new Set();
  const bench = (s.furniture && s.furniture.bench) || [];
  for (const id of bench) {
    if (TOOL_ITEM_IDS.has(Number(id))) owned.add(Number(id));
  }
  for (const row of (s.items && s.items.house) || []) {
    if (row && TOOL_ITEM_IDS.has(Number(row.item_id)) && row.count > 0) owned.add(Number(row.item_id));
  }
  for (const r of POOL_TOOL) {
    if (owned.has(Number(r.item_id))) bought[Number(r.id)] = 1;
  }
}

/** merchantTick: 离场/冷却后 roll 到访 + 工作台制作结算 (travelTick 驱动, 30s 粒度) */
function merchantTick(s, push, now) {
  const m = s.merchant || (s.merchant = {});
  let changed = false;
  // 工作台制作到点结算 (furniture_finish 事件 + 家具入库)
  if (furni.craftTick(s, push, now)) changed = true;
  if (m.shop) {
    if (now >= m.shop.leave_time) {
      m.lastVisit = m.shop.start_time; // isOpen() 曾到访标记 (start_time>0 即工作台常驻)
      m.shop = null;
      m.coolUntil = now + PACE.COOL_SEC;
      m.nextRollAt = 0;
      changed = true;
      if (push) push("furniture_load_furniture", furniturePayload(s));
    }
  } else if (!m.nextRollAt) {
    m.nextRollAt = now + PACE.ROLL_SEC;
    changed = true;
  } else if (now >= m.nextRollAt) {
    m.nextRollAt = now + PACE.ROLL_SEC;
    if (now >= (m.coolUntil || 0) && Math.random() * 100 < PACE.CHANCE) {
      m.shop = { start_time: now, leave_time: now + PACE.STAY_SEC, shop_list: genShopList(s) };
      changed = true;
      if (push) push("furniture_load_furniture", furniturePayload(s));
    }
  }
  return changed;
}

/** furniture_load_furniture 载荷 (FurnitureModel.serverData 全字段):
 *  商店部分本模块, 工坊部分 (bench/put_fur/has_fur/mate_list/bench_lock) 由 furni.js 拼 */
function furniturePayload(s) {
  const m = s.merchant || {};
  const shop = m.shop
    ? { shop_list: m.shop.shop_list, start_time: m.shop.start_time, leave_time: m.shop.leave_time }
    : { shop_list: [], start_time: m.lastVisit || 0, leave_time: 0 };
  return Object.assign({ shop, mood: 0 }, furni.furniturePayload(s));
}

// 工作台槽位操作已迁至 furni.js (含库存扣减/顶替回仓/自动开工), 此处转发保持导出兼容
const putinBench = (s, pos, itemId) => furni.putinBench(s, pos, itemId);
const takeoutBench = (s, pos) => furni.takeoutBench(s, pos);

/**
 * 购买 (furniture_buy_shop {shop_id}):
 *   校验货架 → 扣三叶草 → num-- → 图纸/礼包入屋 → 回显权威 shop (客户端已本地 num--)
 *   教程 (图纸 type=4) 为收集品: 成功购买记入 m.papers, 之后不再上架
 * @returns {{code:number, item_id?:number}} code 0=成功 1=货架不存在 2=已售罄 3=余额不足 4=嘟嘟已离开
 */
function buyShopItem(s, shopId) {
  const m = s.merchant || {};
  if (!m.shop) return { code: 4 };
  const entry = m.shop.shop_list.find((g) => g.shop_id === shopId);
  if (!entry) return { code: 1 };
  if (!(entry.num > 0)) return { code: 2 };
  const row = SHOP.get(Number(shopId));
  if (!row) return { code: 1 };
  const price = Number(row.price) || 0;
  if (s.res.clover_point < price) return { code: 3 };
  s.res.clover_point -= price;
  entry.num -= 1;
  if (Number(row.type) === 4) {
    (m.papers || (m.papers = {}))[Number(shopId)] = 1; // 已购教程: 不再重复上架
  } else if (Number(row.type) === 1) {
    (m.tools || (m.tools = {}))[Number(shopId)] = 1;  // 已购工具: 耐用品不再重复上架
  }
  return { code: 0, item_id: Number(row.item_id) };
}

module.exports = {
  merchantTick, furniturePayload, buyShopItem, genShopList,
  putinBench, takeoutBench,
  PACE, SHOP,
};
