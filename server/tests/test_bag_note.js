/**
 * 背包归来重置 + NewNote 事件移除 修复验证:
 *   A. 进程内单测: save 迁移 (蛙在家 + bag_completed=true 残留 → false)
 *   B. WS E2E: 出发锁定 → 回家解锁 + 回家推送无 NewNote(15) 事件
 *
 * 前置: 服务器运行中 (ws://127.0.0.1:8080, GM 127.0.0.1:8000)
 * 运行: node test_bag_note.js
 */
const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");

const saveMod = require("../save");

const URL = "ws://127.0.0.1:8080/";
const GM = "http://127.0.0.1:8000/gm/api";
const ACCOUNT = "e2e_bag_" + Date.now();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

// ---------- A. 单测: 存档迁移 ----------
function unitMigrate() {
  const dir = path.join(__dirname, "..", "data", "user");
  const acct = "unit_migrate_" + Date.now();

  // 残留: 蛙在家 + 锁定 → 迁移解锁
  let s = saveMod.newSave(acct);
  s.frog.status = 0;
  s.items.bag_completed = true;
  saveMod.persist(s);
  s = saveMod.load(acct);
  check("迁移: 在家+锁定 → 解锁", s.items.bag_completed === false, `got=${s.items.bag_completed}`);

  // 旅行中 + 锁定 → 保留 (回家路径 returnFrog 负责重置)
  const acct2 = acct + "_2";
  s = saveMod.newSave(acct2);
  s.frog.status = 1;
  s.items.bag_completed = true;
  saveMod.persist(s);
  s = saveMod.load(acct2);
  check("迁移: 旅行中+锁定 → 保留", s.items.bag_completed === true);

  // 清理测试档
  try { fs.unlinkSync(path.join(dir, acct + ".json")); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(path.join(dir, acct2 + ".json")); } catch (e) { /* ignore */ }
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
    await sleep(500);
  }
  return null;
}

(async () => {
  unitMigrate();

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
  check("初始 bag_completed=false", byCmd("item_load_items").every((i) => !i.bag_completed),
    JSON.stringify(byCmd("item_load_items").map((i) => i.bag_completed)));

  // --- 装包 + 出发 ---
  const fill = await gm(ACCOUNT, "fill_bag", {});
  check("GM fill_bag", fill.ok, fill.info);
  await sleep(500);
  const setDone = await send(ws, "item_set_bag_completed", { completed: true });
  check("item_set_bag_completed 回包 code=0", setDone.code === 0, JSON.stringify(setDone));
  const departed = await waitFor(() => {
    const roles = byCmd("client_load_role");
    return roles.length && roles[roles.length - 1].frog && roles[roles.length - 1].frog.status === 1;
  }, 5000);
  check("点完成后蛙出游 (status=1)", !!departed);
  await waitFor(() => byCmd("item_load_items").some((i) => i.bag_completed === true), 5000);
  check("出游时 bag_completed=true (锁定)", byCmd("item_load_items").some((i) => i.bag_completed === true));

  // --- 回家 ---
  pushes.length = 0; // 只看回家这批推送
  const home = await gm(ACCOUNT, "frog_home", {});
  check("GM frog_home", home.ok, home.info);
  await waitFor(() => byCmd("item_load_items").length > 0, 5000);
  const lastItems = byCmd("item_load_items").pop() || {};
  check("回家后 bag_completed=false (背包解锁)", lastItems.bag_completed === false || lastItems.bag_completed === 0,
    `got=${lastItems.bag_completed}`);
  const events = byCmd("notify_new_event");
  check("回家推送无 NewNote(15) 事件", !events.some((e) => e.event && e.event.evt_type === 15),
    `evt_types=[${events.map((e) => e.event && e.event.evt_type).join(",")}]`);
  check("回家推送有 BackHome(2) 事件", events.some((e) => e.event && e.event.evt_type === 2));
  check("回家推送 travel_load_note (笔记 model 更新)", byCmd("travel_load_note").length > 0);

  const roleBack = await waitFor(() => {
    const roles = byCmd("client_load_role");
    return roles.length && roles[roles.length - 1].frog && roles[roles.length - 1].frog.status === 0 ? roles[roles.length - 1] : null;
  }, 5000);
  check("回家后 status=0 (在家)", !!roleBack);

  ws.close();
  await sleep(300);
  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("E2E 异常:", e); process.exit(1); });
