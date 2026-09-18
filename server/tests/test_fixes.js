/**
 * P6/P7/P8/P9/P10/P12 修复验证:
 *   A. 进程内单测: P12 make 门控 (pattern 0/1/2 全枚举, 确定性)
 *   B. WS 线上 E2E: 日历签到/幸运日、抽奖、邮件入账、伙伴告别邮件、伙伴笔记、栽培收获
 *
 * 前置: 服务器以 FROG_MOTION_SEC=5 启动 (本测试自身连 ws://127.0.0.1:8080)
 * 运行: node test_fixes.js
 */
const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");

const saveMod = require("../save");
const travel = require("../travel");
const handlersMod = require("../handlers");
const flowerpot = require("../flowerpot");
const furni = require("../furni");

const URL = "ws://127.0.0.1:8080/";
const GM = "http://127.0.0.1:8000/gm/api";
const ACCOUNT = "e2e_fix_" + Date.now();
const DAY_BASE = 946656000; // 客户端 core.BaseTime (2000-01-01 UTC)
const utcDay = (ts) => Math.floor((ts - DAY_BASE) / 86400);

const PRIZE_TABLE = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "resource", "China", "config", "MainData", "Prize.json"), "utf-8"
));

// P7 期望映射 (与 flowerpot.PLANT_HARVEST 同源, 测试侧独立复算)
const PLANT_HARVEST = [
  ["拇指萝卜", 4101], ["樱桃萝卜", 4102], ["樱桃番茄", 4103],
  ["迷你南瓜", 4104], ["草莓", 4006],
];
const plantName = (id) => {
  const t = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "resource", "China", "config", "Furnitur", "flowerpotData.json"), "utf-8"));
  return (t.plant[String(id)] || {}).name || "";
};
// P13 花类期望: Item.json 与植物同名的 type14 插花物品 (种什么花收什么花)
const ITEM_ARR = (() => {
  const t = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "resource", "China", "config", "MainData", "Item.json"), "utf-8"));
  return Array.isArray(t) ? t : Object.keys(t).map((k) => t[k]);
})();
const expectHarvest = (id) => {
  const name = plantName(id);
  for (const [prefix, itemId] of PLANT_HARVEST) if (name.indexOf(prefix) === 0) return itemId;
  const fl = ITEM_ARR.find((i) => i && i.name === name && Number(i.type) === 14);
  return fl ? Number(fl.id) : 4020;
};

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

// ---------- A. P12 进程内单测: make 门控 ----------
function unitP12() {
  const step = (s, n) => { travel.refreshFrogMotion(s, n); return s.frog.motion; };
  const FROG_MOTION_SEC = travel.PACE ? null : null; // 未导出, 用足够大的步进
  const DT = 60; // > 默认 45s 动作时长
  // 固定白天 (避免夜间 sleep motion 10-13 干扰 make 门控判定)
  const origGetHours = Date.prototype.getHours;
  Date.prototype.getHours = () => 12;

  // 未解锁: merchant null / 空对象 → 三种 pattern 全步进, motion 永不=3
  for (const merchant of [null, {}]) {
    for (let pattern = 0; pattern < 3; pattern++) {
      const s = saveMod.newSave("unit_p12");
      s.merchant = merchant;
      s.frog.motionPattern = pattern;
      s.frog.motionStep = -1;
      const seen = new Set();
      for (let i = 0; i < 13; i++) seen.add(step(s, i * DT + 1));
      check(`P12 未解锁 merchant=${merchant === null ? "null" : "{}"} pattern${pattern} 无 make`, !seen.has(3),
        `motions=[${[...seen].join(",")}]`);
    }
  }
  // 已解锁 (lastVisit>0 / shop 在场): pattern0/2 出现 make, pattern1 本就无 make
  for (const merchant of [{ lastVisit: 12345 }, { shop: { start_time: 1, leave_time: 2, shop_list: [] } }]) {
    for (let pattern = 0; pattern < 3; pattern++) {
      const s = saveMod.newSave("unit_p12");
      s.merchant = merchant;
      s.frog.motionPattern = pattern;
      s.frog.motionStep = -1;
      const seen = new Set();
      for (let i = 0; i < 13; i++) seen.add(step(s, i * DT + 1));
      const want = pattern !== 1; // pattern1 序列无 make token (官方序列如此)
      check(`P12 已解锁 pattern${pattern} make=${want ? "出现" : "不出现"}`, seen.has(3) === want,
        `motions=[${[...seen].join(",")}]`);
    }
  }
  Date.prototype.getHours = origGetHours;
}

