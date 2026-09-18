/**
 * 同步修复回归测试: 收割推送 / 商店购买 / resend 裸数组 / 限购持久化
 */
const WebSocket = require("ws");
const ACCOUNT = "sync_test_" + Date.now();

function connect(account) {
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:8080");
    const ctx = { ws, seq: 0, pending: new Map(), pushed: [] };
    ctx.send = (cmd, data) => new Promise((res) => {
      const s = ++ctx.seq;
      ctx.pending.set(s, res);
      ws.send(JSON.stringify({ session: s, timestamp: Date.now(), cmd, data: data || {} }));
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.session != null && ctx.pending.has(m.session)) { ctx.pending.get(m.session)(m.data); ctx.pending.delete(m.session); }
      else if (m.cmd) ctx.pushed.push(m);
    });
    ws.on("open", async () => {
      const t = await ctx.send("hall.gen_token", { account });
      await ctx.send("hall.login", { token: t.token });
      await ctx.send("hall.enter_game");
      await ctx.send("client.load_all_info");
      resolve(ctx);
    });
  });
}

(async () => {
  const ctx = await connect(ACCOUNT);
  const s = ctx.save = { pushed: ctx.pushed };
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    cond ? pass++ : fail++;
  };

  // 1. 初始状态
  const role = ctx.pushed.find((p) => p.cmd === "client_load_role");
  const clover0 = role.data.res.clover_point;
  check("初始货币 = 官方 9999", clover0 === 9999, `clover=${clover0}`);

  // 2. 收割槽位 1 (refreshClovers 后应立即可收)
  const pushedBefore = ctx.pushed.length;
  const h = await ctx.send("clover.harvest", { clover_id: 1 });
  const cloverUpd = ctx.pushed.slice(pushedBefore).find((p) => p.cmd === "clover_update");
  check("收割响应 code=0", h.code === 0, JSON.stringify(h));
  check("收割推送 clover_update (+1)", !!cloverUpd && cloverUpd.data.clover === clover0 + 1,
    cloverUpd ? `clover=${cloverUpd.data.clover}` : "无推送");

  // 3. 重复收割 (未成熟) 应拒绝且无重复入账
  const before2 = ctx.pushed.length;
  const h2 = await ctx.send("clover.harvest", { clover_id: 1 });
  const upd2 = ctx.pushed.slice(before2).filter((p) => p.cmd === "clover_update");
  check("未成熟重复收割拒绝", h2.code !== 0, `code=${h2.code}`);
  check("拒绝时无入账推送", upd2.length === 0);

  // 4. resend: 响应必须是裸数组
  const r = await ctx.send("clover.harvest_resend", { list: [{ clover_id: 2, time: Math.floor(Date.now() / 1000) }] });
  check("resend 响应为裸数组", Array.isArray(r), `typeof=${Array.isArray(r) ? "array(" + r.length + ")" : typeof r}`);
  const upd4 = ctx.pushed.slice(before2).filter((p) => p.cmd === "clover_update");
  check("resend 补记账 slot2 (+1)", upd4.length > 0 && upd4[upd4.length - 1].data.clover === clover0 + 2);

  // 5. 商店购买: slot 3 (茄汁蛋包饭, price 80)
  const before5 = ctx.pushed.length;
  const b = await ctx.send("item.buy", { shop_id: 3 });
  const after5 = ctx.pushed.slice(before5);
  const cu5 = after5.find((p) => p.cmd === "clover_update");
  const iu5 = after5.find((p) => p.cmd === "item_update");
  check("购买成功 code=0", b.code === 0, JSON.stringify(b));
  check("购买推送 clover_update (-80)", !!cu5 && cu5.data.clover === clover0 + 2 - 80, cu5 ? `clover=${cu5.data.clover}` : "无");
  check("购买推送 item_update", !!iu5 && iu5.data.item.item_id === 3, iu5 ? JSON.stringify(iu5.data.item) : "无");

  // 6. 未知货架位拒绝 + 回滚推送
  const before6 = ctx.pushed.length;
  const b2 = await ctx.send("item.buy", { shop_id: 999 });
  const cu6 = ctx.pushed.slice(before6).find((p) => p.cmd === "clover_update");
  check("未知货架拒绝", b2.code !== 0);
  check("拒绝时回滚 clover_update", !!cu6);

  // 7. 重连: 限购/已购恢复 + 货币持久化
  ctx.ws.close();
  await new Promise((r2) => setTimeout(r2, 1200));
  const ctx2 = await connect(ACCOUNT);
  await ctx2.send("item.load_shop_info");
  const role2 = ctx2.pushed.find((p) => p.cmd === "client_load_role");
  check("重连货币持久化", role2.data.res.clover_point === clover0 + 2 - 80, `clover=${role2.data.res.clover_point}`);
  const slot3 = ctx2.pushed.find((p) => p.cmd === "item_load_items");
  const item3 = slot3 && slot3.data.house.find((x) => x.item_id === 3);
  check("购买物品已入档", !!item3 && item3.count === 1, item3 ? JSON.stringify(item3) : "无 item 3");

  ctx2.ws.close();
  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
setTimeout(() => { console.error("超时"); process.exit(1); }, 15000);
