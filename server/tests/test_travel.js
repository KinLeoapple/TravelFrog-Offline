/**
 * M2 旅行循环回归测试 (进程内, 快节奏 env):
 * 出门 → 旅行 → 回家 → BackHome 事件 → 照片归档 → 图鉴 → 事件确认 → 持久化
 * 运行: node test_travel.js  (env 在 require 前设置, PACE 在模块加载时求值)
 */
// --- 快节奏参数 (秒) ---
process.env.FROG_TRAVEL_MIN_SEC = "3";
process.env.FROG_TRAVEL_MAX_SEC = "5";
process.env.FROG_IDLE_MIN_SEC = "2";
process.env.FROG_IDLE_MAX_SEC = "3";
process.env.FROG_DRIFT_MIN_SEC = "2";
process.env.FROG_DRIFT_MAX_SEC = "3";
process.env.FROG_WAIT_MIN_SEC = "1";
process.env.FROG_WAIT_MAX_SEC = "2";

const fs = require("fs");
const path = require("path");
const saveMod = require("../save");
const travel = require("../travel");
const { handlers } = require("../handlers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCOUNT = "travel_test_" + Date.now();

function mkCtx() {
  const ctx = { save: null, pushed: [], reply() {}, synced: false };
  // 闭包风格 (同 server.js): handlers 内部会解构 ctx.push, 方法简写的 this 会丢失
  ctx.push = (cmd, data) => ctx.pushed.push({ cmd, data });
  return ctx;
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

(async () => {
  const ctx = mkCtx();

  // --- 登录链 ---
  handlers.hall_gen_token(ctx, { account: ACCOUNT });
  handlers.client_load_all_info(ctx, {});
  ctx.synced = true;
  const s = ctx.save;
  check("建档蛙在家 status=0", s.frog.status === 0);
  check("旅行状态机 home", s.travel.phase === "home");

  // --- 装备: 便当入包 (item_id 1 草莓可丽饼 price=30, house 初始有 3 个 item 1) ---
  const pin = handlers.item_putin_bag(ctx, { pos: 1, item_id: 1 });
  check("便当入包", pin.code === 0 && s.items.bag[0] === 1, JSON.stringify(s.items.bag));

  // --- 等待出门窗口 (新档初始 600s 准备窗口, 测试快进到期; idle 2~3s) ---
  s.travel.departAt = Math.floor(Date.now() / 1000);
  await sleep(3200);
  travel.travelTick(s, ctx.push);
  check("蛙已出门 status=1", s.frog.status === 1);
  check("状态机 traveling", s.travel.phase === "traveling");
  check("便当已消耗", s.items.bag[0] === -1, JSON.stringify(s.items.bag));
  const goEv = s.events.find((e) => e.evt_type === 1);
  check("GoTravel 事件入队", !!goEv, JSON.stringify(goEv));
  const rolePush1 = ctx.pushed.find((p) => p.cmd === "client_load_role");
  check("出门推送 client_load_role", !!rolePush1);
  const notify1 = ctx.pushed.find((p) => p.cmd === "notify_new_event" && p.data.event.evt_type === 1);
  check("出门推送 notify_new_event", !!notify1);

  // --- 旅行中包不可操作 ---
  const tk = handlers.item_takeout_bag(ctx, { pos: 2 });
  check("旅行中取包被拒", tk.code !== 0);

  // --- 等待回家 (travel 3~5s × 便当加成 1.13x ≈ 3.4~5.7s, 留余量) ---
  await sleep(6500);
  travel.travelTick(s, ctx.push);
  check("蛙已回家 status=0", s.frog.status === 0);
  check("状态机回 home", s.travel.phase === "home");
  const backEv = s.events.find((e) => e.evt_type === 2);
  check("BackHome 事件入队", !!backEv, JSON.stringify(backEv));
  // evt_value 布局: [_, _, clover, ticket, collection, ...items]
  check("BackHome evt_value 长度>=5", backEv && backEv.evt_value.length >= 5,
    backEv ? `len=${backEv.evt_value.length}` : "");
  check("BackHome clover>0", backEv && backEv.evt_value[2] > 0);
  check("收入已入账", s.res.clover_point === 9999 + backEv.evt_value[2],
    `clover=${s.res.clover_point}`);
  const cloverPush = ctx.pushed.find((p) => p.cmd === "clover_update");
  check("回家推送 clover_update", !!cloverPush);
  const notePush = ctx.pushed.find((p) => p.cmd === "travel_load_note");
  check("回家推送 travel_load_note", !!notePush);

  // --- 多轮旅行直到出照片/特产 (概率奖励; 时间快进: 到期时刻清零 + tick, 免真实等待) ---
  // 便当耗尽会触发放浪 (无掉落), 为确定性: house 无便当时直接补 (本测试关注奖励而非补给)
  const houseSpecialty = () => s.items.house.some((h) => travel.isType(h.item_id, travel.ITEM_TYPE.SPECIALTY));
  let trips = 0;
  while ((s.albumPending.length === 0 || !houseSpecialty()) && trips < 60) {
    if (s.travel.phase === "home") {
      const bento = s.items.house.find((h) => travel.isType(h.item_id, travel.ITEM_TYPE.LUNCHBOX) && h.count > 0);
      if (bento) handlers.item_putin_bag(ctx, { pos: 1, item_id: bento.item_id });
      else s.items.bag[0] = 1; // 测试直供便当, 绕过物品栏校验
      s.travel.departAt = 0;
    } else {
      s.travel.returnAt = 0;
    }
    travel.travelTick(s, ctx.push);
    trips++;
  }
  check(`多轮旅行后有待归档照片 (另 ${trips} 轮)`, s.albumPending.length > 0,
    `pending=${s.albumPending.length}`);
  // 官方语义: 特产入物品栏(house) —— 投喂弹窗 PlayerBag(Specialty) 只读 house
  const specInHouse = s.items.house.filter((h) => {
    const DB = travel.isType(h.item_id, travel.ITEM_TYPE.SPECIALTY);
    return DB;
  });
  check("多轮旅行后有特产 (入物品栏)", specInHouse.length > 0, JSON.stringify(specInHouse.slice(0, 3)));
  check("特产已入图鉴", s.handbook.specialtys.length > 0);
  const picPush = ctx.pushed.find((p) => p.cmd === "album_load_new");
  check("推送 album_load_new", !!picPush);

  // --- 照片协议 ---
  const pend = s.albumPending[0];
  const layersPic = travel.withLayers(pend);
  check("照片图层 hydrate", Array.isArray(layersPic.layers) && layersPic.layers.length > 0,
    `pic_id=${pend.pic_id} layers=${layersPic.layers ? layersPic.layers.length : 0}`);

  const saveNew = handlers.album_save_new(ctx, { id: pend.id });
  check("照片归档 code=0", saveNew.code === 0, JSON.stringify(saveNew));
  check("归档后相册+1", s.pictures.length >= 1 && !s.albumPending.some((p) => p.id === pend.id));
  const loadAll = handlers.album_load_all(ctx, {});
  check("album_load_all id_list 对象数组", Array.isArray(loadAll.id_list)
    && typeof loadAll.id_list[0] === "object" && loadAll.id_list[0].pic_id === pend.pic_id);
  const byId = handlers.album_load_by_id_list(ctx, { id_list: [pend.id] });
  check("album_load_by_id_list 响应键 pic_list", Array.isArray(byId.pic_list) && byId.pic_list.length === 1);
  const badSave = handlers.album_save_new(ctx, { id: 99999 });
  check("归档未知 id 返回 76", badSave.code === 76);

  // --- 事件确认 ---
  const evCount = s.events.length;
  handlers.client_confirm_event(ctx, { id: backEv.id });
  check("confirm 移除事件", s.events.length === evCount - 1
    && !s.events.some((e) => e.id === backEv.id));

  // --- 存档持久化 ---
  saveMod.persist(s);
  const s2 = saveMod.load(ACCOUNT);
  check("重读档照片持久化", s2.pictures.length === s.pictures.length);
  check("重读档旅行次数持久化", s2.travel.tripCount === s.travel.tripCount && s2.travel.tripCount > 0,
    `trips=${s2.travel.tripCount}`);
  check("重读档图鉴持久化", s2.handbook.specialtys.length === s.handbook.specialtys.length);

  // --- 未准备不出门 ---
  s.travel.departAt = 0; // 强制到期
  s.items.bag = [-1, -1, -1, -1];
  s.items.desk = [-1, -1, -1, -1, -1, -1, -1, -1];
  travel.travelTick(s, null);
  check("无装备不出门", s.travel.phase === "home" && s.frog.status === 0);
  check("无装备重排出门窗口", s.travel.departAt > Math.floor(Date.now() / 1000));

  // --- 完成背包 → WAIT 窗口内自行出发 (正常节奏, 非即发) ---
  {
    const s = saveMod.newSave(ACCOUNT);
    s.items.bag = [1, -1, -1, -1];
    const ctx = mkCtx(); ctx.save = s;
    handlers["item_set_bag_completed"](ctx, { completed: 1 });
    check("完成背包不立即出发 (蛙仍在家)", s.frog.status === 0 && s.travel.phase === "home");
    const win = s.travel.departAt - Math.floor(Date.now() / 1000);
    check("出门已排程在 WAIT 窗口内", win >= 0 && win <= 2, `window=${win}s`);
    await sleep(2200);
    travel.travelTick(s, null);
    check("WAIT 到点自行出发", s.travel.phase === "traveling" && s.frog.status === 1);
  }

  console.log(`\n${pass}/${pass + fail} 通过`);
  try { fs.unlinkSync(path.join(__dirname, "..", "data", "user", ACCOUNT + ".json")); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
setTimeout(() => { console.error("超时"); process.exit(1); }, 180000);
