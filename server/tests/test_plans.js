/**
 * 周期计划验证 (plans.js):
 *   A. 载荷: task_load.list 全池 67 项 + task_load_list.reward 6 计划
 *   B. 事件匹配: 便当出门/满包/满桌、投喂(全体/特定)、收割、兑换码
 *   C. 周期滚动: 日任务清零, 周任务保留; 领奖档位随周期重置
 *   D. 领档: 完成数门槛 + 按档顺序 + 发放物品推送 (task_get_list_reward)
 * 运行: node test_plans.js
 */
const assert = require("assert");
const saveMod = require("../save");
const plans = require("../plans");
const handlers = require("../handlers").handlers;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const mk = () => saveMod.newSave("pl_t");
const run = (s, cmd, data) => {
  const pushed = [];
  handlers[cmd]({ save: s, pushed, reply() {}, push: (c, d) => pushed.push({ cmd: c, data: d }), synced: true }, data || {});
  return pushed;
};
const pro = (s, id) => (plans.listPayload(s).find((t) => t.id === id) || {}).pro;

// --- A. 载荷 ---
(() => {
  const s = mk();
  const list = plans.listPayload(s);
  const reward = plans.rewardPayload(s);
  check("A1 list 全池 67 项", list.length === 67, `len=${list.length}`);
  check("A2 reward 6 计划且档位 0", reward.length === 6 && reward.every((r) => r.pro === 0));
})();

// --- B. 事件匹配 ---
(() => {
  const s = mk();
  plans.onDepart(s, { lunchId: 1, carried: [] });
  check("B1 草莓可丽饼出门 → 101+205", pro(s, 101) === 1 && pro(s, 205) === 1);
  plans.onDepart(s, { lunchId: 2, carried: [5, 6, 7, 8] });
  check("B2 满包出门 → 304", pro(s, 304) === 1 && pro(s, 302) === 1);
  check("B3 101 封顶不重复", pro(s, 101) === 1);
  const s2 = mk();
  s2.items.desk = [1, 2, 1000, 1001, 1002, 1003, 2000, 2001]; // 便当+护符+道具 8 格
  plans.onDepart(s2, { lunchId: -1, carried: [] });
  check("B4 满桌(三类齐) → 305", pro(s2, 305) === 1, `pro305=${pro(s2, 305)}`);
  check("B5 放浪(无便当)不计 101", pro(s2, 101) === undefined || pro(s2, 101) === 0);
  plans.event(s, "guestFeed", { guest: 0 });
  check("B6 投喂困困 → 201+404, 不误记 405", pro(s, 201) === 1 && pro(s, 404) === 1 && !pro(s, 405));
  plans.event(s, "cloverHarvest", null, null) /* delta 1 */;
  check("B7 收割计数累加", pro(s, 202) === 1);
})();

// --- C. 周期滚动 ---
(() => {
  const s = mk();
  plans.event(s, "cloverHarvest");           // 周任务 202
  plans.onDepart(s, { lunchId: 1, carried: [] }); // 日任务 101
  check("C1 前置: 日/周任务均有进度", pro(s, 202) === 1 && pro(s, 101) === 1);
  s.plans.key[1] = "2000-01-01";             // 模拟日周期过期
  plans.listPayload(s);                      // 惰性滚动
  check("C2 日周期清零, 周周期保留", pro(s, 101) === 0 && pro(s, 202) === 1,
    `day=${pro(s, 101)} week=${pro(s, 202)}`);
  s.plans.claimed[1] = 1;
  s.plans.key[1] = "2000-01-02";
  plans.listPayload(s);
  check("C3 领奖档位随周期重置", plans.rewardPayload(s).find((r) => r.id === 1).pro === 0);
})();

// --- D. 领档 ---
(() => {
  const s = mk();
  // 日计划: 完成 101/102/103 (target [3], reward [1])
  plans.onDepart(s, { lunchId: 1, carried: [] }); // 101
  plans.event(s, "photoGoal");                    // 102
  plans.event(s, "photoNewPlace");                // 103
  check("D1 是日清单 3 项全完成", plans.completeNum(s, 1) === 3, `n=${plans.completeNum(s, 1)}`);
  const bad = run(s, "task_get_list_reward", { id: 100 * 1 + 2 }); // type1 只有 1 档
  check("D2 越档领取被拒", bad.length === 0 && s.plans.claimed[1] === 0);
  const pushed = run(s, "task_get_list_reward", { id: 100 * 1 + 1 });
  check("D3 领档成功 + 物品推送",
    pushed.some((p) => p.cmd === "item_update" && p.data.item.item_id === 1),
    JSON.stringify(pushed.map((p) => p.data.item || null)));
  check("D4 重复领档被拒", run(s, "task_get_list_reward", { id: 100 * 1 + 1 }).length === 0);
  // 周计划: target [2,5] —— 完成 2 项可领档1, 档2 不可
  plans.event(s, "cloverHarvest");                // 202 ✓
  plans.event(s, "guestFeed", { guest: 0 });      // 201 ✓
  const p2 = run(s, "task_get_list_reward", { id: 100 * 2 + 1 });
  check("D5 周档1 (完成2/5) + 奖励 202103",
    p2.some((x) => x.cmd === "item_update" && x.data.item.item_id === 202103));
  check("D6 周档2 (完成数不足) 被拒", run(s, "task_get_list_reward", { id: 100 * 2 + 2 }).length === 0);
  // 兑换码: 给自己的信 → 计划 204
  const s3 = mk();
  const ctx3 = { save: s3, pushed: [], reply() {}, push() {}, synced: true };
  const r1 = handlers["item_use_gift_code"](ctx3, { code: "给自己的信" });
  const r2 = handlers["item_use_gift_code"](ctx3, { code: "不存在" });
  check("D7 兑换码 给自己的信 → 200 + 204 进度", r1.code === 200 && pro(s3, 204) === 1);
  check("D8 无效兑换码 → 404", r2.code === 404);
})();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
