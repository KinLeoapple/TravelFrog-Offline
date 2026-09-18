/**
 * 祈愿/手工测试: 木片拼接 + 愿望牌生命周期 (引擎单测)
 * 用法: node server/tests/test_pray.js
 */
const path = require("path");
const pray = require(path.join(__dirname, "..", "pray.js"));
const saveMod = require(path.join(__dirname, "..", "save.js"));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  [ok]", msg); }
  else { fail++; console.log("  [FAIL]", msg); }
};

console.log("[A] 拼接 (pray_compose)");
{
  const s = saveMod.newSave("pray_unit_" + Date.now());
  // 木片不足 → 拒绝
  let r = pray.compose(s, pray.COMPOSE_ID);
  ok(r.code !== 0 && r.item_list.length === 0, "无木片拼接被拒");
  // 只有两枚 → 拒绝
  pray.CHIP_IDS.slice(0, 2).forEach((c) => s.items.house.push({ item_id: c, count: 1 }));
  r = pray.compose(s, pray.COMPOSE_ID);
  ok(r.code !== 0, "缺 1 种木片被拒");
  // 齐三枚 → 成功 (噪音物品用独立 id, 避开新档自带物品)
  s.items.house.push({ item_id: pray.CHIP_IDS[2], count: 1 });
  s.items.house.push({ item_id: 999, count: 5 }); // 噪音物品
  r = pray.compose(s, pray.COMPOSE_ID);
  ok(r.code === 0 && r.item_list.length === 1 && r.item_list[0].item_id === pray.AMULET_ID,
    "三木片 → 紫檀木护符 item_list");
  const cnt = (id) => { const x = s.items.house.find((h) => h.item_id === id); return x ? x.count : 0; };
  ok(pray.CHIP_IDS.every((c) => cnt(c) === 0), "木片各消耗 1 枚");
  ok(cnt(pray.AMULET_ID) === 1 && cnt(999) === 5, "护符入包, 噪音物品不受影响");
  // 非法 id
  ok(pray.compose(s, 12345).code !== 0, "非法 compose id 被拒");
  // 多枚木片只消耗 1
  pray.CHIP_IDS.forEach((c) => s.items.house.push({ item_id: c, count: 3 }));
  pray.compose(s, pray.COMPOSE_ID);
  ok(pray.CHIP_IDS.every((c) => cnt(c) === 2), "多枚木片各消耗 1 枚");
}

console.log("[B] 愿望牌生命周期");
{
  const s = saveMod.newSave("pray_life_" + Date.now());
  // 强制开始: onDepart 有概率, 多试几次
  let departs = 0;
  while (!s.pray || !s.pray.wish_new) {
    pray.onDepart(s, 1000000 + departs * 100);
    departs++;
    if (departs > 50) break;
  }
  ok(s.pray && s.pray.wish_new, "出门后开始制作愿望牌 (" + departs + " 次内)");
  const w = s.pray.wish_new;
  ok(pray.NOTE_IDS.includes(w.content), "content 在 prayNoteData 表内: " + w.content);
  ok(pray.STAMP_IDS.includes(w.stamp), "stamp 在 stampData 表内: " + w.stamp);
  ok(w.stamp_state >= 1 && w.stamp_state <= 3, "stamp_state 1..3: " + w.stamp_state);
  ok(w.make_time > 1000000, "make_time 在未来");

  const p1 = pray.payload(s);
  ok(p1.wish_new === w && p1.wishs.length === 0 && p1.stamps.length === 0 && p1.boxes.length === 0
    && p1.stamp_new === null, "载荷字段齐全");

  // 已在制作中不再重复开始
  pray.onDepart(s, 2000000);
  ok(s.pray.wish_new === w, "制作中不重复开新牌");

  // 回家归档
  ok(pray.onReturn(s) === true, "回家归档返回 true");
  ok(s.pray.wish_new === null && s.pray.wishs.length === 1 && s.pray.wishs[0] === w, "愿望牌入 wishs");
  ok(pray.onReturn(s) === false, "无牌可归档返回 false");

  // 上限 12
  for (let i = 0; i < 20; i++) {
    pray.onDepart(s, 3000000 + i * 10000);
    pray.onReturn(s);
  }
  ok(s.pray.wishs.length <= 12, "wishs 上限 12: " + s.pray.wishs.length);
}

console.log("[C] 旅行掉落木片");
{
  let got = 0, total = 2000;
  for (let i = 0; i < total; i++) {
    if (pray.rollChip() > 0) got++;
  }
  const ratio = got / total;
  ok(ratio > 0.2 && ratio < 0.3, "掉落率约 25%: " + (ratio * 100).toFixed(1) + "%");
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
