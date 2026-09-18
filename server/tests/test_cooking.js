/**
 * 月度烹饪测试: 引擎单测 (直接 require) + 协议链 (ws, 需服务器在 8080 已启动)
 * 用法: node server/tests/test_cooking.js   (服务器: node server/server.js)
 */
const path = require("path");
const cooking = require(path.join(__dirname, "..", "cooking.js"));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  [ok]", msg); }
  else { fail++; console.log("  [FAIL]", msg); }
}

// ---------- 引擎单测 ----------
console.log("[A] 引擎单测");
{
  const s = { items: { house: [] }, cooking: null };
  const pushed = [];
  const push = (cmd, data) => pushed.push({ cmd, data });

  cooking.tick(s, push); // 惰性建档 + 每周登录
  const c = s.cooking;
  ok(c && c.tasks.length === 3, "建档发 3 个任务");
  ok(c.month >= 1 && c.month <= 12, "日历月 1..12: " + c.month);
  ok(c.select === 0, "初始未选主题 (select=0, 客户端先弹主题选择)");
  ok(c.refresh_time > Math.floor(Date.now() / 1000), "refresh_time = 未来 0 点");

  const p1 = cooking.payload(s);
  ok(p1.task_list.length === 3 && p1.task_list[0].refresh === 0 && p1.complete === false,
    "payload 全字段 (task_list/refresh/complete)");

  // 每周登录任务: 若列表含 id=1, pro 应为 1
  const login = c.tasks.find((t) => t.id === 1);
  if (login) ok(login.pro === 1, "每周登录任务进度 1/1");
  else console.log("  [--] 本轮未发登录任务 (随机池), 跳过");

  // 三叶草任务: 喂 80 次 (delta 累计)
  const cloverTask = c.tasks.find((t) => t.id === 4);
  if (cloverTask) {
    pushed.length = 0;
    for (let i = 0; i < 80; i++) cooking.event(s, "cloverGain", {}, push);
    ok(cloverTask.pro === 80, "三叶草任务 80/80: " + cloverTask.pro);
    ok(pushed.some((p) => p.cmd === "cooking_task_update" && p.data.task.id === 4),
      "达标时推 cooking_task_update");
    // 重复事件不溢出
    cooking.event(s, "cloverGain", {}, push);
    ok(cloverTask.pro === 80, "进度封顶不溢出");
    ok(cooking.claim(s, 4), "领奖成功");
    ok(!cooking.claim(s, 4), "不可重复领");
    ok(c.month_pro === 1, "month_pro=1");
  } else {
    // 直接注入一个三叶草任务验证
    c.tasks[0] = { id: 4, pro: 0, complete: 0 };
    for (let i = 0; i < 80; i++) cooking.event(s, "cloverGain", {}, null);
    ok(c.tasks[0].pro === 80, "注入任务 80/80");
    cooking.claim(s, 4);
    ok(c.month_pro === 1, "month_pro=1 (注入)");
  }

  // 未达标领奖拒绝
  c.tasks[1] = { id: 5, pro: 0, complete: 0 };
  ok(!cooking.claim(s, 5), "未达标领奖被拒");
  cooking.event(s, "depart", {}, null);
  ok(c.tasks[1].pro === 1, "出门任务进度 +1");

  // 刷新: 换成列表外模板
  const before = c.tasks.map((t) => t.id).join(",");
  const t2 = cooking.swapTask(s, c.tasks[2].id);
  ok(t2 && !before.split(",").includes(String(t2.id)), "刷新换列表外任务");

  // 开火: 未做满拒绝
  ok(cooking.startCooking(s) === null, "未做满 6 个不可开火");

  // 做满 (直接补完剩余任务)
  while (c.month_pro < 6) {
    c.tasks = [1, 2, 3].map((id) => ({ id, pro: 0, complete: 0 }));
    for (const t of c.tasks) {
      const tpl = cooking.TASK_DB.find((x) => Number(x.id) === t.id);
      t.pro = Number(tpl.state);
      cooking.claim(s, t.id);
    }
  }
  ok(c.month_pro >= 6, "做满 6 个");

  // 选主题 2 → 开火发 selectMonth 对应食物
  c.select = 2;
  const got = cooking.startCooking(s);
  const row = cooking.DB.find((r) => Number(r.month) === c.month + 12);
  ok(got && got.item_id === Number(row.item_id), "开火发当月食物 #" + (got && got.item_id));
  ok(s.items.house.some((x) => x.item_id === got.item_id), "食物已入屋");
  ok(cooking.startCooking(s) === null, "当月不可重复开火");

  // 月度食物必出照片
  const pic = cooking.guaranteedPic(row.item_id, [], []);
  ok(pic === Number(row.pic_id), "月度食物必出照片 pic_id=" + pic);
  ok(cooking.guaranteedPic(row.item_id, [{ pic_id: Number(row.pic_id) }], []) === -1,
    "已拥有的照片不再重复发");
  ok(cooking.guaranteedPic(1, [], []) === -1, "普通食物无必出照片");
}

