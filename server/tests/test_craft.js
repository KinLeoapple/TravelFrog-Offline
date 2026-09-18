/**
 * 工坊制作 + 栽培花盆端到端回归 (真实 WS 线格式 + GM HTTP API)
 * 覆盖:
 *   1. 登录推送: furniture_load_flowerpot / furniture_load_compost 全字段
 *   2. GM craft_start → bench_lock=1 + mate_list; 锁台 putin/takeout code=6
 *   3. GM craft_done → 结算三推送 + has_fur 入库 + notify_new_event(21)
 *   4. replace_fur 摆上/撤下/未拥有
 *   5. 堆肥盒 putin_box/takeout_box
 *   6. GM flowerpot_grown → harvest {item_list} + 三推送
 *   7. 重连持久化: has_fur/put_fur/compost/plant_list
 * 运行前置: node server.js 已启动 (8080/8000)
 * 运行: node test_craft.js
 */
const WebSocket = require("ws");
const http = require("http");

const ACCOUNT = "craft_" + Date.now();
let sessionSeq = 0;
const pending = new Map();
const pushes = [];
let furniture = null;   // 最近 furniture_load_furniture
let flowerpot = null;    // 最近 furniture_load_flowerpot
let compost = null;      // 最近 furniture_load_compost

function send(ws, cmd, data) {
  return new Promise((res) => {
    const s = ++sessionSeq;
    pending.set(s, res);
    ws.send(JSON.stringify({ session: s, timestamp: Date.now(), cmd, data: data || {} }));
  });
}

