// 嘟嘟商人模块单元验证
const assert = require("assert");
const m = require("../merchant.js");

// 1. genShopList 结构 (item_id 必填 — 客户端 updateSelect/FurnitureShopItem 直接读)
const list = m.genShopList();
console.log("货架:", list.length, "件; 样例:", JSON.stringify(list.slice(0, 3)));
assert(list.length >= 12, "货架数量 (材料7+工具2+图纸1+物品2=12)");
const seen = new Set();
for (const g of list) {
  assert(Number.isInteger(g.shop_id) && g.shop_id > 0, "shop_id");
  assert(Number.isInteger(g.item_id) && g.item_id > 0, "item_id 必填 (报错根因)");
  assert(g.num > 0, "num>0");
  assert(m.SHOP.has(g.shop_id), "shop_id 在 FurnitureShopDB");
  assert(Number(m.SHOP.get(g.shop_id).item_id) === g.item_id, "item_id 与表一致");
  assert(!seen.has(g.shop_id), "不重复上架");
  seen.add(g.shop_id);
}
// 多样性: 材料槽 (shop 2001-2007) 全上 + 至少 1 工具 + 恰好 1 图纸 (单件) + 至少 1 家具物品
const materialN = list.filter((g) => g.shop_id >= 2001 && g.shop_id <= 2007).length;
const paperN = list.filter((g) => g.shop_id >= 4001 && g.shop_id <= 4027).length;
const toolN = list.filter((g) => g.shop_id >= 1001 && g.shop_id <= 1005).length;
assert(materialN === 7, "基础材料 7 种全上");
assert(toolN >= 1, "工具上架");
assert(paperN === 1, "制作教程一次只带 1 本");
for (const g of list.filter((x) => x.shop_id >= 4001 && x.shop_id <= 4027)) {
  assert(g.num === 1, "图纸单件限购 num=1");
}

// 1b. 教程收集语义: 买过不再上架; 集齐 27 种后不再上图纸
const sp = { res: { clover_point: 999999 }, merchant: {} };
sp.merchant.shop = { start_time: 1, leave_time: 2, shop_list: m.genShopList(sp) };
// 逐本买: 每次 genShopList 出 1 本未购的, 全买完需 27 轮, 之后货架不再有图纸
for (let i = 0; i < 27; i++) {
  sp.merchant.shop.shop_list = m.genShopList(sp);
  const paper = sp.merchant.shop.shop_list.find((g) => g.shop_id >= 4001 && g.shop_id <= 4027);
  if (!paper) break; // 提前集齐 (存档已有记录时不发生; 全新档 27 轮内每轮必有 1 本)
  assert(m.buyShopItem(sp, paper.shop_id).code === 0, "购教程");
}
const lastList = m.genShopList(sp);
assert(lastList.filter((g) => g.shop_id >= 4001 && g.shop_id <= 4027).length === 0,
  "27 种集齐后不再上教程");
assert(Object.keys(sp.merchant.papers).length === 27, "已购教程记录 27 条");
console.log("教程收集: 27 种全购后停上 ✓");

// 1c. 买过的教程不重复上架 (部分购买)
const sp2 = { res: { clover_point: 999999 }, merchant: {} };
for (let i = 0; i < 30; i++) {
  const l = m.genShopList(sp2);
  const paper = l.find((g) => g.shop_id >= 4001 && g.shop_id <= 4027);
  if (!paper) break;
  sp2.merchant.shop = { shop_list: l };
  m.buyShopItem(sp2, paper.shop_id);
}
const papers2 = Object.keys(sp2.merchant.papers).map(Number);
for (let i = 0; i < 10; i++) {
  const l = m.genShopList(sp2);
  for (const g of l.filter((x) => x.shop_id >= 4001 && x.shop_id <= 4027)) {
    assert(!papers2.includes(g.shop_id), "已购教程不重复上架");
  }
}
console.log("已购教程不重复上架 ✓");

// 1d. 工具收集语义: 买过的工具不再上架; 5 种集齐后不再上工具 (耐用品, 单件限购)
const sp3 = { res: { clover_point: 999999 }, merchant: {} };
let toolRounds = 0;
while (toolRounds++ < 10) {
  const l = m.genShopList(sp3);
  const tools = l.filter((g) => g.shop_id >= 1001 && g.shop_id <= 1005);
  if (!tools.length) break; // 集齐: 不再上工具
  sp3.merchant.shop = { shop_list: l };
  for (const t of tools) assert(m.buyShopItem(sp3, t.shop_id).code === 0, "购工具");
}
assert(Object.keys(sp3.merchant.tools).length === 5, "已购工具记录 5 条");
const toolList3 = m.genShopList(sp3);
assert(toolList3.filter((g) => g.shop_id >= 1001 && g.shop_id <= 1005).length === 0,
  "5 种工具集齐后不再上工具");
for (let i = 0; i < 10; i++) {
  const l = m.genShopList(sp3);
  for (const g of l.filter((x) => x.shop_id >= 1001 && x.shop_id <= 1005)) {
    assert(false, "已购工具不应上架 " + g.shop_id);
  }
}
console.log("工具收集: 5 种全购后停上 ✓");

// 1e. 老档回填: 无 m.tools 记录, 从工作台槽位/仓库扫描实际持有补记
const sp5 = {
  res: { clover_point: 999999 },
  merchant: {},
  furniture: { bench: [10211, -1, -1, -1, -1, -1, -1, -1, -1, -1] }, // 锯子在工具位
  items: { house: [{ item_id: 10213, count: 1 }] },                  // 锤子在仓库
};
const ownedToolShopIds = [...m.SHOP.values()]
  .filter((r) => Number(r.type) === 1 && [10211, 10213].includes(Number(r.item_id)))
  .map((r) => Number(r.id));
