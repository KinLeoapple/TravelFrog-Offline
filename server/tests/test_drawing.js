/**
 * 涂鸦派对 (Drawing Party) 验证:
 *   A. 单测: 旅行守卫 (status=3 / state=2~3 阻塞出门, state=1 不阻塞) + 结算形状
 *   B. WS+GM E2E: 强制邀请 → 接受 → 装包校验 (类型/占用/取出)
 *      → 锁包/解锁 → GM 快进出发 (PartyGo) → 聚会中 frog_depart 拒绝
 *      → GM 快进回家 (PartyResult: 涂鸦页/三叶草) → 拒绝路径 → 全重置
 *
 * 前置: 服务器运行中 (ws://127.0.0.1:8080, GM 127.0.0.1:8000)
 * 运行: node test_drawing.js
 */
const WebSocket = require("ws");
const http = require("http");

const saveMod = require("../save");
const travel = require("../travel");
const drawing = require("../drawing");

const URL = "ws://127.0.0.1:8080/";
const GM = "http://127.0.0.1:8000/gm/api";
const ACCOUNT = "e2e_drawing_" + Date.now();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

// ---------- A. 单测: 旅行守卫 + 结算 ----------
function unitGuard() {
  const t = Math.floor(Date.now() / 1000);

  // status=3 (聚会中): 装备齐也不出门
  let s = saveMod.newSave("unit_party1_" + Date.now());
  s.frog.status = 3;
  s.items.bag[0] = 16; // tripPrepared
  s.travel.departAt = 0;
  travel.travelTick(s, null);
  check("守卫: 聚会中 (status=3) 不出门", s.frog.status === 3 && s.travel.phase === "home"
    && s.travel.departAt > t, `status=${s.frog.status} phase=${s.travel.phase}`);

  // state=2 (装包期): 不出门
  s = saveMod.newSave("unit_party2_" + Date.now());
  s.items.bag[0] = 16;
  s.travel.departAt = 0;
  drawing.node(s).state = 2;
  travel.travelTick(s, null);
  check("守卫: 装包期 (state=2) 不出门", s.frog.status === 0 && s.travel.phase === "home"
    && s.travel.departAt > t, `status=${s.frog.status} phase=${s.travel.phase}`);

  // state=1 (邀请未应答): 不阻塞正常旅行
  s = saveMod.newSave("unit_party3_" + Date.now());
  s.items.bag[0] = 16;
  s.travel.departAt = 0;
  const d1 = drawing.node(s);
  d1.state = 1; d1.guest = 0;
  travel.travelTick(s, null);
  check("守卫: 邀请期 (state=1) 不阻塞出门", s.frog.status === 1 && s.travel.phase === "traveling",
    `status=${s.frog.status} phase=${s.travel.phase}`);

  // 结算形状: guest=1 首页 101; evt_value=[page, coll, clover, ticket, ...items]
  s = saveMod.newSave("unit_party4_" + Date.now());
  const d4 = drawing.node(s);
  d4.state = 4; d4.guest = 1;
  const ev = drawing.returnParty(s, null, t);
  check("结算: PartyResult 事件形状", ev.evt_type === 24 && ev.evt_id === 1
    && ev.evt_value[0] === 101 && ev.evt_value.length >= 4
    && ev.evt_value[2] >= drawing.ROLL.CLOVER_MIN && ev.evt_value[2] <= drawing.ROLL.CLOVER_MAX,
    JSON.stringify(ev.evt_value));
  check("结算: 状态归位 + 涂鸦页入库", d4.state === 0 && s.frog.status === 0
    && d4.pages.includes(101) && d4.guest === -1, JSON.stringify(d4.pages));

  // 回归: server.js 消息路径/30s 定时器只传 (save, push) 不传 now
  // —— drawingTick 必须内部自算, 否则 undefined >= 时间戳恒 false, 时间推进全部停摆
  s = saveMod.newSave("unit_party5_" + Date.now());
  const d5 = drawing.node(s);
  d5.state = 3; d5.guest = 0; d5.bag[0] = 16; d5.departAt = t - 1;
  drawing.drawingTick(s, null); // 故意不传第三参
  check("回归: 锁包到点出发 (不传 now)", d5.state === 4 && s.frog.status === 3 && d5.bag[0] === -1,
    `state=${d5.state} status=${s.frog.status}`);

  s = saveMod.newSave("unit_party6_" + Date.now());
  const d6 = drawing.node(s);
  d6.state = 1; d6.guest = 0; d6.inviteExpireAt = t - 1;
  drawing.drawingTick(s, null);
  check("回归: 邀请过期撤回 (不传 now)", d6.state === 0 && d6.guest === -1, `state=${d6.state}`);

  s = saveMod.newSave("unit_party7_" + Date.now());
  const d7 = drawing.node(s);
  d7.state = 4; d7.guest = 2; d7.returnAt = t - 1;
  drawing.drawingTick(s, null);
  check("回归: 聚会到点回家 (不传 now)", d7.state === 0 && s.frog.status === 0 && d7.pages.length > 0,
    `state=${d7.state} pages=${JSON.stringify(d7.pages)}`);
}