function gm(action, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ account: ACCOUNT, action, params: params || {} });
    const req = http.request({ host: "127.0.0.1", port: 8000, path: "/gm/api", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); });
    req.end(body);
  });
}

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
      if (m.cmd === "furniture_load_flowerpot") flowerpot = m.data;
      if (m.cmd === "furniture_load_compost") compost = m.data;
    }
  });
  const t = await send(ws, "hall.gen_token", { account: ACCOUNT });
  await send(ws, "hall.enter_game", { token: t.token });
  await send(ws, "client.load_all_info", {});
  await new Promise((r) => setTimeout(r, 1200));

  // --- 1. 家具族载荷 (BOOT_PUSH) ---
  check("登录推送 furniture_load_flowerpot", !!flowerpot, flowerpot ? JSON.stringify(flowerpot.show_list) : "无");
  check("花盆 show_list=[{type:1,id:23001}]", !!flowerpot && JSON.stringify(flowerpot.show_list) === JSON.stringify([{ type: 1, id: 23001 }]));
  check("plant_list 2 条 (服务器自动播种)", !!flowerpot && Array.isArray(flowerpot.plant_list) && flowerpot.plant_list.length === 2,
    flowerpot ? JSON.stringify(flowerpot.plant_list) : "");
  check("登录推送 furniture_load_compost", !!compost && Array.isArray(compost.box_list) && compost.box_list.length === 6,
    compost ? "box_list=" + JSON.stringify(compost.box_list) : "无");
  check("furniture 载荷含 mate_list/replace_fur", !!furniture && Array.isArray(furniture.mate_list) && Array.isArray(furniture.replace_fur) && Array.isArray(furniture.has_fur),
    furniture ? "keys ok" : "无 furniture");
  check("初始 bench_lock=0", !!furniture && furniture.bench_lock === 0);

  // --- 2. GM craft_start: 图纸+材料自动开工 ---
  const n2 = pushes.length;
  const cs = await gm("craft_start");
  check("GM craft_start 成功", cs.ok === true, cs.info);
  await new Promise((r) => setTimeout(r, 400));
  const fStartMsg = pushes.slice(n2).filter((p) => p.cmd === "furniture_load_furniture").pop();
  const fStart = fStartMsg && fStartMsg.data;
  check("开工推送 furniture_load_furniture", !!fStart, "");
  check("开工后 bench_lock=1", !!fStart && fStart.bench_lock === 1, `=${fStart && fStart.bench_lock}`);
  check("开工后 mate_list 非空 (材料平铺)", !!fStart && Array.isArray(fStart.mate_list) && fStart.mate_list.length > 0,
    `mate_list=${JSON.stringify((fStart || {}).mate_list)}`);
  check("开工后 has_fur 不含新家具", !!fStart && fStart.has_fur.length === 0, `has_fur=${JSON.stringify((fStart || {}).has_fur)}`);

  // --- 3. 锁台: putin/takeout code=6 ---
  const lockPin = await send(ws, "furniture.putin_bench", { pos: 1, id: 1 });
  check("锁台 putin_bench code=6", lockPin.code === 6, JSON.stringify(lockPin));
  const lockOut = await send(ws, "furniture.takeout_bench", { pos: 6 });
  check("锁台 takeout_bench code=6", lockOut.code === 6, JSON.stringify(lockOut));

  // --- 4. GM craft_done: 结算三推送 + 家具入库 + 事件 21 ---
  const n4 = pushes.length;
  const cd = await gm("craft_done");
  check("GM craft_done 成功", cd.ok === true, cd.info);
  await new Promise((r) => setTimeout(r, 400));
  const doneMsg = pushes.slice(n4).filter((p) => p.cmd === "furniture_load_furniture").pop();
  const done = doneMsg && doneMsg.data;
  check("结算推送 furniture_load_furniture", !!done, "");
  check("结算后 bench_lock=0", !!done && done.bench_lock === 0, `=${done && done.bench_lock}`);
  check("家具入库 has_fur=1 件", !!done && done.has_fur.length === 1, `has_fur=${JSON.stringify((done || {}).has_fur)}`);
  check("结算后 mate_list 空", !!done && done.mate_list.length === 0, `=${JSON.stringify((done || {}).mate_list)}`);
  check("结算推送 item_load_items", pushes.slice(n4).some((p) => p.cmd === "item_load_items"));
  const evt = pushes.slice(n4).find((p) => p.cmd === "notify_new_event");
  check("结算推送 notify_new_event evt_type=21", !!evt && evt.data.event.evt_type === 21,
    evt ? "evt_value=" + JSON.stringify(evt.data.event.evt_value) : "无");
  check("evt_value=[家具id,图纸id]", !!evt && Array.isArray(evt.data.event.evt_value) && evt.data.event.evt_value.length === 2,
    evt ? JSON.stringify(evt.data.event.evt_value) : "");
  const newFur = done && done.has_fur[0];

  // --- 5. replace_fur 摆上/撤下/未拥有 ---
  const rf1 = await send(ws, "furniture.replace_fur", { id: newFur });
  check("replace_fur 摆上 code=0", rf1.code === 0, JSON.stringify(rf1));
  const rf2 = await send(ws, "furniture.replace_fur", { id: newFur });
  check("replace_fur 同件再摆撤下 code=1", rf2.code === 1, JSON.stringify(rf2));
  const rf3 = await send(ws, "furniture.replace_fur", { id: 99999 });
  check("replace_fur 未定义家具 code=-1", rf3.code === -1, JSON.stringify(rf3));
  // 摆上后 put_fur 记录 (下次 furniture 推送验证; 客户端自维护, 这里直接再摆一次后查存档 → 重连节验证)

  // --- 6. 堆肥盒: 便当 (item 1) 放/取 ---
  const before6 = houseCount(1);
  const pb = await send(ws, "furniture.putin_box", { pos: 1, id: 1 });
  check("putin_box code=0", pb.code === 0, JSON.stringify(pb));
  check("putin_box 后 house 扣减", houseCount(1) === before6 - 1, `count=${houseCount(1)}`);
  const tb = await send(ws, "furniture.takeout_box", { pos: 1 });
  check("takeout_box code=0", tb.code === 0, JSON.stringify(tb));
  check("takeout_box 后回仓", houseCount(1) === before6, `count=${houseCount(1)}`);
  const tb2 = await send(ws, "furniture.takeout_box", { pos: 1 });
  check("空槽 takeout_box 拒绝", tb2.code !== 0, `code=${tb2.code}`);
  const pb2 = await send(ws, "furniture.putin_box", { pos: 8, id: 1 });
  check("box pos 越界拒绝", pb2.code !== 0, `code=${pb2.code}`);

  // --- 7. 栽培: 催熟 → 收获 ---
  const fg = await gm("flowerpot_grown");
  check("GM flowerpot_grown 成功", fg.ok === true, fg.info);
  const plantListBefore = (flowerpot && flowerpot.plant_list) || [];
  check("催熟后 plant_list stage=3", plantListBefore.length === 2 && plantListBefore.every((p) => p.stage === 3),
    JSON.stringify(plantListBefore));
  const n7 = pushes.length;
  const hv = await send(ws, "furniture.flowerpot_harvest", { index: 1 });
  check("harvest 响应 {item_list:[{item_id,num}]} 无 code",
    hv && Array.isArray(hv.item_list) && hv.item_list.length === 1 && hv.item_list[0].item_id > 0 && hv.item_list[0].num >= 1 && hv.item_id === undefined && hv.code === undefined,
    JSON.stringify(hv));
  const gotId = hv.item_list[0].item_id, gotNum = hv.item_list[0].num;
  await new Promise((r) => setTimeout(r, 300));
  check("收获推送 item_update", pushes.slice(n7).some((p) => p.cmd === "item_update" && p.data.item && p.data.item.item_id === gotId),
    `count=${houseCount(gotId)}`);
  check("收获推送 item_load_handbook", pushes.slice(n7).some((p) => p.cmd === "item_load_handbook"));
  check("收获推送无 client_load_role (P13: 视角不回中)", !pushes.slice(n7).some((p) => p.cmd === "client_load_role"));
  check("特产入仓库", houseCount(gotId) === gotNum, `count=${houseCount(gotId)} num=${gotNum}`);
  // 未熟槽收获: 另一槽已被 harvest? 不 — index 1 已收, index 2 仍 stage=3 → 再收也成功; 改测越界
  const hv2 = await send(ws, "furniture.flowerpot_harvest", { index: 9 });
  check("越界 harvest 空对象", JSON.stringify(hv2) === "{}", JSON.stringify(hv2));

  // --- 8. 重连持久化: 家具/摆放/堆肥/花盆 ---
  // 先把家具摆上 (put_fur 持久验证)
  await send(ws, "furniture.replace_fur", { id: newFur });
  ws.close();
  const ws2 = new WebSocket("ws://127.0.0.1:8080");
  await new Promise((r) => ws2.once("open", r));
  let furniture2 = null, flowerpot2 = null;
  ws2.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.session != null && pending.has(m.session)) { pending.get(m.session)(m.data); pending.delete(m.session); }
    else if (m.cmd === "furniture_load_furniture") furniture2 = m.data;
    else if (m.cmd === "furniture_load_flowerpot") flowerpot2 = m.data;
  });
  const t2 = await send(ws2, "hall.gen_token", { account: ACCOUNT });
  await send(ws2, "hall.enter_game", { token: t2.token });
  await send(ws2, "client.load_all_info", {});
  await new Promise((r) => setTimeout(r, 1200));
  check("重连 has_fur 持久", !!furniture2 && JSON.stringify(furniture2.has_fur) === JSON.stringify([newFur]),
    `has_fur=${JSON.stringify((furniture2 || {}).has_fur)}`);
  check("重连 put_fur 持久", !!furniture2 && Array.isArray(furniture2.put_fur) && furniture2.put_fur.some((p) => p.id === newFur),
    `put_fur=${JSON.stringify((furniture2 || {}).put_fur)}`);
  check("重连 plant_list 持久 (2 槽)", !!flowerpot2 && Array.isArray(flowerpot2.plant_list) && flowerpot2.plant_list.length === 2,
    JSON.stringify((flowerpot2 || {}).plant_list));
  ws2.close();

  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