// ---------- 跨月重置 ----------
console.log("[B] 跨月重置");
{
  const s = { items: { house: [] } };
  const c0 = {
    window: "2000-01", month: 1, month_pro: 6, complete: 1, select: 2,
    lastWeek: "", refresh_time: 0, tasks: [{ id: 1, pro: 1, complete: 1 }],
  };
  s.cooking = c0;
  cooking.tick(s, null);
  ok(s.cooking.window !== "2000-01" && s.cooking.month_pro === 0 && s.cooking.complete === 0,
    "跨月重置 month_pro/complete");
  ok(s.cooking.select === 2, "主题选择跨月保留");
}

// ---------- 协议链 ----------
console.log("[C] 协议链 (ws://127.0.0.1:8080)");
try {
  const WebSocket = require(path.join(__dirname, "..", "node_modules", "ws"));
  const ACCOUNT = "cook_test_" + Date.now();
  const ws = new WebSocket("ws://127.0.0.1:8080");
  let seq = 0;
  const pending = new Map();
  let pushed = [];
  const send = (cmd, data) => new Promise((resolve) => {
    const session = ++seq;
    pending.set(session, resolve);
    ws.send(JSON.stringify({ session, timestamp: Date.now(), cmd, data: data || {} }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.session != null && pending.has(msg.session)) {
      pending.get(msg.session)(msg.data); pending.delete(msg.session);
    } else if (msg.cmd) pushed.push({ cmd: msg.cmd, data: msg.data });
  });
  ws.on("error", () => { console.log("  [--] 服务器未启动, 跳过协议链"); done(); });
  ws.on("open", async () => {
    try {
      await send("client.hello");
      const token = await send("hall.gen_token", { account: ACCOUNT });
      await send("hall.login", { token: token.token });
      await send("hall.enter_game");
      await send("client.load_all_info");

      const boot = pushed.find((p) => p.cmd === "cooking_load_cooking");
      ok(boot && boot.data.task_list.length === 3, "登录推送 cooking_load_cooking (3 任务)");
      ok(boot && boot.data.select === 0, "登录推送 select=0");

      const load = await send("cooking.load_cooking");
      ok(load && load.task_list.length === 3 && load.month >= 1, "cooking.load_cooking 响应全字段");

      ok((await send("cooking.select", { index: 9 })).code !== 0, "非法主题被拒");
      ok((await send("cooking.select", { index: 2 })).code === 0, "选主题 2");
      ok((await send("cooking.load_cooking")).select === 2, "主题已持久化");

      const anyId = load.task_list[0].id;
      const rf = await send("cooking.refresh_task", { id: anyId });
      ok(rf && rf.task && rf.task.id > 0, "刷新任务返回 {task}");
      ok((await send("cooking.complete_task", { id: rf.task.id })).code !== 0, "未达标领奖被拒 (协议)");
      ok((await send("cooking.start_cooking")).code !== 0, "未做满开火被拒 (协议)");
      ok((await send("cooking.share")).code === 0, "cooking_share 回 code 0");

      console.log("  [--] 协议链完成");
      ws.close(); done();
    } catch (e) { console.log("  [FAIL] 协议链异常:", e.message); ws.close(); done(); }
  });
} catch (e) {
  console.log("  [--] ws 不可用, 跳过协议链:", e.message);
  done();
}

function done() {
  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
