/**
 * 三叶草稀有物品 + 盘栽无堆肥生长 + 工作台动作推送 验证
 * 运行: node test_clover_pot_bench.js
 */
process.env.FROG_PLANT_STAGE_SEC = "2"; // 快节奏盘栽

const saveMod = require("../save");
const travel = require("../travel");
const flowerpot = require("../flowerpot");
const furni = require("../furni");
const handlersMod = require("../handlers");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const now = () => Math.floor(Date.now() / 1000);

// ========== A. 三叶草稀有物品 ==========

// --- A1. rollRegrow 有概率产出 ITEM (element=2) ---
(() => {
  let four = 0, item = 0, three = 0;
  for (let i = 0; i < 10000; i++) {
    const r = saveMod.rollRegrow();
    if (r.element === 1) four++;
    else if (r.element === 2) item++;
    else three++;
  }
  check("A1 四叶草 ~1% (70~140/万)", four >= 70 && four <= 140, `four=${four}`);
  check("A1 稀有材料 ~2% (150~250/万)", item >= 150 && item <= 250, `item=${item}`);
  check("A1 普通三叶草 ~97%", three >= 9600, `three=${three}`);
})();

// --- A2. ITEM 的 sprite 是合法材料 id ---
(() => {
  const pool = saveMod.CLOVER.ITEM_POOL;
  for (let i = 0; i < 100; i++) {
    const r = saveMod.rollRegrow();
    if (r.element === 2) {
      check("A2 ITEM sprite 在材料池内", pool.includes(r.sprite), `sprite=${r.sprite}`);
      return;
    }
  }
  check("A2 100次内出 ITEM", false);
})();

// --- A3. harvestClover element=2 入屋 ---
(() => {
  const ctx = { save: saveMod.newSave("cp_a3"), pushed: [], reply() {}, synced: true };
  ctx.push = (cmd, data) => ctx.pushed.push({ cmd, data });
  const s = ctx.save;
  // 强制一个槽位为 ITEM + sprite=10001
  s.clovers[0].element = 2;
  s.clovers[0].sprite = 10001;
  s.clovers[0].last_harvest = 0;
  const r = handlersMod.handlers.clover_harvest(ctx, { clover_id: 1 });
  check("A3 收割 ITEM code=0", r.code === 0);
  check("A3 材料入屋 (10001)", s.items.house.some((h) => h.item_id === 10001 && h.count > 0));
  check("A3 推送 item_update", ctx.pushed.some((p) => p.cmd === "item_update"));
})();

// ========== B. 盘栽无堆肥生长 ==========

// --- B1. 贫瘠 (0堆肥) stage 1→2 可生长 ---
(() => {
  const s = saveMod.newSave("cp_b1");
  furni.node(s).compost.boxes = [0, 0, 0, 0, 0, 0]; // 全空 = 贫瘠
  const t = now();
  flowerpot.flowerpotTick(s, t); // 自动播种 stage 1
  check("B1 初始播种 stage=1", s.flowerpot.slots.every((sl) => sl.stage === 1));
  // 等待 stageSec 后再 tick (stage 1→2 不需堆肥)
  flowerpot.flowerpotTick(s, t + flowerpot.PLANT_STAGE_SEC + 1);
  check("B1 贫瘠下 stage 1→2 可生长", s.flowerpot.slots.every((sl) => sl.stage === 2),
    `stages=${JSON.stringify(s.flowerpot.slots.map((sl) => sl.stage))}`);
})();

// --- B2. 贫瘠下 stage 2 冻结 (不升 3) ---
(() => {
  const s = saveMod.newSave("cp_b2");
  furni.node(s).compost.boxes = [0, 0, 0, 0, 0, 0];
  const t = now();
  flowerpot.flowerpotTick(s, t); // 播种 stage 1
  // 推到 stage 2
  flowerpot.flowerpotTick(s, t + flowerpot.PLANT_STAGE_SEC + 1);
  check("B2 推到 stage 2", s.flowerpot.slots.every((sl) => sl.stage === 2));
  // 再等很久, 贫瘠下 stage 2 不升 3
  flowerpot.flowerpotTick(s, t + flowerpot.PLANT_STAGE_SEC * 10);
  check("B2 贫瘠下 stage 2 冻结 (不升 3)", s.flowerpot.slots.every((sl) => sl.stage === 2),
    `stages=${JSON.stringify(s.flowerpot.slots.map((sl) => sl.stage))}`);
})();

