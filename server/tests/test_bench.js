/**
 * 嘟嘟商人端到端回归 (真实 WS 线格式 + GM HTTP API)
 * 覆盖用户报告的三个问题:
 *   1. 工具台空框      → furniture_load_furniture.bench 必须是 10 槽 -1 数组
 *   2. 点击商人物品报错  → shop_list 元素必须带 item_id (客户端 updateSelect 直读)
 *   3. 商品种类单一      → 材料+工具+图纸+家具物品混合, 图纸/工具单件
 * 运行前置: node server.js 已启动 (8080/8000)
 * 运行: node test_bench.js
 */
const WebSocket = require("ws");
const http = require("http");

const ACCOUNT = "bench_" + Date.now();
let sessionSeq = 0;
const pending = new Map();
const pushes = [];
let furniture = null; // 最近一次 furniture_load_furniture 载荷

function send(ws, cmd, data) {
  return new Promise((res) => {
    const s = ++sessionSeq;
    pending.set(s, res);
    ws.send(JSON.stringify({ session: s, timestamp: Date.now(), cmd, data: data || {} }));
  });
}

/** GM HTTP: POST /gm/api */
function gm(action, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ account: ACCOUNT, action, params: params || {} });
    const req = http.request({ host: "127.0.0.1", port: 8000, path: "/gm/api", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); });
    req.end(body);
  });
}

/** 当前 house 计数: 兼容 item_load_items (全量) 与 item_update (单品增量) 两种推送 */
const houseCount = (id) => {
  let count = 0, order = -1;
  pushes.forEach((p, i) => {
    if (p.cmd === "item_load_items") {
      const row = p.data.house.find((x) => x.item_id === id);
      if (i > order) { count = row ? row.count : 0; order = i; }
    } else if (p.cmd === "item_update" && p.data.item && p.data.item.item_id === id) {
      count = p.data.item.count; order = i;
    }
  });
  return count;
};

const BENCH_EMPTY = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
const isBenchEmpty = (b) => Array.isArray(b) && b.length === 10 && b.every((x) => x === -1);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

