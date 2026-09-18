/**
 * 线上端到端验证: 以真实客户端线格式连 ws://127.0.0.1:8080
 * 走完 登录 → 全量同步 → 放便当 → 等出门 → 等回家 → 相册/事件
 * 验证 server.js 进程内集成 (tick 调度 + 推送), 与 test_travel.js 的进程内测试互补
 *
 * 前置: 服务器需以快节奏 env 启动 (IDLE 45~60s, TRAVEL 120~180s)
 * 运行: node test_e2e_ws.js [account]
 */
const WebSocket = require("ws");

const ACCOUNT = process.argv[2] || "e2e_" + Date.now();
const URL = "ws://127.0.0.1:8080/";
let sessionSeq = 0;
const pending = new Map(); // session -> resolve
const pushes = [];         // 全部推送

function send(ws, cmd, data) {
  return new Promise((resolve) => {
    const session = ++sessionSeq;
    pending.set(session, resolve);
    ws.send(JSON.stringify({ session, timestamp: Date.now(), cmd, data: data || {} }));
  });
}

const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  const ws = new WebSocket(URL);
  const opened = new Promise((r) => ws.once("open", r));
  await Promise.race([opened, new Promise((_, rj) => setTimeout(() => rj(new Error("连接超时")), 5000))]);

  let role = null, events = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.session != null) {
      const resolve = pending.get(msg.session);
      if (resolve) { pending.delete(msg.session); resolve(msg.data); }
    } else if (msg.cmd) {
      pushes.push(msg);
      if (msg.cmd === "client_load_role") role = msg.data;
      if (msg.cmd === "client_load_events") events = msg.data;
      if (msg.cmd === "notify_new_event") {
        events.push(msg.data.event);
        console.log(`[事件] evt_type=${msg.data.event.evt_type} value=${JSON.stringify(msg.data.event.evt_value)}`);
      }
    }
  });

  // --- 登录链 (真实客户端顺序) ---
  const token = await send(ws, "hall.gen_token", { account: ACCOUNT });
  check("hall.gen_token code=0", token.code === 0);
  const enter = await send(ws, "hall.enter_game", {});
  check("hall.enter_game code=0", enter.code === 0, JSON.stringify(enter).slice(0, 120));
  await send(ws, "client.load_all_info", {});
  // 全量推送到达 (syncComplete 前后均可)
  await new Promise((r) => setTimeout(r, 1500));
  check("收到 client_load_role 推送", !!role);
  check("蛙在家 status=0", role && role.frog.status === 0, `status=${role && role.frog.status}`);
  check("收到事件列表推送", Array.isArray(events));

  // --- 放便当 (真实物品协议: 从 house 入包) ---
  const pin = await send(ws, "item.putin_bag", { pos: 1, item_id: 1 });
  check("便当入包 code=0", pin.code === 0, JSON.stringify(pin));

  // --- 官方出发流程: 点「准备完成」(BagView.lock → setBagLock → 发送) ---
  const lock = await send(ws, "item.set_bag_completed", { completed: true });
  check("准备完成 code=0", lock.code === 0, JSON.stringify(lock));

  // --- 等出门 (官方语义: 完成即出发, 服务器 30s tick 内推送; 余量 60s) ---
  console.log("等待蛙出门 (最长 60s)...");
  const t0 = Date.now();
  let departed = false;
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 3000));
    if (role && role.frog.status === 1) { departed = true; break; }
  }
  check("蛙已出门 (实时推送 client_load_role)", departed,
    `用时=${Math.round((Date.now() - t0) / 1000)}s`);
  check("出门事件 GoTravel 入列", events.some((e) => e.evt_type === 1));

  // --- 旅行中包不可操作 ---
  const tk = await send(ws, "item.takeout_bag", { pos: 2 });
  check("旅行中取包被拒", tk.code !== 0);

  // --- 等回家 (travel 120~180s × 便当加成 1.13 ≈ 136~204s, 余量 240s) ---
  console.log("等待蛙回家 (最长 250s)...");
  const t1 = Date.now();
  let returned = false;
  while (Date.now() - t1 < 250000) {
    await new Promise((r) => setTimeout(r, 10000));
    if (role && role.frog.status === 0 && Date.now() - t1 > 60000) {
      // 回家后 status=0; 排除出门前的初值 (60s 内不可能回家)
      if (events.some((e) => e.evt_type === 2)) { returned = true; break; }
    }
  }
  check("蛙已回家 (BackHome 事件)", returned,
    `用时=${Math.round((Date.now() - t1) / 1000)}s`);

  const backEv = events.find((e) => e.evt_type === 2);
  check("BackHome evt_value 长度>=5", backEv && backEv.evt_value.length >= 5,
    backEv ? JSON.stringify(backEv.evt_value) : "");
  const cloverUpd = pushes.find((p) => p.cmd === "clover_update");
  check("回家推送 clover_update", !!cloverUpd, cloverUpd ? JSON.stringify(cloverUpd.data) : "");
  const albumNew = pushes.find((p) => p.cmd === "album_load_new");
  check("推送 album_load_new", !!albumNew);

  // --- 照片归档 (有待归档照片时) ---
  if (albumNew && albumNew.data.pictures && albumNew.data.pictures.length > 0) {
    const pic = albumNew.data.pictures[0];
    check("照片有图层数据", Array.isArray(pic.layers) && pic.layers.length > 0,
      `pic_id=${pic.pic_id} layers=${pic.layers.length}`);
    const saved = await send(ws, "album.save_new", { id: pic.id });
    check("照片归档 code=0", saved.code === 0, JSON.stringify(saved));
  } else {
    console.log("SKIP  本轮旅行未掉落照片 (79%/轮, 属正常)");
  }

  // --- 事件确认 ---
  if (backEv) {
    const cf = await send(ws, "client.confirm_event", { id: backEv.id });
    check("事件确认 code=0", cf.code === 0);
  }

  // --- 重连追平: 断线重连后全量同步含旅行结果 ---
  ws.close();
  const ws2 = new WebSocket(URL);
  await new Promise((r) => ws2.once("open", r));
  let role2 = null;
  ws2.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.session != null) {
      const res = pending.get(m.session);
      if (res) { pending.delete(m.session); res(m.data); }
    } else if (m.cmd === "client_load_role") role2 = m.data;
  });
  await send(ws2, "hall.gen_token", { account: ACCOUNT });
  await send(ws2, "hall.enter_game", {});
  await send(ws2, "client.load_all_info", {});
  await new Promise((r) => setTimeout(r, 1500));
  check("重连后全量同步 role", !!role2 && role2.frog != null);
  const tripAfter = role2 && role2.res && role2.res.clover_point;
  check("重连后三叶草入账持久", typeof tripAfter === "number", `clover=${tripAfter}`);
  ws2.close();

  console.log(`\n端到端完成: 推送总数=${pushes.length}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("E2E 失败:", e.message); process.exit(1); });