assert(ownedToolShopIds.length === 2, "定位锯子/锤子货架位");
for (let i = 0; i < 10; i++) {
  const l = m.genShopList(sp5);
  for (const g of l) {
    assert(!ownedToolShopIds.includes(g.shop_id), `老档已购工具不上架 (${g.shop_id})`);
  }
}
assert(ownedToolShopIds.every((id) => sp5.merchant.tools[id] === 1), "回填 m.tools 记录");
console.log("老档工具回填 (在台/在仓都算已购) ✓");

// 2. tick: 到访 → payload (bench 10 槽全 -1)
const s = { res: { clover_point: 10000 }, merchant: {} };
const now = Math.floor(Date.now() / 1000);
s.merchant.shop = { start_time: now - 10, leave_time: now + 7000, shop_list: m.genShopList(s) };
const pay = m.furniturePayload(s);
console.log("到访 payload.shop: start=" + pay.shop.start_time, "leave=" + pay.shop.leave_time, "件:", pay.shop.shop_list.length);
assert(pay.shop.start_time < now && now < pay.shop.leave_time, "isOpenShop 窗口");
assert(Array.isArray(pay.bench) && pay.bench.length === 10, "bench 10 槽");
assert(pay.bench.every((x) => x === -1), "初始 bench 全空槽");

// 3. 离场 payload (lastVisit 保留 → isOpen, bench 保留; bench 已迁 s.furniture)
s.furniture = { bench: [-1, 10213, -1, -1, -1, -1, -1, -1, -1, -1] };
s.merchant.shop.leave_time = now - 1;
m.merchantTick(s, null, now);
const pay2 = m.furniturePayload(s);
assert(pay2.shop.shop_list.length === 0 && pay2.shop.start_time > 0, "离场后 isOpen 但不可购");
assert(pay2.bench[1] === 10213, "离场后 bench 状态保留");
console.log("离场 payload: start_time=", pay2.shop.start_time, "leave_time=", pay2.shop.leave_time);

// 4. 购买 (item_id 回传)
s.merchant.shop = { start_time: now - 10, leave_time: now + 7000, shop_list: m.genShopList(s) };
const entry = s.merchant.shop.shop_list[0];
const row = m.SHOP.get(entry.shop_id);
const before = entry.num;
const cloverBefore = s.res.clover_point;
const r = m.buyShopItem(s, entry.shop_id);
console.log("购买:", JSON.stringify(r), "| 价格:", row.price, "| 物品:", row.item_id);
assert(r.code === 0, "购买成功");
assert(r.item_id === Number(row.item_id), "回传 item_id");
assert(entry.num === before - 1, "num--");
assert(s.res.clover_point === cloverBefore - row.price, "扣款");

// 5. 售罄
entry.num = 0;
assert(m.buyShopItem(s, entry.shop_id).code === 2, "售罄 code=2");
// 6. 余额不足
const entry2 = s.merchant.shop.shop_list.find((g) => g.num > 0);
s.res.clover_point = 0;
assert(m.buyShopItem(s, entry2.shop_id).code === 3, "余额 code=3");
// 7. 不在货架
assert(m.buyShopItem(s, 999999).code === 1, "无货架 code=1");
// 8. 嘟嘟不在
s.merchant.shop = null;
assert(m.buyShopItem(s, entry2.shop_id).code === 4, "离开 code=4");

// 9. 工作台 putin / takeout (官方顶替语义: 占用槽旧物品回仓)
const s3 = { res: { clover_point: 100 }, merchant: {}, items: { house: [
  { item_id: 10213, count: 2 }, // 锤子 ×2
  { item_id: 10212, count: 1 }, // 毛刷 ×1
  { item_id: 10101, count: 1 }, // 松木 ×1
] } };
let pr = m.putinBench(s3, 1, 10213); // 工具槽 1 放锤子
assert(pr.code === 0, "putin 工具槽");
assert(m.furniturePayload(s3).bench[0] === 10213, "bench[0] 已记录");
pr = m.putinBench(s3, 1, 10212); // 占用槽再放 → 顶替 (旧物品回仓, 官方语义)
assert(pr.code === 0, "占用槽顶替 code=0");
assert(m.furniturePayload(s3).bench[0] === 10212, "bench[0] 已换新");
assert((s3.items.house.find((x) => x.item_id === 10213) || {}).count === 2, "顶替: 旧锤子回仓 (2)");
pr = m.putinBench(s3, 6, 10101); // 物品槽 6
assert(pr.code === 0, "putin 物品槽");
pr = m.putinBench(s3, 11, 10213); // 越界
assert(pr.code === 1, "pos 越界拒绝");
pr = m.putinBench(s3, 3, -1); // 非法 id
assert(pr.code === 1, "非法 id 拒绝");
pr = m.putinBench(s3, 1, 99999); // 无库存
assert(pr.code === 1, "无库存拒绝");
let tr = m.takeoutBench(s3, 1);
assert(tr.code === 0 && tr.item_id === 10212, "takeout 返回物品");
assert(m.furniturePayload(s3).bench[0] === -1, "取后槽空");
tr = m.takeoutBench(s3, 1); // 空槽再取 → 拒绝
assert(tr.code === 1, "空槽 takeout 拒绝");
console.log("bench: putin/takeout 通过");

console.log("\n全部通过 ✓");