// --- B3. 有堆肥 stage 2→3 吸收一格 ---
(() => {
  const s = saveMod.newSave("cp_b3");
  // 4 格但 <3 不触发肥沃减半 (filled=2 → stageSec=PLANT_STAGE_SEC)
  furni.node(s).compost.boxes = [10001, 10002, 0, 0, 0, 0];
  const t = now();
  flowerpot.flowerpotTick(s, t); // 播种 stage 1
  // 推到 stage 2 (不需堆肥)
  flowerpot.flowerpotTick(s, t + flowerpot.PLANT_STAGE_SEC + 1);
  check("B3 推到 stage 2", s.flowerpot.slots.every((sl) => sl.stage === 2),
    `stages=${JSON.stringify(s.flowerpot.slots.map((sl) => sl.stage))}`);
  check("B3 stage 1→2 未吸收堆肥 (2格仍在)", furni.node(s).compost.boxes.filter((v) => v > 0).length === 2,
    `boxes=${JSON.stringify(furni.node(s).compost.boxes)}`);
  // 再等, 有堆肥 → stage 3 (每槽吸收一格, 2槽×1=2格, 剩0)
  flowerpot.flowerpotTick(s, t + flowerpot.PLANT_STAGE_SEC * 2 + 1);
  check("B3 有堆肥 → stage 3", s.flowerpot.slots.every((sl) => sl.stage === 3),
    `stages=${JSON.stringify(s.flowerpot.slots.map((sl) => sl.stage))}`);
  check("B3 堆肥全吸收 (剩0格)", furni.node(s).compost.boxes.filter((v) => v > 0).length === 0);
})();

// ========== C. 工作台动作推送 ==========

// --- C1. putinBench 开工推送 client_load_role ---
(() => {
  const ctx = { save: saveMod.newSave("cp_c1"), pushed: [], reply() {}, synced: true };
  ctx.push = (cmd, data) => ctx.pushed.push({ cmd, data });
  const s = ctx.save;
  // 模拟商人到访 (工作台解锁)
  s.merchant = { lastVisit: 1 };
  // 补图纸 + 材料到屋
  // 找一张能做的图纸
  const benchable = [...furni.CRAFTABLE_BY_TYPE.entries()];
  if (benchable.length) {
    const [type, target] = benchable[0];
    const drawId = [...furni.BLUEPRINT_TYPE.entries()].find(([d, t]) => t === type);
    if (drawId) {
      s.items.house.push({ item_id: drawId[0], count: 1 }); // 图纸
      const mats = furni.craftMaterialsFor(target.furnitureId) || [{ item_id: 10001, count: 2 }];
      for (const m of mats) {
        const ex = s.items.house.find((h) => h.item_id === m.item_id);
        if (ex) ex.count += m.count;
        else s.items.house.push({ item_id: m.item_id, count: m.count });
      }
      ctx.pushed.length = 0;
      // 放图纸到工作台物品位 (pos 6-10) — 用 handler 走推送路径
      const r = handlersMod.handlers.furniture_putin_bench(ctx, { pos: 6, id: drawId[0] });
      check("C1 开工 crafting=1", r.code === 0 && r.crafting === 1);
      check("C1 推送 client_load_role (蛙上工)", ctx.pushed.some((p) => p.cmd === "client_load_role"));
      check("C1 motion 5-9 (工具动画)", s.frog.motion >= 5 && s.frog.motion <= 9, `motion=${s.frog.motion}`);
    } else {
      console.log("SKIP C1 无可用图纸");
    }
  } else {
    console.log("SKIP C1 无可制作家具");
  }
})();

// --- C2. craftTick 完工推送 client_load_role (蛙下工) ---
(() => {
  const s = saveMod.newSave("cp_c2");
  s.merchant = { lastVisit: 1 };
  const pushed = [];
  const push = (cmd) => pushed.push(cmd);
  // 模拟制作中: motion=7 (knock), craft 到期
  furni.node(s).craft = { kind: "furniture", furnitureId: 1, drawing: 1, materials: [], startedAt: now() - 100, finishAt: now() - 1 };
  furni.node(s).benchLock = 1;
  s.frog.status = 0;
  s.frog.motion = 7; // 工具动作中
  pushed.length = 0;
  furni.craftTick(s, push, now());
  check("C2 完工后 motion=0 (下工)", s.frog.motion === 0, `motion=${s.frog.motion}`);
  check("C2 推送 client_load_role (蛙下工)", pushed.includes("client_load_role"));
  check("C2 craft=null (已完工)", s.furniture.craft === null);
  check("C2 benchLock=0 (解锁)", s.furniture.benchLock === 0);
})();

// --- C3. refreshFrogMotion 制作中轮换工具 5-9 ---
(() => {
  const s = saveMod.newSave("cp_c3");
  s.merchant = { lastVisit: 1 };
  s.frog.status = 0;
  s.frog.motionNextAt = 0;
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 12; // 白天
  // 模拟制作中
  furni.node(s).craft = { kind: "furniture", furnitureId: 1, drawing: 1, materials: [], startedAt: now(), finishAt: now() + 999 };
  furni.node(s).benchLock = 1;
  // 多次轮换, 全部应是 5-9
  const motions = new Set();
  for (let i = 0; i < 10; i++) {
    s.frog.motionNextAt = 0;
    travel.refreshFrogMotion(s, now() + i * 46);
    motions.add(s.frog.motion);
  }
  check("C3 制作中 motion 全在 5-9", [...motions].every((m) => m >= 5 && m <= 9), `motions=[${[...motions].join(",")}]`);
  Date.prototype.getHours = orig;
})();

// 清理
const fs = require("fs");
const path = require("path");
for (const a of ["cp_a3", "cp_b1", "cp_b2", "cp_b3", "cp_c1", "cp_c2", "cp_c3"]) {
  try { fs.unlinkSync(path.join(__dirname, "..", "data", "user", a + ".json")); } catch (e) {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
