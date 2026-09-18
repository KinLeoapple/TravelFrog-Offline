/**
 * 图鉴测试: 食物/花解锁 + 描述段渐进 + 展示变体 (引擎单测)
 * 用法: node server/tests/test_ency.js
 */
const path = require("path");
const ency = require(path.join(__dirname, "..", "ency.js"));
const saveMod = require(path.join(__dirname, "..", "save.js"));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  [ok]", msg); }
  else { fail++; console.log("  [FAIL]", msg); }
};

console.log("[A] 配置映射");
{
  ok(ency.FOOD_ROW.size === 159, "食物行 159: " + ency.FOOD_ROW.size);
  const waffle = ency.FOOD_ROW.get(0);
  ok(waffle && waffle.long_id === 10010001 && waffle.name === "华夫饼", "item 0 → 华夫饼 10010001");
  ok(ency.PLANT_ROW.size > 0, "植物映射行: " + ency.PLANT_ROW.size);
  const jiaojin = ency.PLANT_ROW.get(2010101);
  ok(jiaojin && jiaojin.long_id === 1010101 && jiaojin.name === "角堇", "植物 2010101 → 角堇 1010101");
}

console.log("[B] 食物解锁 + 描述段");
{
  const s = saveMod.newSave("ency_unit_" + Date.now());
  let p = ency.payload(s);
  ok(p.unlock_list.length === 0, "初始空图鉴 (isOpen=false)");
  ency.onEatFood(s, 0);
  p = ency.payload(s);
  ok(p.unlock_list.includes(10010001), "携带华夫饼解锁条目");
  const d = p.unlock_desc.find((x) => x.id === 1001);
  ok(d && d.list.length === 1 && d.list[0] === 1, "1 次 → 第 1 段");
  ency.onEatFood(s, 0);
  ency.onEatFood(s, 0);
  p = ency.payload(s);
  const d2 = p.unlock_desc.find((x) => x.id === 1001);
  ok(d2 && d2.list.length >= 2, "3 次 → 前 2 段 (" + d2.list.join(",") + ")");
  // 非图鉴物品 (木片) 不解锁
  ency.onEatFood(s, 8501);
  ok(!p.unlock_list.some((x) => x > 30000000 || ency.FOOD_ROW.get(8501)), "非食物物品不入图鉴");
}

console.log("[C] 花解锁");
{
  const s = saveMod.newSave("ency_flower_" + Date.now());
  ency.onPlantHarvest(s, 2010101);
  ency.onPlantHarvest(s, 2010101); // 同变体二次收获 → 物种计数 2
  let p = ency.payload(s);
  ok(p.unlock_list.includes(1010101), "收获角堇·火龙果解锁条目");
  const d = p.unlock_desc.find((x) => x.id === 101);
  ok(d && d.list.length >= 2, "2 次收获 → 前 2 段");
  ency.onPlantHarvest(s, 2010102); // 同物种另一变体 (角堇·柠檬黄唇 → ency 1010201)
  ency.onPlantHarvest(s, 2010103); // 角堇·彩蝶 → 计数 4
  p = ency.payload(s);
  ok(p.unlock_list.includes(1010201), "另一变体独立解锁");
  const d2 = p.unlock_desc.find((x) => x.id === 101);
  ok(d2.list.length >= 3, "物种计数累计 4 → 前 3 段 (" + d2.list.join(",") + ")");
  // 无图鉴条目的植物 (葡风) 不解锁
  ok(ency.onPlantHarvest(s, 2010201) === false, "葡风 (无图鉴条目) 返回 false");
}

console.log("[D] 展示变体");
{
  const s = saveMod.newSave("ency_show_" + Date.now());
  ok(ency.setShowSub(s, 1010201) === true, "设置展示变体 1010201");
  ok(ency.setShowSub(s, 99999999) === false, "非法 long_id 被拒");
  const p = ency.payload(s);
  const row = p.show_sub.find((x) => x.id === 101);
  ok(row && row.sub_id === 1010201, "载荷 {id:101, sub_id:1010201} (sub_id 承载 long_id)");
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