// ---------- A2. P13 进程内单测: 笔记可见性 + 收获不重置视角 ----------
function unitP13() {
  // Part 1: 前提 — Note.json 存在无 type 的 attach 子笔记 (客户端任何 tab 不显示)
  const noteTable = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "resource", "China", "config", "TravelNote", "Note.json"), "utf-8"));
  const all = Array.isArray(noteTable) ? noteTable : Object.keys(noteTable).map((k) => noteTable[k]);
  const invisible = all.filter((n) => n.type !== 1 && n.type !== 2).map((n) => n.id);
  const visible = all.filter((n) => n.type === 1 || n.type === 2).map((n) => n.id);
  check("P13 前提: Note.json 含不可见 attach 子笔记", invisible.length > 0, `count=${invisible.length}`);

  // Part 2: randomNoteId 只抽可见笔记 (300 次抽样)
  let bad = 0;
  for (let i = 0; i < 300; i++) if (invisible.includes(travel.randomNoteId())) bad++;
  check("P13 randomNoteId 300 次抽样无不可见 id", bad === 0, `bad=${bad}`);

  // Part 3: load() 迁移剔除历史误发的不可见笔记
  const acc = "unit_p13_" + Date.now();
  const file = path.join(__dirname, "..", "data", "user", acc + ".json");
  const s0 = saveMod.newSave(acc);
  s0.note_list = [
    { id: invisible[0], read: 0, timestamp: 1 },
    { id: invisible[1] || invisible[0], read: 0, timestamp: 2 },
    { id: visible[0], read: 0, timestamp: 3 },
  ];
  fs.writeFileSync(file, JSON.stringify(s0));
  const s1 = saveMod.load(acc);
  check("P13 load 剔除不可见笔记保留可见",
    s1.note_list.length === 1 && s1.note_list[0].id === visible[0],
    JSON.stringify(s1.note_list.map((n) => n.id)));
  fs.unlinkSync(file);

  // Part 4: 收获 handler 不推 client_load_role (庭院视角不被拉回居中)
  // 注意: 播种时间基准用非 0 (plantedAt=0 是 falsy, tick 里 || now 会当成未播种)
  // 预填堆肥格: 升阶要吸收堆肥 (空盒=贫瘠会冻结生长), 否则推不到 stage 3
  const hs = saveMod.newSave("unit_p13b");
  furni.node(hs).compost.boxes = [10001, 10001, 10001, 10001, 10001, 10001];
  flowerpot.flowerpotTick(hs, 1000);                                    // 空槽自动播种
  flowerpot.flowerpotTick(hs, 1000 + flowerpot.PLANT_STAGE_SEC * 2);    // 推进到 stage 3
  const pushed = [];
  const r = handlersMod.handlers["furniture_flowerpot_harvest"](
    { save: hs, push: (cmd) => pushed.push(cmd) }, { index: 1 });
  check("P13 收获响应含产物 item_list", r.item_list && r.item_list.length === 1, JSON.stringify(r));
  check("P13 收获推送不含 client_load_role (视角不回中)", !pushed.includes("client_load_role"),
    `pushed=[${pushed.join(",")}]`);
  check("P13 收获仍推 item_update + item_load_handbook",
    pushed.includes("item_update") && pushed.includes("item_load_handbook"), `pushed=[${pushed.join(",")}]`);

  // Part 5: 花类收获同名插花物品 (35 种植物全遍历) + 图鉴分类
  let flowerOk = 0, flowerTotal = 0, vegOk = 0, mapErr = "";
  const vegSet = new Set(PLANT_HARVEST.map(([, id]) => id));
  for (const pid of flowerpot.FLOWER_PLANTS) {
    const h5 = saveMod.newSave("unit_p13c");
    h5.flowerpot = { slots: [{ id: pid, stage: 3, plantedAt: 1 }], grown: [] };
    const rv = flowerpot.harvest(h5, 1);
    const got = rv.item_list && rv.item_list[0] && rv.item_list[0].item_id;
    if (vegSet.has(got)) { vegOk++; continue; }
    flowerTotal++;
    const want = ITEM_ARR.find((i) => i && i.name === plantName(pid) && Number(i.type) === 14);
    if (want && Number(want.id) === got) flowerOk++;
    else mapErr += `${pid}(${plantName(pid)})→${got}(want=${want && want.id}) `;
  }
  check("P13 花类收获=同名插花物品 (20 品种)", flowerTotal > 0 && flowerOk === flowerTotal,
    `ok=${flowerOk}/${flowerTotal} ${mapErr}`);
  check("P13 蔬菜类收获=对应特产 (15 品种)", vegOk === 15, `vegOk=${vegOk}`);
  // 图鉴分类: 花不入 specialtys (插花走花园图鉴), 蔬菜入 specialtys
  const hF = saveMod.newSave("unit_p13d");
  hF.flowerpot = { slots: [{ id: 2010101, stage: 3, plantedAt: 1 }], grown: [] };
  const rvF = flowerpot.harvest(hF, 1);
  check("P13 花收获不记特产图鉴", rvF.item_list[0].item_id === 202211
    && !(hF.handbook.specialtys || []).includes(202211), JSON.stringify(hF.handbook.specialtys));
  const hV = saveMod.newSave("unit_p13e");
  hV.flowerpot = { slots: [{ id: 2010301, stage: 3, plantedAt: 1 }], grown: [] };
  const rvV = flowerpot.harvest(hV, 1);
  check("P13 蔬菜收获记特产图鉴", rvV.item_list[0].item_id === 4101
    && (hV.handbook.specialtys || []).includes(4101), JSON.stringify(hV.handbook.specialtys));
}

