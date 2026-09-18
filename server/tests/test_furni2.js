/**
 * 不倒翁/挂兜/装饰插花 E2E (协议级):
 *   1. BOOT_PUSH 载荷形状 (tumbler/pocket/decorate)
 *   2. 不倒翁制作链: 合页上台 → 开工 → 完工推送 + replace
 *   3. 挂兜制作链: 编绳上台 → 完工 + replace + 领取
 *   4. 挂兜攒钱 (POCKET_SEC 后 tick 推送) + pocket_get 入账
 *   5. 装饰插花: 插花/换花/扣旧花 + 绽放推送
 *
 * 前置: 服务器以 FROG_CRAFT_SEC=5 FROG_POCKET_SEC=5 FROG_DECORATE_BLOOM_SEC=5
 *       FROG_TICK_SEC=3 启动
 * 运行: node server/test_furni2.js
 */
const WebSocket = require("ws");
const http = require("http");

const URL = "ws://127.0.0.1:8080/";
const GM = "http://127.0.0.1:8000/gm/api";
const ACCOUNT = "e2e_furni2_" + Date.now();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const ws = new WebSocket(URL);
let seq = 0;
const pending = new Map();
let pushed = [];
const mark = () => pushed.length;

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
    // ---- 1. 登录链 + BOOT_PUSH ----
    await send("client.hello");
    const token = await send("hall.gen_token", { account: ACCOUNT });
    await send("hall.login", { token: token.token });
    await send("hall.enter_game");
    await send("client.load_all_info");
    const tumLoad = pushed.find((p) => p.cmd === "furniture_load_tumbler");
    const pockLoad = pushed.find((p) => p.cmd === "furniture_load_pocket");
    const decLoad = pushed.find((p) => p.cmd === "client_load_decorate");
    check("BOOT_PUSH furniture_load_tumbler 存在", !!tumLoad);
    check("BOOT_PUSH furniture_load_pocket 存在", !!pockLoad);
    check("BOOT_PUSH client_load_decorate 存在", !!decLoad);
    check("新档 tumbler_list 空", tumLoad && tumLoad.data.tumbler_list.length === 0,
      JSON.stringify(tumLoad && tumLoad.data));
    check("新档 pocket 默认 22001 展示", pockLoad && JSON.stringify(pockLoad.data.list) === "[22001]" && pockLoad.data.show_index === 1,
      JSON.stringify(pockLoad && pockLoad.data));
    check("新档 decorate 未插花", decLoad && decLoad.data.put_id === 0 && decLoad.data.status === 0 && decLoad.data.has_list.length === 0,
      JSON.stringify(decLoad && decLoad.data));

    // 图纸默认入包 (永久配方)
    const itemLoad = pushed.find((p) => p.cmd === "item_load_items");
    const house = (itemLoad && itemLoad.data.house) || [];
    check("新档默认图纸 10401/10601", house.some((x) => x.item_id === 10401) && house.some((x) => x.item_id === 10601));

    // ---- 2. 不倒翁制作链 ----
    await gm(ACCOUNT, "give_item", { item_id: 11101, count: 1 }); // 手工合页
    await gm(ACCOUNT, "give_item", { item_id: 10001, count: 2 }); // 松木
    await gm(ACCOUNT, "give_item", { item_id: 10005, count: 1 }); // 粗布
    await sleep(300); // GM 推送落盘
    let m0 = mark();
    let r = await send("furniture_putin_bench", { pos: 6, id: 11101 });
    check("合页上台自动开工 crafting:1", r.code === 0 && r.crafting === 1, JSON.stringify(r));
    // 完工 (FROG_CRAFT_SEC=5 + tick 3s → ~10s 内)
    let done = null;
    for (let i = 0; i < 20 && !done; i++) {
      await sleep(1000);
      done = pushed.slice(m0).find((p) => p.cmd === "furniture_load_tumbler" && p.data.tumbler_list.length === 1);
    }
    check("不倒翁完工推送 tumbler_list+1", !!done, done ? JSON.stringify(done.data.tumbler_list[0]) : "超时");
    const tum = done && done.data.tumbler_list[0];
    if (tum) {
      check("tumbler layers 1-4 层且每层 5 值", tum.layers.length >= 1 && tum.layers.length <= 4 && tum.layers.every((l) => l.layer.length === 5),
        `${tum.id} ${tum.layers.length}层`);
    }
    const evt = pushed.slice(m0).find((p) => p.cmd === "notify_new_event" && p.data.event && p.data.event.evt_type === 21);
    check("FurnitureFinish evt_id=模板id (非 21)", !!evt && evt.data.event.evt_id === (tum && tum.id),
      evt ? `evt_id=${evt.data.event.evt_id} evt_value[0]=${evt.data.event.evt_value[0]}` : "无事件");

    // replace_tumbler 语义
    r = await send("furniture_replace_tumbler", { index: 1 });
    check("replace_tumbler 展示 code=0", r.code === 0, JSON.stringify(r));
    r = await send("furniture_replace_tumbler", { index: 1 });
    check("replace_tumbler 同只再点 code=1", r.code === 1, JSON.stringify(r));
    r = await send("furniture_replace_tumbler", { index: 99 });
    check("replace_tumbler 越界 code=-1", r.code === -1, JSON.stringify(r));

    // ---- 3. 挂兜制作链 ----
    await gm(ACCOUNT, "give_item", { item_id: 11102, count: 1 }); // 彩色编绳
    await gm(ACCOUNT, "give_item", { item_id: 10005, count: 2 }); // 粗布
    await sleep(300);
    const pockBefore = (await send("furniture_load_pocket", {})).list;
    m0 = mark();
    r = await send("furniture_putin_bench", { pos: 6, id: 11102 });
    check("编绳上台自动开工 crafting:1", r.code === 0 && r.crafting === 1, JSON.stringify(r));
    let pockDone = null;
    for (let i = 0; i < 20 && !pockDone; i++) {
      await sleep(1000);
      pockDone = pushed.slice(m0).find((p) => p.cmd === "furniture_load_pocket" && p.data.list.length === pockBefore.length + 1);
    }
    check("挂兜完工推送 list+1", !!pockDone, pockDone ? JSON.stringify(pockDone.data.list) : "超时");
    const newPocket = pockDone && pockDone.data.list[pockDone.data.list.length - 1];
    check("新挂兜是可制作款", [22011, 22012, 22013, 22021, 22031].includes(newPocket), String(newPocket));
    const evt2 = pushed.slice(m0).find((p) => p.cmd === "notify_new_event" && p.data.event && p.data.event.evt_type === 21);
    check("挂兜 FurnitureFinish evt_id=挂兜id", !!evt2 && evt2.data.event.evt_id === newPocket,
      evt2 ? `evt_id=${evt2.data.event.evt_id}` : "无事件");

    // replace_pocket: 切到新款
    const newIdx = pockDone.data.list.indexOf(newPocket) + 1;
    r = await send("furniture_replace_pocket", { index: newIdx });
    check("replace_pocket 换款 code=0", r.code === 0, JSON.stringify(r));
    r = await send("furniture_replace_pocket", { index: newIdx });
    check("replace_pocket 同款再点 code=1", r.code === 1, JSON.stringify(r));
    r = await send("furniture_replace_pocket", { index: 1 });
    check("replace_pocket 切回 code=0", r.code === 0, JSON.stringify(r));

    // ---- 4. 挂兜攒钱 + 领取 ----
    // 展示中 (index 1), FROG_POCKET_SEC=5 + tick 3s → ~10s 内攒草推送
    await sleep(4000);
    let pockNow = await send("furniture_load_pocket", {});
    if (!(pockNow.clover > 0)) {
      for (let i = 0; i < 15 && !(pockNow.clover > 0); i++) {
        await sleep(1000);
        pockNow = await send("furniture_load_pocket", {});
      }
    }
    check("挂兜展示中攒草 >0", pockNow.clover > 0, `clover=${pockNow.clover}`);
    const cloverBefore = (pushed.find((p) => p.cmd === "clover_load_clovers"), null); // 占位
    const roleResp = await send("furniture_pocket_get", {});
    check("pocket_get code=0", roleResp.code === 0, JSON.stringify(roleResp));
    const cloverUpd = pushed.filter((p) => p.cmd === "clover_update").pop();
    check("pocket_get 推 clover_update", !!cloverUpd, cloverUpd ? `clover=${cloverUpd.data.clover}` : "无");
    const pockAfter = await send("furniture_load_pocket", {});
    check("领取后 clover 清零", pockAfter.clover === 0, `clover=${pockAfter.clover}`);
    r = await send("furniture_pocket_get", {});
    check("空兜再领 code=1", r.code === 1, JSON.stringify(r));

    // ---- 5. 装饰插花 ----
    await gm(ACCOUNT, "give_item", { item_id: 202211, count: 2 }); // 角堇·火龙果
    await gm(ACCOUNT, "give_item", { item_id: 202101, count: 1 }); // 蜡梅
    await sleep(300);
    let dec = await send("client_change_decorate", { id: 10011 }); // 角堇
    check("插角堇 code=0", dec.code === 0, JSON.stringify(dec));
    let decPush = pushed.filter((p) => p.cmd === "client_load_decorate").pop();
    check("插花推送 put_id=10011 status=1", decPush && decPush.data.put_id === 10011 && decPush.data.status === 1,
      JSON.stringify(decPush && decPush.data));
    check("插花不消耗库存 (has_list 角堇 num=2)", decPush && decPush.data.has_list.some((x) => x.id === 10011 && x.num === 2),
      JSON.stringify(decPush && decPush.data.has_list));
    // 换蜡梅 → 旧花扣 1
    dec = await send("client_change_decorate", { id: 100 }); // 蜡梅
    check("换蜡梅 code=0", dec.code === 0, JSON.stringify(dec));
    decPush = pushed.filter((p) => p.cmd === "client_load_decorate").pop();
    check("换花后角堇 num=1 (旧花用掉)", decPush && decPush.data.has_list.some((x) => x.id === 10011 && x.num === 1),
      JSON.stringify(decPush && decPush.data.has_list));
    check("put_id 换成蜡梅 100", decPush && decPush.data.put_id === 100, JSON.stringify(decPush && decPush.data.put_id));
    // 没有的花拒绝
    dec = await send("client_change_decorate", { id: 1002 });
    check("没这朵花 code=2", dec.code === 2, JSON.stringify(dec));
    // 绽放 (BLOOM_SEC=5 + tick 3s)
    let bloom = null;
    for (let i = 0; i < 15 && !bloom; i++) {
      await sleep(1000);
      bloom = pushed.filter((p) => p.cmd === "client_load_decorate").find((p) => p.data.put_id === 100 && p.data.status === 2);
    }
    check("蜡梅绽放 status=2 推送", !!bloom, bloom ? JSON.stringify(bloom.data) : "超时");

    console.log(`\n结果: ${pass} pass / ${fail} fail`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("E2E 异常:", e);
    process.exit(1);
  }
});

ws.on("error", (e) => { console.error("WS 错误:", e.message); process.exit(1); });
