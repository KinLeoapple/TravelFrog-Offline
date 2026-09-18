/** 红点修复验证: 模拟客户端 canGet* 判定逻辑 */
const WebSocket = require("ws");
const ACCOUNT = "reddot_test_" + Date.now();
const ws = new WebSocket("ws://127.0.0.1:8080");
let seq = 0;
const pending = new Map();
let pushed = [];

function send(cmd, data) {
  return new Promise((resolve) => {
    const session = ++seq;
    pending.set(session, resolve);
    ws.send(JSON.stringify({ session, timestamp: Date.now(), cmd, data: data || {} }));
  });
}
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.session != null && pending.has(msg.session)) { pending.get(msg.session)(msg.data); pending.delete(msg.session); }
  else if (msg.cmd) pushed.push(msg);
});

ws.on("open", async () => {
  const t = await send("hall.gen_token", { account: ACCOUNT });
  await send("hall.login", { token: t.token });
  await send("hall.enter_game");
  await send("client.load_all_info");
  const role = pushed.find((p) => p.cmd === "client_load_role");
  const cal = pushed.find((p) => p.cmd === "calendar_load");
  const createTime = role.data.misc.create_time;

  // ---- 复刻客户端 CalendarModel 判定 ----
  const createDay = Math.floor((Date.now() / 1000 - createTime) / 86400) + 1;
  const canBeginner = !(createDay > cal.data.new_flag.length || cal.data.new_flag[createDay - 1] > 0);
  let canSt = true;
  for (const task of cal.data.task_list) if (!task.complete) { canSt = false; break; }
  const today = new Date().getDate();
  const canLucky = cal.data.lucky_days[today] != null;

  console.log("领取前: beginner =", canBeginner, "| st =", canSt, "| lucky =", canLucky, "-> 红点:", (canBeginner || canSt || canLucky) ? 1 : 0, "(应 1)");

  const c1 = await send("calendar.get_beginer_reward");
  // 客户端领取后: new_flag[day-1]=1 (来自响应 day)
  if (c1.day > 0) cal.data.new_flag[c1.day - 1] = 1;
  const canBeginner2 = !(createDay > cal.data.new_flag.length || cal.data.new_flag[createDay - 1] > 0);
  const redDot2 = (canBeginner2 || canSt || canLucky) ? 1 : 0;
  console.log("领取响应:", JSON.stringify(c1));
  console.log("领取后: beginner =", canBeginner2, "| st =", canSt, "| lucky =", canLucky, "-> 红点:", redDot2, "(应 0)");
  console.log(redDot2 === 0 ? "红点修复 PASS" : "红点仍亮 FAIL");
  ws.close();
  process.exit(redDot2 === 0 ? 0 : 1);
  ws.close();
  process.exit(0);
});
setTimeout(() => { console.error("超时"); process.exit(1); }, 10000);