// ---------- A3. P14 进程内单测: 邮件已读状态持久化 ----------
function unitP14() {
  // Part 1: mail_read 直接标记邮件对象 (客户端 mail_load 全量推送整体替换列表)
  const hs = saveMod.newSave("unit_p14");
  hs.mailSeq = 2;
  hs.mails = [
    { id: 1, type: 3, title: "a", read: false, opened: false },
    { id: 2, type: 3, title: "b", read: false, opened: false },
  ];
  handlersMod.handlers["mail_read"]({ save: hs }, { id: 1 });
  check("P14 mail_read 标记邮件对象 read", hs.mails[0].read === true && hs.mails[1].read !== true,
    JSON.stringify(hs.mails.map((m) => [m.id, m.read])));

  // Part 2: load 迁移旧版 mails_read 旁路字典 → 回填邮件对象后清空
  const acc = "unit_p14_" + Date.now();
  const file = path.join(__dirname, "..", "data", "user", acc + ".json");
  const s0 = saveMod.newSave(acc);
  s0.mailSeq = 2;
  s0.mails = [
    { id: 1, type: 3, title: "a", read: false, opened: false },
    { id: 2, type: 3, title: "b", read: false, opened: false },
  ];
  s0.mails_read = { 1: true }; // 旧版: 已读只记在字典
  fs.writeFileSync(file, JSON.stringify(s0));
  const s1 = saveMod.load(acc);
  check("P14 load 迁移 mails_read 回填邮件",
    s1.mails[0].read === true && s1.mails[1].read !== true,
    JSON.stringify(s1.mails.map((m) => [m.id, m.read])));
  check("P14 load 迁移后字典清空", !Object.keys(s1.mails_read || {}).length,
    JSON.stringify(s1.mails_read));
  fs.unlinkSync(file);
}