(async () => {
  // --- 登录 ---
  const ws = new WebSocket("ws://127.0.0.1:8080");
  await new Promise((r) => ws.once("open", r));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.session != null && pending.has(m.session)) { pending.get(m.session)(m.data); pending.delete(m.session); }
    else if (m.cmd) {
      pushes.push(m);
      if (m.cmd === "furniture_load_furniture") furniture = m.data;
    }
  });
  const t = await send(ws, "hall.gen_token", { account: ACCOUNT });
  await send(ws, "hall.enter_game", { token: t.token });
  await send(ws, "client.load_all_info", {});
  await new Promise((r) => setTimeout(r, 1200));

  // --- 1. 初始 bench: 10 槽全 -1 (旧 bug 发 [] → 工具台 0 格空框) ---
  check("初始推送 bench 为 10 槽 -1 数组", !!furniture && isBenchEmpty(furniture.bench),
    furniture ? "bench=" + JSON.stringify(furniture.bench) : "无 furniture 载荷");

  // --- 2. 嘟嘟到访 (GM) → 货架结构 ---
  const come = await gm("merchant_come");
  check("GM merchant_come 成功", come.ok === true, come.info);
  await new Promise((r) => setTimeout(r, 400));
  const list = (furniture && furniture.shop && furniture.shop.shop_list) || [];
  check("到访推送 bench 仍为 10 槽 -1", !!furniture && isBenchEmpty(furniture.bench));
  check("货架 12 件 (材料7+工具2+教程1+家具2)", list.length === 12, `实得 ${list.length}`);
  check("shop_list 元素全部带 item_id (点击报错根因)", list.length > 0 && list.every((g) => Number(g.item_id) > 0));
  // 多样性: 材料 7 + 工具 ≥1 + 图纸 ≥3 + 家具物品 ≥1
  const mats = list.filter((g) => g.item_id >= 10001 && g.item_id <= 10007);
  const tools = list.filter((g) => g.shop_id >= 1001 && g.shop_id <= 1005);
  const papers = list.filter((g) => g.shop_id >= 4001 && g.shop_id <= 4027);
  const parts = list.filter((g) => g.shop_id >= 3001 && g.shop_id <= 3011);
  check("基础材料 7 种全上", mats.length === 7, `实得 ${mats.length}`);
  check("工具上架 ≥1", tools.length >= 1, `实得 ${tools.length}`);
  check("制作教程恰好 1 本且单件", papers.length === 1 && papers[0].num === 1,
    `实得 ${papers.length}, num=${papers.map((g) => g.num).join(",")}`);
  check("家具物品上架 ≥1", parts.length >= 1, `实得 ${parts.length}`);

  // --- 3. 购买材料 (shop_id 2001 → item 10001, 20 草) ---
  const clover0 = pushes.filter((p) => p.cmd === "client_load_role").pop().data.res.clover_point;
  const n0 = pushes.length;
  const buy = await send(ws, "furniture.buy_shop", { shop_id: 2001 });
  check("购买材料 code=0", buy.code === 0, JSON.stringify(buy));
  const cu = pushes.slice(n0).find((p) => p.cmd === "clover_update");
  check("购买扣款 20 三叶草", !!cu && cu.data.clover === clover0 - 20, cu ? `clover=${cu.data.clover}` : "无推送");
  check("材料已入仓库", houseCount(10001) === 1, `count=${houseCount(10001)}`);

  // --- 4. 工作台放入 (物品槽 pos=6) ---
  const n4 = pushes.length;
  const pin = await send(ws, "furniture.putin_bench", { pos: 6, id: 10001 });
  check("putin_bench 物品槽 code=0", pin.code === 0, JSON.stringify(pin));
  check("putin 后库存已扣 (推送同步)", houseCount(10001) === 0, `count=${houseCount(10001)}`);
  const benchAfter = pushes.slice(n4).filter((p) => p.cmd === "furniture_load_furniture").pop();
  // putin 不回推 furniture; 通过 takeout 结果间接验证槽位

  // 库存耗尽再放同物品 → 拒绝 (回滚)
  const pin2 = await send(ws, "furniture.putin_bench", { pos: 7, id: 10001 });
  check("库存耗尽 putin 拒绝", pin2.code !== 0, `code=${pin2.code}`);

  // 占用槽位再放 → 拒绝
  const pin3 = await send(ws, "furniture.putin_bench", { pos: 6, id: 10001 });
  check("占用槽位 putin 拒绝", pin3.code !== 0, `code=${pin3.code}`);

  // pos 越界 → 拒绝
  const pin4 = await send(ws, "furniture.putin_bench", { pos: 11, id: 10001 });
  check("pos 越界 putin 拒绝", pin4.code !== 0, `code=${pin4.code}`);

  // --- 5. 工作台取出 ---
  const n5 = pushes.length;
  const out = await send(ws, "furniture.takeout_bench", { pos: 6 });
  check("takeout_bench code=0", out.code === 0, JSON.stringify(out));
  check("takeout 后物品回仓", houseCount(10001) === 1, `count=${houseCount(10001)}`);
  const out2 = await send(ws, "furniture.takeout_bench", { pos: 6 });
  check("空槽 takeout 拒绝", out2.code !== 0, `code=${out2.code}`);

  // --- 6. 工具槽 (pos=1) 放材料再取 ---
  const pinT = await send(ws, "furniture.putin_bench", { pos: 1, id: 10001 });
  check("putin_bench 工具槽 code=0", pinT.code === 0, JSON.stringify(pinT));
  const outT = await send(ws, "furniture.takeout_bench", { pos: 1 });
  check("工具槽 takeout code=0", outT.code === 0);

  // --- 6b. 教程收集语义: 买 1 本 → 离场 → 再到访, 已购教程不再上架 ---
  const paperOnShelf = (f) => ((f && f.shop && f.shop.shop_list) || []).filter((g) => g.shop_id >= 4001 && g.shop_id <= 4027);
  const paperList1 = paperOnShelf(furniture);
  if (paperList1.length === 1) {
    const buyPaper = await send(ws, "furniture.buy_shop", { shop_id: paperList1[0].shop_id });
    check("购买教程 code=0", buyPaper.code === 0, JSON.stringify(buyPaper));
    await gm("merchant_leave");
    await gm("merchant_come");
    await new Promise((r) => setTimeout(r, 400));
    const paperList2 = paperOnShelf(furniture);
    check("再次到访教程仍恰好 1 本", paperList2.length === 1,
      `实得 ${paperList2.length}`);
    check("已购教程不再上架", !paperList2.some((g) => g.shop_id === paperList1[0].shop_id),
      `新教程 shop_id=${paperList2.map((g) => g.shop_id).join(",")}`);
  } else {
    check("教程恰好 1 本 (购买链前置)", false, `实得 ${paperList1.length}`);
  }

  // --- 7. 嘟嘟离开后购买拒绝 ---
  await gm("merchant_leave");
  await new Promise((r) => setTimeout(r, 300));
  const buy2 = await send(ws, "furniture.buy_shop", { shop_id: 2001 });
  check("离场后购买拒绝 code=4", buy2.code === 4, `code=${buy2.code}`);

  // --- 8. 离场重连: bench 槽位持久 (工作台常驻, 不随嘟嘟离场消失) ---
  ws.close();
  const ws2 = new WebSocket("ws://127.0.0.1:8080");
  await new Promise((r) => ws2.once("open", r));
  let furniture2 = null;
  ws2.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.session != null && pending.has(m.session)) { pending.get(m.session)(m.data); pending.delete(m.session); }
    else if (m.cmd === "furniture_load_furniture") furniture2 = m.data;
  });
  const t2 = await send(ws2, "hall.gen_token", { account: ACCOUNT });
  await send(ws2, "hall.enter_game", { token: t2.token });
  await send(ws2, "client.load_all_info", {});
  await new Promise((r) => setTimeout(r, 1200));
  check("重连 bench 10 槽数组 (工作台常驻)", !!furniture2 && Array.isArray(furniture2.bench) && furniture2.bench.length === 10,
    furniture2 ? "bench=" + JSON.stringify(furniture2.bench) : "无载荷");
  check("重连离场后 leave_time=0", !!furniture2 && furniture2.shop.leave_time === 0);
  ws2.close();

  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
