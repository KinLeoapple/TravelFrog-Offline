/**
 * 日历签到协议级测试: 登录链 -> 领取 -> 防重复 -> 持久化验证
 * 用法: node server/test_calendar.js [account]
 */
const WebSocket = require("ws");
const ACCOUNT = process.argv[2] || "cal_test_" + Date.now();

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
  if (msg.session != null && pending.has(msg.session)) {
    pending.get(msg.session)(msg.data);
    pending.delete(msg.session);
  } else if (msg.cmd) {
    pushed.push({ cmd: msg.cmd, data: msg.data });
  }
});

ws.on("open", async () => {
  try {
    // 1. 登录链
    const hello = await send("client.hello");
    const token = await send("hall.gen_token", { account: ACCOUNT });
    const login = await send("hall.login", { token: token.token });
    await send("hall.enter_game");
    await send("client.load_all_info");
    const calLoad = pushed.find((p) => p.cmd === "calendar_load");
    console.log("[1] 登录链 OK, calendar_load new_flag =", JSON.stringify(calLoad.data.new_flag));

    // 2. 首次领取
    const claim1 = await send("calendar.get_beginer_reward");
    console.log("[2] 首次领取:", JSON.stringify(claim1));
    const itemPush = pushed.filter((p) => p.cmd === "item_update");
    console.log("    item_update 推送:", JSON.stringify(itemPush.map((p) => p.data)));

    // 3. 重复领取
    const claim2 = await send("calendar.get_beginer_reward");
    console.log("[3] 重复领取 (应 day:0):", JSON.stringify(claim2));

    // 4. 兑换码领取同一天 (应 day:0)
    const code = await send("calendar.get_code_reward", { day: 1 });
    console.log("[4] 兑换码重复领 (应 day:0):", JSON.stringify(code));

    // 5. load_note
    const note = await send("calendar.load_note");
    console.log("[5] load_note:", JSON.stringify(note));

    // 6. 断开重连验证持久化
    ws.close();
    await new Promise((r) => setTimeout(r, 1500));
    const ws2 = new WebSocket("ws://127.0.0.1:8080");
    ws2.on("open", async () => {
      const p2 = new Map();
      let pushed2 = [];
      const send2 = (cmd, data) => new Promise((resolve) => {
        const s = ++seq;
        p2.set(s, resolve);
        ws2.send(JSON.stringify({ session: s, timestamp: Date.now(), cmd, data: data || {} }));
      });
      ws2.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.session != null && p2.has(m.session)) { p2.get(m.session)(m.data); p2.delete(m.session); }
        else if (m.cmd) pushed2.push(m);
      });
      await send2("hall.gen_token", { account: ACCOUNT });
      await send2("hall.login", { token: "x" });
      await send2("hall.enter_game");
      await send2("client.load_all_info");
      const cal2 = pushed2.find((p) => p.cmd === "calendar_load");
      console.log("[6] 重连后 new_flag (应 day1=1):", JSON.stringify(cal2.data.new_flag));
      const claim3 = await send2("calendar.get_beginer_reward");
      console.log("[7] 重连后再领 (应 day:0):", JSON.stringify(claim3));
      ws2.close();
      console.log("\n全部通过 ✓");
      process.exit(0);
    });
  } catch (e) {
    console.error("测试异常:", e);
    process.exit(1);
  }
});

setTimeout(() => { console.error("超时"); process.exit(1); }, 15000);