// ---------- A4. P15 进程内单测: mail_open 领取即删除 ----------
function unitP15() {
  const hs = saveMod.newSave("unit_p15");
  hs.mailSeq = 3;
  const base = hs.res.clover_point;
  hs.mails = [
    { id: 1, type: 3, title: "a", read: true, opened: true, resource: { clover_point: 22 } },
    { id: 2, type: 3, title: "b", read: false, opened: false, items: [{ item_id: 4101, count: 2 }] },
    { id: 3, type: 3, title: "c", read: false, opened: false },
  ];
  const pushed = [];
  handlersMod.handlers["mail_open"]({ save: hs, push: (c, d) => pushed.push([c, d]) }, { id: 1 });
  check("P15 mail_open 附件三叶草入账+推送", hs.res.clover_point === base + 22
    && pushed.some((x) => x[0] === "clover_update"), `${base}→${hs.res.clover_point}`);
  handlersMod.handlers["mail_open"]({ save: hs, push: (c, d) => pushed.push([c, d]) }, { id: 2 });
  check("P15 mail_open 附件物品入账+推送",
    (hs.items.house.find((x) => x.item_id === 4101) || {}).count === 2
    && pushed.some((x) => x[0] === "item_update"), `pushed=[${pushed.map((x) => x[0]).join(",")}]`);
  check("P15 mail_open 删除已领取邮件", hs.mails.length === 1 && hs.mails[0].id === 3,
    JSON.stringify(hs.mails.map((m) => m.id)));
  handlersMod.handlers["mail_open"]({ save: hs, push: () => {} }, { id: 99 });
  check("P15 mail_open 未找到邮件容错", hs.mails.length === 1);
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

// 等待某条件在推送流中成立 (轮询 pushes)
async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = cond();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}

