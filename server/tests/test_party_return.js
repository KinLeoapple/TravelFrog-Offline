/**
 * 聚会回家后旅行衔接验证:
 *   A. 回家后旅行有 IDLE 休息 (不立即出门)
 *   B. 回家后 bag_completed=false (背包解锁)
 *   C. 邀约全流程: 邀请→确认→装包→锁包→出发→回家, 状态正确
 * 进程内, 无需服务器
 * 运行: node test_party_return.js
 */
const saveMod = require("../save");
const travel = require("../travel");
const drawing = require("../drawing");
const handlersMod = require("../handlers");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const now = () => Math.floor(Date.now() / 1000);

function mkCtx() {
  const ctx = { save: null, pushed: [], reply() {}, synced: true };
  ctx.push = (cmd, data) => ctx.pushed.push({ cmd, data });
  return ctx;
}

// --- A. 回家后旅行 IDLE 休息 ---
(() => {
  const s = saveMod.newSave("pr_a");
  const d = drawing.node(s);
  // 模拟聚会中: state=4, status=3, 蛙背包有便当 (tripPrepared=true)
  d.state = 4; d.guest = 0; d.returnAt = now() - 1;
  s.frog.status = 3;
  s.items.bag[0] = 1; // 便当 → tripPrepared=true
  s.travel.departAt = 0; // 已过期 (聚会期间一直顺延)

  drawing.returnParty(s, null, now());
  check("A 回家: status=0", s.frog.status === 0);
  check("A 回家: drawing.state=0", d.state === 0);
  // IDLE 休息: departAt 应在未来 (IDLE_MIN~MAX 后)
  const rest = s.travel.departAt - now();
  check("A 回家: 旅行有 IDLE 休息 (不立即出门)", rest >= travel.PACE.IDLE_MIN - 5 && rest <= travel.PACE.IDLE_MAX + 5,
    `rest=${rest}s departAt=${s.travel.departAt}`);
  check("A 回家: bag_completed=false", s.items.bag_completed === false,
    `bag_completed=${s.items.bag_completed}`);

  // 紧接着 travelTick: 蛙在家 + 有便当 + departAt 在未来 → 不出门
  travel.travelTick(s, null);
  check("A travelTick: 蛙在家休息 (未出门)", s.frog.status === 0 && s.travel.phase === "home");
})();

// --- B. 回家后 bag_completed 解锁 (模拟聚会前已锁包) ---
(() => {
  const s = saveMod.newSave("pr_b");
  const d = drawing.node(s);
  // 聚会前玩家已锁包 (旅行准备完成)
  s.items.bag_completed = true;
  s.items.bag[0] = 1; // 便当
  d.state = 4; d.guest = 1; d.returnAt = now() - 1;
  s.frog.status = 3;

  drawing.returnParty(s, null, now());
  check("B 回家: bag_completed 已解锁", s.items.bag_completed === false,
    `bag_completed=${s.items.bag_completed}`);
})();

// --- C. 邀约全流程 (协议驱动) ---
(() => {
  const ctx = mkCtx();
  const s = saveMod.newSave("pr_c");
  ctx.save = s;
  const h = handlersMod.handlers;
  const drawingBook = 7001;
  // 补发绘本
  h.item_putin_bag; // ensure loaded
  const lastDraw = () => {
    const p = ctx.pushed.filter((x) => x.cmd === "guest_load_drawing");
    return p[p.length - 1] ? p[p.length - 1].data : null;
  };

  // 1. 强制邀请 (GM drawing_invite 同款: 补绘本 + state=1)
  s.items.house.push({ item_id: drawingBook, count: 1 });
  const d = drawing.node(s);
  d.state = 1; d.guest = 0; d.inviteExpireAt = now() + 7200;
  ctx.pushed.length = 0;
  drawing.drawingPayload(s);
  check("C1 邀请: state=1 guest=0", d.state === 1 && d.guest === 0);

  // 2. 确认
  const ra = h.guest_accept_invit(ctx, { is_accept: true });
  check("C2 确认: code=0 + state=2", ra.code === 0 && d.state === 2);

  // 3. 装包 (食物 + 特产)
  const food = drawing.FOOD_IDS[0];
  const spec = drawing.SPECIALTY_IDS[0];
  s.items.house.push({ item_id: food, count: 1 });
  s.items.house.push({ item_id: spec, count: 2 });
  const pf = h.guest_putin_bag(ctx, { pos: 1, id: food });
  check("C3 装包: 食物入 pos1", pf.code === 0 && d.bag[0] === food);
  const ps = h.guest_putin_bag(ctx, { pos: 2, id: spec });
  check("C3 装包: 特产入 pos2", ps.code === 0 && d.bag[1] === spec);

  // 4. 锁包
  const lk = h.guest_lock_bag(ctx, {});
  check("C4 锁包: code=0 + state=3", lk.code === 0 && d.state === 3);
  check("C4 锁包: departAt 已排程", d.departAt > now());

  // 5. 出发 (drawingTick 推进)
  d.departAt = now() - 1; // 快进到期
  drawing.drawingTick(s, ctx.push, now());
  check("C5 出发: state=4 + status=3 + 手信消耗", d.state === 4 && s.frog.status === 3
    && d.bag.every((v) => v === -1), `state=${d.state} status=${s.frog.status} bag=${JSON.stringify(d.bag)}`);
  const goEv = ctx.pushed.filter((p) => p.cmd === "notify_new_event")
    .map((p) => p.data.event).find((e) => e.evt_type === 23);
  check("C5 出发: PartyGo 事件 + 精力充沛 (foodOk)", !!goEv && goEv.evt_value[0] === 1,
    JSON.stringify(goEv));

  // 6. 回家
  d.returnAt = now() - 1;
  ctx.pushed.length = 0;
  drawing.drawingTick(s, ctx.push, now());
  check("C6 回家: state=0 + status=0", d.state === 0 && s.frog.status === 0);
  check("C6 回家: bag_completed=false", s.items.bag_completed === false);
  const rest = s.travel.departAt - now();
  check("C6 回家: 旅行 IDLE 休息", rest >= travel.PACE.IDLE_MIN - 5, `rest=${rest}`);
  const resEv = ctx.pushed.filter((p) => p.cmd === "notify_new_event")
    .map((p) => p.data.event).find((e) => e.evt_type === 24);
  check("C6 回家: PartyResult 事件", !!resEv && resEv.evt_value.length >= 4,
    JSON.stringify(resEv && resEv.evt_value));
  check("C6 回家: 涂鸦页入库", d.pages.length > 0, JSON.stringify(d.pages));

  // 7. 回家后 travelTick 不立即送蛙出门 (IDLE 休息中)
  travel.travelTick(s, null);
  check("C7 travelTick: IDLE 休息中不出门", s.frog.status === 0 && s.travel.phase === "home");
})();

// --- D. 邀请期 (state=1) 不阻塞旅行出门 ---
(() => {
  const s = saveMod.newSave("pr_d");
  const d = drawing.node(s);
  d.state = 1; d.guest = 0; d.inviteExpireAt = now() + 7200;
  s.items.bag[0] = 1; // 便当
  s.travel.departAt = 0;
  travel.travelTick(s, null);
  check("D 邀请期不阻塞旅行: 蛙已出门", s.frog.status === 1 && s.travel.phase === "traveling",
    `status=${s.frog.status} phase=${s.travel.phase}`);
})();

// 清理
const fs = require("fs");
const path = require("path");
for (const a of ["pr_a", "pr_b", "pr_c", "pr_d"]) {
  try { fs.unlinkSync(path.join(__dirname, "..", "data", "user", a + ".json")); } catch (e) {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
