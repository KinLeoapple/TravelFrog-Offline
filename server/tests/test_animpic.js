/**
 * 动态照片测试: 建页/经验槽/显影液/完成循环/材料掉落 (引擎单测)
 * 用法: node server/tests/test_animpic.js
 */
const path = require("path");
const ap = require(path.join(__dirname, "..", "animpic.js"));
const saveMod = require(path.join(__dirname, "..", "save.js"));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  [ok]", msg); }
  else { fail++; console.log("  [FAIL]", msg); }
};
const wl = (p) => p; // withLayers 桩

/** 往新照片桶塞一张 pic_map 映射内的照片 (pic_id 100 → 模板 1) */
function seedPhoto(s, picId, uid) {
  const p = { id: uid, pic_id: picId, read: 0, new: 1 };
  s.albumPending.push(p);
  return p;
}

console.log("[A] 建页");
{
  const s = saveMod.newSave("ap_unit_" + Date.now());
  const p0 = seedPhoto(s, 100, 1);
  ok(ap.selectPic(s, 999) .code !== 0, "不存在的照片被拒");
  ok(ap.selectPic(s, p0.id).code === 0, "pic_id 100 → 模板 1 建页");
  const d = ap.payload(s, wl);
  ok(d.pic_list.length === 1 && d.pic_list[0].id === 1, "页 id=1");
  ok(d.phase === 1, "多相位模板初始 phase=1");
  ok(!s.albumPending.some((p) => p.id === p0.id), "照片已出新照片桶");
  // 显影中不能再建页
  const p1 = seedPhoto(s, 100, 2);
  ok(ap.selectPic(s, p1.id).code !== 0, "显影中建页被拒");
}

console.log("[B] 经验槽");
{
  const s = saveMod.newSave("ap_exp_" + Date.now());
  seedPhoto(s, 100, 1);
  ap.selectPic(s, 1);
  // 模板 1 的 pic_list 关联照片: 先看有哪些
  const allow = ap.LIST[1].pic_list;
  const ids = allow.map((picId, i) => { seedPhoto(s, picId, 100 + i); return 100 + i; });
  ok(ap.addPic(s, ids).code === 0, "add_pic 全部入槽");
  const d = ap.payload(s, wl);
  ok(d.exp_pic.length === Math.min(5, allow.length), "经验槽 ≤5: " + d.exp_pic.length);
  // 非关联照片不入槽
  seedPhoto(s, 99999, 500);
  ap.addPic(s, [500]);
  ok(!ap.payload(s, wl).exp_pic.some((p) => p.id === 500), "非关联照片被过滤");
  // 取回
  ok(ap.removePic(s, 1).code === 0, "remove_pic 退桶");
  ok(s.albumPending.some((p) => p.id === 100), "照片回到新照片桶");
}

console.log("[C] 显影液与完成循环");
{
  const s = saveMod.newSave("ap_fluid_" + Date.now());
  s.items.house.push({ item_id: 8002, count: 10 });
  s.items.house.push({ item_id: 8004, count: 10 });
  seedPhoto(s, 100, 1);
  ap.selectPic(s, 1);
  const allow = ap.LIST[1].pic_list;
  ap.addPic(s, allow.map((picId, i) => { seedPhoto(s, picId, 200 + i); return 200 + i; }));
  const a0 = ap.payload(s, wl).exp_pic.length;

  ok(ap.useItem(s, 12345, 1000).code !== 0, "非法显影液被拒");
  let r = ap.useItem(s, 8002, 1000);
  ok(r.code === 0 && r.phase === 1, "+25 exp (阈值 1→2 为 80) phase 仍 1");
  r = ap.useItem(s, 8002, 1001);
  ok(r.code === 0 && r.phase === 1, "累计 50 < 80, phase 仍 1");
  // 多色显影液 +100 → 150: 80→2, 120→3, 150→4 连跳
  r = ap.useItem(s, 8004, 1002);
  ok(r.phase === 4, "累计 150 → 连跳 phase 4");
  const cnt = (id) => { const x = s.items.house.find((h) => h.item_id === id); return x ? x.count : 0; };
  ok(cnt(8002) === 8 && cnt(8004) === 9, "显影液各消耗 (8002×2, 8004×1)");
  // 灌满剩余相位直到完成
  let guard = 0;
  while (ap.payload(s, wl).phase !== 0 && guard++ < 50) ap.useItem(s, 8004, 2000 + guard);
  const d = ap.payload(s, wl);
  ok(d.phase === 0 && d.item_num === 1, "推满相位 → 完成一轮 item_num=1");
  ok(d.exp_pic.length === 0, "经验槽照片退桶");
  ok(s.albumPending.length >= a0, "照片已回新照片桶");
  // 领奖
  const g = ap.getItem(s);
  ok(g.code === 0 && g.item_id === 9002 && g.count === 1, "领奖 9002×1");
  ok(ap.getItem(s).code !== 0, "不可重复领");
}

console.log("[D] 挂机经验 + 相框");
{
  const s = saveMod.newSave("ap_idle_" + Date.now());
  seedPhoto(s, 100, 1);
  ap.selectPic(s, 1);
  const allow = ap.LIST[1].pic_list;
  ap.addPic(s, allow.map((picId, i) => { seedPhoto(s, picId, 300 + i); return 300 + i; }));
  const n = ap.payload(s, wl).exp_pic.length;
  // 时间快进 60 分钟 ×n 张照片 (lastAt 已在建页/入槽时设为真实当前)
  const before = ap.payload(s, wl).exp + 60 * ap.payload(s, wl).phase; // 粗略: exp 或 phase 应有推进
  ap.tick(s, Math.floor(Date.now() / 1000) + 60 * 60);
  const d = ap.payload(s, wl);
  ok(d.exp > 0 || d.phase > 1 || d.item_num > 0, "挂机经验累计 (exp=" + d.exp + ", phase=" + d.phase + ")");
  // 第二页需要动态相框
  ap.tick(s, Math.floor(Date.now() / 1000) + 60 * 60 * 100);
  seedPhoto(s, 100, 900);
  ok(ap.selectPic(s, 900).code !== 0, "无相框建第二页被拒");
  s.items.house.push({ item_id: 9001, count: 1 });
  ok(ap.selectPic(s, 900).code === 0, "有相框建第二页成功");
  ok(!s.items.house.some((h) => h.item_id === 9001), "相框已消耗");
}

console.log("[E] 材料掉落分布");
{
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const d = ap.rollDrop();
    if (d > 0) seen[d] = (seen[d] || 0) + 1;
  }
  const total = Object.values(seen).reduce((a, b) => a + b, 0);
  ok(total > 400 && total < 560, "掉落率约 12%: " + (total / 40).toFixed(1) + "%");
  ok(seen[8002] > seen[8003] && seen[8003] > seen[8004], "权重 5:3:1 递减");
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
