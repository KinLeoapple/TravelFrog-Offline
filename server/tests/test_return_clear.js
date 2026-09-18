/**
 * 回家清包 + 桌上自行装包 验证:
 *   A. 桌上无物品 → 回家后背包清空 (包内耐用品入仓库)
 *   B. 桌上有物品 → 回家后背包从桌上自行装包 (便当/护符/道具各取一)
 *   C. 桌上只有护符 → 回家后包内护符槽有物, 其余空
 * 进程内, 无需服务器
 * 运行: node test_return_clear.js
 */
process.env.FROG_TRAVEL_MIN_SEC = "1";
process.env.FROG_TRAVEL_MAX_SEC = "2";
process.env.FROG_IDLE_MIN_SEC = "1";
process.env.FROG_IDLE_MAX_SEC = "2";

const saveMod = require("../save");
const travel = require("../travel");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

const ITEM_TYPE = travel.ITEM_TYPE;
// 找各类代表物品 (gm.js bagKit 同源)
const path = require("path");
const fs = require("fs");
const CFG = path.join(__dirname, "..", "..", "resource", "China", "config", "MainData");
const items = (() => {
  const t = JSON.parse(fs.readFileSync(path.join(CFG, "Item.json"), "utf-8"));
  return Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]);
})();
const LUNCH = items.find((i) => i.type === 0);
const AMULET_DURABLE = items.find((i) => i.type === 1 && Number(i.spend) !== 1);
const TOOL = items.find((i) => i.type === 2);

// --- A. 桌上无物品: 回家后背包清空 ---
(() => {
  const s = saveMod.newSave("rc_a");
  // 装满背包: 便当+护符+道具×2, 桌上空
  s.items.bag = [LUNCH.id, AMULET_DURABLE.id, TOOL.id, TOOL.id];
  s.items.desk = [-1, -1, -1, -1, -1, -1, -1, -1];

  travel.departFrog(s, null, Math.floor(Date.now() / 1000));
  check("A 出发: 包已清 (便当消耗+耐用品转 carried)", s.items.bag.every((v) => v === -1),
    JSON.stringify(s.items.bag));

  travel.returnFrog(s, null, Math.floor(Date.now() / 1000));
  check("A 回家: 背包清空 (桌上无物)", s.items.bag.every((v) => v === -1),
    JSON.stringify(s.items.bag));
  check("A 回家: 耐用品入仓库 (护符)", s.items.house.some((h) => h.item_id === AMULET_DURABLE.id && h.count > 0));
  check("A 回家: 耐用品入仓库 (道具)", s.items.house.some((h) => h.item_id === TOOL.id && h.count > 0));
  check("A 回家: bag_completed=false", s.items.bag_completed === false);
})();

// --- B. 桌上有物品: 回家后从桌上自行装包 ---
(() => {
  const s = saveMod.newSave("rc_b");
  // 装满背包, 桌上也放好: 便当×2 + 护符×2 + 道具×4
  s.items.bag = [LUNCH.id, AMULET_DURABLE.id, TOOL.id, TOOL.id];
  s.items.desk = [LUNCH.id, LUNCH.id, AMULET_DURABLE.id, AMULET_DURABLE.id, TOOL.id, TOOL.id, TOOL.id, TOOL.id];

  travel.departFrog(s, null, Math.floor(Date.now() / 1000));
  // provisionTrip: 便当消耗(bag[0]), 包内护符/道具转 carried, 桌上补齐已满不拿
  // 桌上仍剩: 便当×2 + 护符×2 + 道具×4 (减去被消耗的便当? 不会, 便当来自 bag[0])
  // 实际: bag[0] 便当消耗, bag[1-3] 转 carried, 桌上有 2 便当+2 护符+4 道具

  travel.returnFrog(s, null, Math.floor(Date.now() / 1000));
  // returnGear: 包内耐用品(护符/道具) 入仓库; 桌上物品不动 (这次没从桌上拿)
  // autoPackFromDesk: 从桌上取 便当→bag[0], 护符→bag[1], 道具→bag[2], 道具→bag[3]
  check("B 回家: bag[0]=便当 (桌上自装)", travel.isType(s.items.bag[0], ITEM_TYPE.LUNCHBOX),
    `bag=${JSON.stringify(s.items.bag)}`);
  check("B 回家: bag[1]=护符 (桌上自装)", travel.isType(s.items.bag[1], ITEM_TYPE.AMULET),
    `bag=${JSON.stringify(s.items.bag)}`);
  check("B 回家: bag[2]=道具 (桌上自装)", travel.isType(s.items.bag[2], ITEM_TYPE.TOOLS),
    `bag=${JSON.stringify(s.items.bag)}`);
  check("B 回家: bag[3]=道具 (桌上自装)", travel.isType(s.items.bag[3], ITEM_TYPE.TOOLS),
    `bag=${JSON.stringify(s.items.bag)}`);
  // 桌上少了被装走的 4 件
  const deskItems = s.items.desk.filter((v) => v !== -1);
  check("B 回家: 桌上少 4 件 (被装走)", deskItems.length === 4,
    `desk剩余=${deskItems.length} desk=${JSON.stringify(s.items.desk)}`);
})();

