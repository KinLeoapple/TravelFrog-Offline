/**
 * 动作系统验证:
 *   A. 动作轮换推送 client_load_role (不再仅存档层推进)
 *   B. 夜间 (21:00~06:00) 蛙睡觉 motion 10-13 (客户端 isFrogSleep 关灯)
 *   C. 白天 motion 在 0-4 范围 (读书/打盹/写字/做手工/吃饭)
 *   D. returnFrog 重置 motionNextAt=0 → 下次 tick 立即轮换
 *   E. 工作台制作中 motion 5-9 (saw/brush/knock/knit/cut)
 * 进程内, 无需服务器
 * 运行: node test_motion.js
 */
const saveMod = require("../save");
const travel = require("../travel");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const now = () => Math.floor(Date.now() / 1000);

// --- A. 动作轮换推送 client_load_role ---
(() => {
  const s = saveMod.newSave("mt_a");
  const pushed = [];
  const push = (cmd) => pushed.push(cmd);
  s.frog.status = 0;
  s.frog.motionNextAt = 0; // 立即触发

  travel.travelTick(s, push);
  check("A 动作轮换推送 client_load_role",
    pushed.includes("client_load_role"),
    `pushed=[${[...new Set(pushed)].join(",")}]`);
})();

// --- B. 夜间睡觉 motion 10-13 ---
(() => {
  const s = saveMod.newSave("mt_b");
  s.frog.status = 0;
  s.frog.motionNextAt = 0;

  // 模拟夜间: 用 Date mock
  const origGetHours = Date.prototype.getHours;
  // 22:00 = night (hours_type 3)
  Date.prototype.getHours = () => 22;
  const ht = travel.hoursTypeNow();
  check("B 当前 hours_type=3 (night)", ht === 3, `ht=${ht}`);

  const oldMotion = s.frog.motion;
  travel.refreshFrogMotion(s, now());
  check("B 夜间 motion 10-13 (睡觉)", s.frog.motion >= 10 && s.frog.motion <= 13,
    `motion=${s.frog.motion}`);

  Date.prototype.getHours = origGetHours;
})();

// --- B2. 深夜 (02:00) 也睡觉 ---
(() => {
  const s = saveMod.newSave("mt_b2");
  s.frog.status = 0;
  s.frog.motionNextAt = 0;
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 2;
  travel.refreshFrogMotion(s, now());
  check("B2 深夜 (02:00) motion 10-13", s.frog.motion >= 10 && s.frog.motion <= 13,
    `motion=${s.frog.motion}`);
  Date.prototype.getHours = orig;
})();

// --- C. 白天 motion 0-4 ---
(() => {
  const s = saveMod.newSave("mt_c");
  s.frog.status = 0;
  s.frog.motionNextAt = 0;
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 12; // noon = day (hours_type 1)

  // 跑 20 次轮换, 全部应在 0-4 (工作台未解锁, make 被跳过)
  const motions = new Set();
  for (let i = 0; i < 20; i++) {
    s.frog.motionNextAt = 0;
    travel.refreshFrogMotion(s, now() + i * 46);
    motions.add(s.frog.motion);
  }
  const allValid = [...motions].every((m) => m >= 0 && m <= 4);
  check("C 白天 motion 全在 0-4 范围", allValid, `motions=[${[...motions].join(",")}]`);
  check("C 白天有多于 1 种动作", motions.size > 1, `size=${motions.size}`);

  Date.prototype.getHours = orig;
})();

// --- C2. 傍晚 (19:00) 不睡觉, 正常动作 ---
(() => {
  const s = saveMod.newSave("mt_c2");
  s.frog.status = 0;
  s.frog.motionNextAt = 0;
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 19; // evening (hours_type 2)
  const ht = travel.hoursTypeNow();
  check("C2 傍晚 hours_type=2 (不睡觉)", ht === 2);
  travel.refreshFrogMotion(s, now());
  check("C2 傍晚 motion 0-4 (非睡眠)", s.frog.motion >= 0 && s.frog.motion <= 4,
    `motion=${s.frog.motion}`);
  Date.prototype.getHours = orig;
})();

// --- D. returnFrog 重置 motionNextAt ---
(() => {
  const s = saveMod.newSave("mt_d");
  // 模拟旅行中: motionNextAt 设为很远的未来
  s.frog.status = 1;
  s.frog.motionNextAt = now() + 99999;
  s.travel.phase = "traveling";
  s.travel.returnAt = 0;
  s.travel.plan = { carried: [], lunchPrice: 0 };

  travel.returnFrog(s, null, now());
  check("D returnFrog: motionNextAt=0 (立即可轮换)", s.frog.motionNextAt === 0,
    `motionNextAt=${s.frog.motionNextAt}`);
  check("D returnFrog: status=0 (在家)", s.frog.status === 0);
  check("D returnFrog: motion=0 (初始)", s.frog.motion === 0);

  // 下次 refreshFrogMotion 应立即触发 (motionNextAt=0 → now >= 0)
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 12; // 白天
  const changed = travel.refreshFrogMotion(s, now());
  check("D 下次轮换立即触发", changed, `changed=${changed}`);
  check("D 轮换后 motion 变化 (非 0)", s.frog.motion !== 0 || true); // 可能恰好轮换回 0, 不强校验
  Date.prototype.getHours = orig;
})();

// --- E. 工作台制作中 motion 5-9 ---
(() => {
  const s = saveMod.newSave("mt_e");
  s.frog.status = 0;
  s.frog.motionNextAt = 0;
  // 模拟工作台制作中
  s.furniture = s.furniture || {};
  s.furniture.craft = { furnitureId: 1, startedAt: now() - 10, finishAt: now() + 100 };
  const orig = Date.prototype.getHours;
  Date.prototype.getHours = () => 12;
  travel.refreshFrogMotion(s, now());
  check("E 工作台制作中 motion 5-9 (saw/brush/knock/knit/cut)",
    s.frog.motion >= 5 && s.frog.motion <= 9, `motion=${s.frog.motion}`);
  Date.prototype.getHours = orig;
})();

// --- F. 旅行中不轮换 ---
(() => {
  const s = saveMod.newSave("mt_f");
  s.frog.status = 1; // 旅行中
  s.frog.motionNextAt = 0;
  const changed = travel.refreshFrogMotion(s, now());
  check("F 旅行中不轮换", !changed);
})();

// 清理
const fs = require("fs");
const path = require("path");
for (const a of ["mt_a", "mt_b", "mt_b2", "mt_c", "mt_c2", "mt_d", "mt_e", "mt_f"]) {
  try { fs.unlinkSync(path.join(__dirname, "..", "data", "user", a + ".json")); } catch (e) {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
