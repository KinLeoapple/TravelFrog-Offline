/** 模拟客户端: 走登录链并 dump 服务器推送, 验证 furniture 载荷 */
const WebSocket = require("ws");

const ws = new WebSocket("ws://127.0.0.1:8080");
let session = 0;

function send(cmd, data) {
  session++;
  // 真实客户端: 仅第一个下划线换成点 (SocketManage.send 逆向)
  const c = cmd.indexOf("_") >= 0 ? cmd.replace("_", ".") : cmd;
  ws.send(JSON.stringify({ session, timestamp: Math.floor(Date.now() / 1000), cmd: c, data: data || {} }));
  return session;
}

ws.on("open", () => {
  console.log("已连接");
  send("client_hello");
  send("hall_gen_token", { account: "probe_test" });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.session != null) {
    console.log(`\n[resp session=${msg.session}]`, JSON.stringify(msg.data).slice(0, 150));
    if (msg.session === 2 && msg.data.token) send("hall_login", { token: msg.data.token });
    if (msg.session === 3) send("hall_enter_game");
    if (msg.session === 4) send("client_load_all_info");
  } else if (msg.cmd === "furniture_load_furniture") {
    console.log(`\n[push] ${msg.cmd} <<<<<< 重点检查`);
    console.log(JSON.stringify(msg.data, null, 2));
    console.log("put_fur 类型:", typeof msg.data.put_fur, Array.isArray(msg.data.put_fur) ? "Array OK" : "??");
  } else {
    console.log(`[push] ${msg.cmd} keys=${Object.keys(msg.data || {}).join(",")}`);
  }
});

setTimeout(() => { console.log("\n--- 8s 到时退出 ---"); process.exit(0); }, 8000);