// --- C. 桌上只有护符: 回家后包内护符槽有物, 其余空 ---
(() => {
  const s = saveMod.newSave("rc_c");
  s.items.bag = [LUNCH.id, -1, -1, -1]; // 只放便当
  s.items.desk = [-1, -1, AMULET_DURABLE.id, -1, -1, -1, -1, -1]; // 桌上只放护符

  travel.departFrog(s, null, Math.floor(Date.now() / 1000));
  // provisionTrip: 便当消耗(bag[0]), 包内无耐用品, 桌上护符补齐 → carried
  check("C 出发: 桌上护符被拿走", s.items.desk.every((v) => v === -1),
    JSON.stringify(s.items.desk));

  travel.returnFrog(s, null, Math.floor(Date.now() / 1000));
  // returnGear: 桌上来源护符归桌 (from=desk), 无包内耐用品
  // autoPackFromDesk: 桌上有护符 → bag[1]
  check("C 回家: bag[1]=护符 (桌上归位后自装)", travel.isType(s.items.bag[1], ITEM_TYPE.AMULET),
    `bag=${JSON.stringify(s.items.bag)}`);
  check("C 回家: bag[0]空 (无便当)", s.items.bag[0] === -1, `bag=${JSON.stringify(s.items.bag)}`);
  check("C 回家: bag[2,3]空 (无道具)", s.items.bag[2] === -1 && s.items.bag[3] === -1,
    `bag=${JSON.stringify(s.items.bag)}`);
  // 护符从桌上被装走 (归桌后 autoPack 又拿进包)
  check("C 回家: 桌上空 (护符已入包)", s.items.desk.every((v) => v === -1),
    JSON.stringify(s.items.desk));
})();

// --- D. 消耗品护符 (四叶草): 旅行消耗, 回家不归还 ---
(() => {
  const AMULET_CONSUMABLE = items.find((i) => i.type === 1 && Number(i.spend) === 1);
  if (!AMULET_CONSUMABLE) { console.log("SKIP  无消耗型护符, 跳过 D"); }
  else {
    const s = saveMod.newSave("rc_d");
    s.items.bag = [LUNCH.id, AMULET_CONSUMABLE.id, -1, -1];
    s.items.desk = [-1, -1, -1, -1, -1, -1, -1, -1];

    travel.departFrog(s, null, Math.floor(Date.now() / 1000));
    travel.returnFrog(s, null, Math.floor(Date.now() / 1000));
    check("D 回家: 消耗品护符不归还 (不在仓库)", !s.items.house.some((h) => h.item_id === AMULET_CONSUMABLE.id),
      JSON.stringify(s.items.house.filter((h) => h.item_id === AMULET_CONSUMABLE.id)));
    check("D 回家: 包清空", s.items.bag.every((v) => v === -1), JSON.stringify(s.items.bag));
  }
})();

// 清理测试档
for (const a of ["rc_a", "rc_b", "rc_c", "rc_d"]) {
  try { fs.unlinkSync(path.join(__dirname, "..", "data", "user", a + ".json")); } catch (e) {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