// ---------- B. WS E2E ----------
let sessionSeq = 0;
const pending = new Map();
const pushes = [];
const byCmd = (cmd) => pushes.filter((p) => p.cmd === cmd).map((p) => p.data);

function send(ws, cmd, data) {
  return new Promise((resolve) => {
    const session = ++sessionSeq;
    pending.set(session, resolve);
    ws.send(JSON.stringify({ session, timestamp: Date.now(), cmd, data: data || {} }));
  });
}

function gm(account, action, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ account, action, params: params || {} });
    const req = http.request(GM, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = cond();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

(async () => {
  unitGuard();

  const ws = new WebSocket(URL);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.session != null) {
      const resolve = pending.get(msg.session);
      if (resolve) { pending.delete(msg.session); resolve(msg.data); }
    } else if (msg.cmd) {
      pushes.push(msg);
    }
  });

  // --- 登录 ---
  const token = await send(ws, "hall.gen_token", { account: ACCOUNT });
  check("登录 gen_token", token.code === 0);
  await send(ws, "hall.enter_game", {});
  await send(ws, "client.load_all_info", {});
  await waitFor(() => byCmd("item_load_items").length > 0, 5000);
  const lastDrawing = () => { const a = byCmd("guest_load_drawing"); return a[a.length - 1] || null; };
  check("初始 drawing 推送 (state=0)", !!lastDrawing() && lastDrawing().state === 0,
    JSON.stringify(lastDrawing()));

  // --- 1. 未邀请时协议拒绝 ---
  const r0 = await send(ws, "guest_putin_bag", { pos: 1, id: drawing.FOOD_IDS[0] });
  check("未邀请 putin 拒绝 (code=1)", r0.code === 1);

  // --- 2. GM 强制邀请 (无绘本自动补发 7001) ---
  const gi = await gm(ACCOUNT, "drawing_invite", { guest: 0 });
  check("GM 强制邀请 (困困)", gi.ok && /困困/.test(gi.info), gi.info);
  const inv = await waitFor(() => (lastDrawing() || {}).state === 1 ? lastDrawing() : null, 5000);
  check("邀请推送 state=1 guest=0", !!inv && inv.guest === 0 && inv.state === 1,
    JSON.stringify(inv));
  check("绘本 7001 自动补发", byCmd("item_load_items")
    .some((p) => (p.house || []).some((x) => x.item_id === 7001)));

  // --- 3. 接受邀请 ---
  const ra = await send(ws, "guest_accept_invit", { is_accept: true });
  check("接受邀请 code=0", ra.code === 0);
  await waitFor(() => (lastDrawing() || {}).state === 2, 5000);
  check("state=2 (小屋装包模式)", (lastDrawing() || {}).state === 2);

  // --- 4. 装包校验 ---
  await gm(ACCOUNT, "give_item", { item_id: drawing.FOOD_IDS[0], count: 2 });
  await gm(ACCOUNT, "give_item", { item_id: drawing.SPECIALTY_IDS[0], count: 2 });
  const p1 = await send(ws, "guest_putin_bag", { pos: 1, id: drawing.FOOD_IDS[0] });
  check("putin 食物槽 (三选一)", p1.code === 0);
  const pBad = await send(ws, "guest_putin_bag", { pos: 2, id: drawing.FOOD_IDS[0] });
  check("putin 特产槽拒绝非特产", pBad.code === 1 && pBad.conflict === false);
  const p2 = await send(ws, "guest_putin_bag", { pos: 2, id: drawing.SPECIALTY_IDS[0] });
  check("putin 特产槽", p2.code === 0);
  const p2b = await send(ws, "guest_putin_bag", { pos: 2, id: drawing.SPECIALTY_IDS[0] });
  check("putin 占用槽 conflict=true", p2b.code === 1 && p2b.conflict === true);
  const t2 = await send(ws, "guest_takeout_bag", { pos: 2 });
  check("takeout 取出回屋", t2.code === 0);
  const p2c = await send(ws, "guest_putin_bag", { pos: 2, id: drawing.SPECIALTY_IDS[0] });
  check("takeout 后可回装", p2c.code === 0);

  // --- 5. 锁包 / 解锁 / 再锁 ---
  const l1 = await send(ws, "guest_lock_bag", {});
  check("锁包 code=0", l1.code === 0);
  await waitFor(() => (lastDrawing() || {}).state === 3, 5000);
  check("state=3 (锁包)", (lastDrawing() || {}).state === 3);
  const l2 = await send(ws, "guest_lock_bag", {});
  await waitFor(() => (lastDrawing() || {}).state === 2, 5000);
  check("反悔解锁回 state=2", l2.code === 0 && (lastDrawing() || {}).state === 2);
  const l3 = await send(ws, "guest_lock_bag", {});
  check("再锁包", l3.code === 0);

  // --- 6. GM 快进: 出发去聚会 ---
  const ga = await gm(ACCOUNT, "drawing_advance", {});
  check("GM 快进出发", ga.ok, ga.info);
  const evGo = await waitFor(() => byCmd("notify_new_event").map((p) => p.event)
    .find((e) => e.evt_type === 23), 5000);
  check("PartyGo 事件 (手食齐备)", !!evGo && evGo.evt_value[0] === 1,
    JSON.stringify(evGo && evGo.evt_value));
  await waitFor(() => (lastDrawing() || {}).state === 4, 5000);
  check("state=4 + 画具包清空", (lastDrawing() || {}).state === 4
    && (lastDrawing() || {}).bag.every((x) => x === -1),
    JSON.stringify((lastDrawing() || {}).bag));
  const st1 = await gm(ACCOUNT, "status", {});
  check("GM status 显示聚会中", /聚会中/.test(st1.info), st1.info.split("\n")[1]);
  const fd = await gm(ACCOUNT, "frog_depart", {});
  check("聚会中 frog_depart 拒绝", /聚会中/.test(fd.info), fd.info);

  // --- 7. GM 快进: 回家结算 ---
  const gr = await gm(ACCOUNT, "drawing_advance", {});
  check("GM 快进回家结算", gr.ok, gr.info);
  const evRes = await waitFor(() => byCmd("notify_new_event").map((p) => p.event)
    .find((e) => e.evt_type === 24), 5000);
  check("PartyResult 事件 (guest=0 首页)", !!evRes && evRes.evt_id === 0
    && evRes.evt_value[0] === 1 && evRes.evt_value.length >= 4,
    JSON.stringify(evRes && evRes.evt_value));
  await waitFor(() => (lastDrawing() || {}).state === 0, 5000);
  const after = lastDrawing() || {};
  check("回家 state=0 + 涂鸦页入库", after.state === 0 && after.pages.includes(1),
    JSON.stringify(after.pages));
  check("三叶草入账推送", byCmd("clover_update").length > 0);
  const st2 = await gm(ACCOUNT, "status", {});
  check("回家后 status 在家", /在家/.test(st2.info.split("\n")[1]), st2.info.split("\n")[1]);

  // --- 8. 拒绝邀请路径 ---
  const gi2 = await gm(ACCOUNT, "drawing_invite", { guest: 1 });
  check("再次邀请 (胖胖)", gi2.ok && /胖胖/.test(gi2.info), gi2.info);
  await waitFor(() => (lastDrawing() || {}).state === 1, 5000);
  const rr = await send(ws, "guest_accept_invit", { is_accept: false });
  check("拒绝邀请 code=0", rr.code === 0);
  const rej = await waitFor(() => {
    const d = lastDrawing() || {};
    return d.state === 0 ? d : null;
  }, 5000);
  check("拒绝后回 state=0 (邻居撤回)", !!rej && rej.guest === -1, JSON.stringify(rej));

  // --- 9. GM 全重置 ---
  const grst = await gm(ACCOUNT, "drawing_reset", {});
  check("GM 全重置", grst.ok, grst.info);
  const clr = await waitFor(() => {
    const d = lastDrawing() || {};
    return d.pages.length === 0 && d.colls.length === 0 ? d : null;
  }, 5000);
  check("重置后涂鸦页/收藏品清空", !!clr && clr.show_coll === 0, JSON.stringify(clr));

  ws.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