(async () => {
  unitP12();
  unitP13();
  unitP14();
  unitP15();

  const ws = new WebSocket(URL);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let role = null;
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.session != null) {
      const resolve = pending.get(msg.session);
      if (resolve) { pending.delete(msg.session); resolve(msg.data); }
    } else if (msg.cmd) {
      msg._at = Date.now(); // 到达时刻 (P11 出发时序断言用)
      pushes.push(msg);
      if (msg.cmd === "client_load_role") role = msg.data;
    }
  });

  // --- 登录 ---
  const token = await send(ws, "hall.gen_token", { account: ACCOUNT });
  check("登录 gen_token", token.code === 0, JSON.stringify(token).slice(0, 80));
  const enter = await send(ws, "hall.enter_game", {});
  check("enter_game", enter.code === 0);
  await send(ws, "client.load_all_info", {});
  const cal = await waitFor(() => byCmd("calendar_load")[0], 5000);
  check("收到 calendar_load", !!cal);
  const createTime = role ? role.frog && role.create_time : 0; // role 里可能无此字段, 后备 GM status

  // --- P6: 新手签到 ---
  const day = utcDay(Date.now() / 1000) - utcDay((cal && cal._create) || Date.now() / 1000) + 1; // 新号=1
  check("P6 lucky_days 是对象数组", Array.isArray(cal.lucky_days)
    && cal.lucky_days.every((d) => typeof d.day === "number" && typeof d.item_id === "number"),
    JSON.stringify(cal.lucky_days));
  check("P6 lucky_days 最多 3 天", cal.lucky_days.length <= 3, `len=${cal.lucky_days.length}`);
  const beginner1 = await send(ws, "calendar_get_beginer_reward", {});
  check("P6 首签 day=1 (UTC自然日)", beginner1.code === 0 && beginner1.day === 1, JSON.stringify(beginner1));
  const itemUpd = await waitFor(() => byCmd("item_update").find((u) => u.item && u.item.item_id === 1201), 5000);
  check("P6 day1 奖励 幸运花1201 已入账 (item_update)", !!itemUpd, JSON.stringify(itemUpd || null));
  const beginner2 = await send(ws, "calendar_get_beginer_reward", {});
  check("P6 重复领取被拒 day=0", beginner2.day === 0, JSON.stringify(beginner2));

  // --- P6: 幸运日 ---
  const todayLucky = cal.lucky_days.find((d) => d.day === new Date().getDate());
  const luck = await send(ws, "calendar_get_luck_reward", {});
  if (todayLucky) {
    check("P6 今日幸运可领 code=0", luck.code === 0, JSON.stringify(luck));
  } else {
    check("P6 非幸运日 code=1", luck.code === 1, JSON.stringify(luck));
  }

  // --- P8: 抽奖 ---
  const tk = await gm(ACCOUNT, "add_ticket", { n: 10 });
  check("GM add_ticket", tk.ok, tk.info);
  await sleep(500);
  let tickets = (byCmd("item_update_ticket").pop() || {}).ticket;
  check("P8 券余额=10", tickets === 10, `ticket=${tickets}`);
  const gacha = await send(ws, "item_gacha", {});
  const rank = gacha.ticket;
  check("P8 item_gacha 返回球 rank 0..5", gacha.code === 0 && Number.isInteger(rank) && rank >= 0 && rank <= 5, JSON.stringify(gacha));
  await sleep(500);
  tickets = (byCmd("item_update_ticket").pop() || {}).ticket;
  check("P8 抽奖扣 5 券", tickets === 5, `ticket=${tickets}`);
  const prize = PRIZE_TABLE.find((p) => Number(p.rank) === rank);
  const redeem = await send(ws, "item_redeem_prize", { prize_id: prize.id });
  check("P8 兑换 code=0", redeem.code === 0, JSON.stringify(redeem));
  await sleep(500);
  if (rank === 0) {
    tickets = (byCmd("item_update_ticket").pop() || {}).ticket;
    check("P8 白球→+1 券", tickets === 6, `ticket=${tickets}`);
  } else {
    const got = byCmd("item_update").find((u) => u.item && u.item.item_id === Number(prize.itemId));
    check("P8 彩球→物品入账", !!got, JSON.stringify(got || null));
  }
  const gacha2 = await send(ws, "item_gacha", { is_reward: true });
  check("P8 is_reward 免费抽", gacha2.code === 0 && Number.isInteger(gacha2.ticket), JSON.stringify(gacha2));

  // --- P9: GM 邮件附件入账 ---
  await gm(ACCOUNT, "add_clover", { n: 1 }); // 建立 clover_update 基线推送
  await sleep(500);
  const cloverBefore = (byCmd("clover_update").pop() || {}).clover;
  const mn = await gm(ACCOUNT, "mail_new", { n: 1 });
  check("GM mail_new", mn.ok, mn.info);
  const mails = await waitFor(() => byCmd("mail_load").pop(), 5000);
  check("mail_load 推送", Array.isArray(mails) && mails.length >= 1);
  const gmMail = mails[mails.length - 1];
  const mo = await send(ws, "mail_open", { id: gmMail.id });
  check("P9 mail_open code=0", mo.code === 0);
  const cloverAfter = await waitFor(() => {
    const c = (byCmd("clover_update").pop() || {}).clover;
    return c != null && c !== cloverBefore ? c : null;
  }, 5000);
  check("P9 邮件附件 100 三叶草入账", cloverAfter === cloverBefore + 100, `${cloverBefore}→${cloverAfter}`);

  // --- P9: 伙伴投喂→离开→感谢邮件 ---
  const gc = await gm(ACCOUNT, "guest_come", { id: 0 });
  check("GM guest_come", gc.ok, gc.info);
  const gi = await gm(ACCOUNT, "give_item", { item_id: 4101, count: 3 });
  check("GM give_item 4101", gi.ok, gi.info);
  const serve = await send(ws, "guest_serve", { id: 0, item_id: 4101 });
  check("guest_serve code=0", serve.code === 0);
  // 投喂后 20s 送客窗口 + 30s tick → 最长 ~60s
  const farewell = await waitFor(() => {
    const ml = byCmd("mail_load").pop();
    return ml && ml.find((m) => m.title === "谢谢款待");
  }, 75000, "farewell mail");
  check("P9 告别邮件到达 (投喂后自动送客)", !!farewell, farewell ? `sender=${farewell.sender}` : "timeout");
  if (farewell) {
    check("P9 告别邮件 sender=伙伴id(0)", farewell.sender === 0, `sender=${farewell.sender}`);
    const cb = (byCmd("clover_update").pop() || {}).clover;
    const fo = await send(ws, "mail_open", { id: farewell.id });
    const ca = await waitFor(() => {
      const c = (byCmd("clover_update").pop() || {}).clover;
      return c != null && c !== cb ? c : null;
    }, 5000);
    check("P9 告别邮件附件 10~30 三叶草入账", ca != null && ca >= cb + 10 && ca <= cb + 30, `${cb}→${ca}`);
  }

  // --- P14: 已读未拆邮件在全量推送中保持已读 ---
  const loadCnt0 = byCmd("mail_load").length;
  await gm(ACCOUNT, "mail_new", { n: 1 });
  const mailsA = await waitFor(() => (byCmd("mail_load").length > loadCnt0
    ? byCmd("mail_load").pop() : null), 5000);
  const target = mailsA && mailsA[mailsA.length - 1];
  check("P14 前提: 新邮件到达触发 mail_load 全量推送", !!target,
    target ? `id=${target.id} total=${mailsA.length}` : "timeout");
  // --- P15 E2E: 已领取 (mail_open) 邮件不再出现在任何 mail_load 全量推送 ---
  check("P15 已领取 GM 邮件不再出现在 mail_load", !mailsA.some((m) => m.id === gmMail.id),
    `ids=[${mailsA.map((m) => m.id).join(",")}]`);
  if (farewell) check("P15 已领取告别邮件不再出现在 mail_load",
    !mailsA.some((m) => m.id === farewell.id));
  const rd = await send(ws, "mail_read", { id: target.id });
  check("P14 mail_read code=0", rd.code === 0, JSON.stringify(rd));
  const loadCnt1 = byCmd("mail_load").length;
  await gm(ACCOUNT, "mail_new", { n: 1 }); // 再来一封 → 再次全量推送
  const mailsB = await waitFor(() => (byCmd("mail_load").length > loadCnt1
    ? byCmd("mail_load").pop() : null), 5000);
  const t2 = mailsB && mailsB.find((m) => m.id === target.id);
  check("P14 已读未拆邮件全量推送保持 read=true", t2 && t2.read === true,
    JSON.stringify(t2));

  // --- P10: 旅行伙伴笔记 2000-2002 ---
  let friendNote = null;
  for (let i = 0; i < 12 && !friendNote; i++) {
    const dep = await gm(ACCOUNT, "frog_stray", {});
    if (!dep.ok) { console.log("  frog_stray:", dep.info); break; }
    await waitFor(() => role && role.frog.status === 1, 10000);
    const home = await gm(ACCOUNT, "frog_home", {});
    if (!home.ok) { console.log("  frog_home:", home.info); break; }
    friendNote = await waitFor(() => {
      const nl = byCmd("travel_load_note").pop();
      return nl && nl.note_list.find((n) => n.id >= 2000 && n.id <= 2002);
    }, 6000);
  }
  check("P10 旅行伙伴笔记 2000-2002 (40%/次, 12次)", !!friendNote, friendNote ? `id=${friendNote.id}` : "未出现(1.7%概率内)");

  // --- P7: 栽培收获产物映射 ---
  const fg = await gm(ACCOUNT, "flowerpot_grown", {});
  check("GM flowerpot_grown", fg.ok, fg.info);
  const fp = await waitFor(() => byCmd("furniture_load_flowerpot").pop(), 5000);
  const slot1 = fp && fp.plant_list.find((p) => p.index === 1);
  check("花盆 1 号槽成熟", !!slot1 && slot1.stage === 3, JSON.stringify(slot1));
  const want = expectHarvest(slot1.id);
  const pushBase = pushes.length; // P13 基线: 收获请求推送序列起点
  const hv = await send(ws, "furniture_flowerpot_harvest", { index: 1 });
  const gotItem = hv && hv.item_list && hv.item_list[0];
  check("P7 收获产物=种植对应物", gotItem && gotItem.item_id === want,
    `plant=${slot1.id}(${plantName(slot1.id)}) want=${want} got=${gotItem ? gotItem.item_id : "none"}`);
  // --- P13 E2E: 收获推送序列不含 client_load_role (庭院视角不被拉回居中) ---
  // 判定: role 不得出现在 item_update 之后 —— handler 同步执行, tick 竞态的 role
  // 只会在 item_update 之前 (Node 单线程, 请求处理中途不会插入 tick)
  const afterHv = pushes.slice(pushBase);
  const idxUpd = afterHv.findIndex((p) => p.cmd === "item_update");
  const roleLate = idxUpd >= 0 && afterHv.some((p, i) => p.cmd === "client_load_role" && i > idxUpd);
  check("P13 E2E 收获推送无 client_load_role (视角不回中)", !roleLate,
    `cmds=[${afterHv.map((p) => p.cmd).join(",")}]`);

  // --- P13 E2E: 动作轮换推送 (蛙在家, FROG_MOTION_SEC=5, 16s ≥ 3 个轮换周期) ---
  // 动作轮换实时推送 client_load_role 让客户端切换蛙动画:
  //   旧设计「不推送」导致会话内只看到一种动作, 已改为推送
  const quietBase = pushes.length;
  const tQ = Date.now();
  while (Date.now() - tQ < 16000) await sleep(1000);
  const quiet = pushes.slice(quietBase);
  check("P13 E2E 动作轮换推送 client_load_role (蛙动画实时切换)",
    quiet.some((p) => p.cmd === "client_load_role"),
    `cmds=[${[...new Set(quiet.map((p) => p.cmd))].join(",")}]`);

  // --- P12 被动观察: 重登快照 motion ≠ make (merchant 未到访; 单样本, 门控主覆盖在 unitP12) ---
  const nRole = pushes.length;
  await send(ws, "client.load_all_info", {});
  const rolesNow = pushes.slice(nRole).filter((p) => p.cmd === "client_load_role");
  const motionNow = rolesNow.length ? rolesNow[rolesNow.length - 1].data.frog.motion : null;
  check("P12 E2E 重登 motion 快照 ≠ 3 (make)", motionNow !== null && motionNow !== 3, `motion=${motionNow}`);

  // --- P11: 背包「完成」→ 排程出门 (正常节奏: WAIT 窗口内自行出发, 不再即发) ---
  const pin1 = await send(ws, "item_putin_bag", { pos: 1, item_id: 1 });
  check("P11 便当入包 pos1", pin1.code === 0, JSON.stringify(pin1));
  const n0 = pushes.length;
  const done1 = await send(ws, "item_set_bag_completed", { completed: 1 });
  check("P11 item_set_bag_completed 回包 code=0", done1.code === 0, JSON.stringify(done1));
  await sleep(1500); // 完成后 1.5s 内不应有出门推送 (WAIT 默认 3~8min)
  const depRole = pushes.slice(n0).find(
    (p) => p.cmd === "client_load_role" && p.data.frog && p.data.frog.status === 1);
  check("P11 完成不立即出发 (无 status=1 推送)", !depRole, depRole ? "出现了即时出发推送" : "");
  check("P11 完成回显 item_load_items",
    pushes.slice(n0).some((p) => p.cmd === "item_load_items"),
    `cmds=[${[...new Set(pushes.slice(n0).map((p) => p.cmd))].join(",")}]`);

  ws.close();
  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error("E2E 异常:", e); process.exit(1); });
