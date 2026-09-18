/**
 * 彩蛋引擎验证 (egg.js):
 *   A. 雨具: 雨天 + 小伙伴/商人在场 → 对应 shelter 蛋; 晴天/无 NPC → 无
 *   B. 萤火虫: 夏季傍晚/夜晚 → 201; 白天/冬季 → 无
 *   C. 蛙彩蛋状态机: 在家掷蛋 (池合法), 出门清零, 到期回收, 同时最多 1 个
 *   D. eggTick 变化推送 + eggPayload 基线
 * 进程内, 无需服务器
 * 运行: node test_eggs.js
 */
const assert = require("assert");
const saveMod = require("../save");
const egg = require("../egg");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};
const now = Math.floor(Date.now() / 1000);
const mk = () => {
  const s = saveMod.newSave("egg_t");
  s.egg = { type: 0, until: 0, nextRollAt: 0, pushed: [] };
  s.weather = { season: 3, hours_type: 1, weather: 1 }; // 秋·白天·晴
  return s;
};

// --- A. 雨具 ---
(() => {
  const s = mk();
  s.weather.weather = 3; // 小雨
  s.guest = { id: 0 };   // 困困
  let eggs = egg.activeEggs(s, now);
  check("A1 小雨+困困 → KKShelter(103)", eggs.includes(103), JSON.stringify(eggs));
  s.merchant = { shop: { start_time: 1 } };
  eggs = egg.activeEggs(s, now);
  check("A2 商人在场 → +DDShelter(101)", eggs.includes(101) && eggs.includes(103));
  s.weather.weather = 1; // 转晴
  eggs = egg.activeEggs(s, now);
  check("A3 转晴后雨具消失", !eggs.includes(101) && !eggs.includes(103));
})();

// --- B. 萤火虫 ---
(() => {
  const s = mk();
  s.weather = { season: 2, hours_type: 2, weather: 1 }; // 夏·傍晚
  check("B1 夏季傍晚 → FireFly(201)", egg.activeEggs(s, now).includes(201));
  s.weather.hours_type = 1; // 白天
  check("B2 夏季白天无萤火虫", !egg.activeEggs(s, now).includes(201));
  s.weather = { season: 4, hours_type: 3, weather: 1 }; // 冬·夜
  check("B3 冬季夜晚无萤火虫", !egg.activeEggs(s, now).includes(201));
})();

// --- C. 蛙彩蛋状态机 ---
(() => {
  const s = mk();
  s.egg.nextRollAt = now - 1; // 到点掷蛋
  const t1 = egg.activeEggs(s, now)[0];
  check("C1 在家到点掷出蛙蛋 (1-5)", t1 >= 1 && t1 <= 5, `egg=${t1}`);
  check("C2 蛋有持续窗口", s.egg.until > now);
  const t2 = egg.activeEggs(s, now + 60)[0];
  check("C3 窗口内保持同一颗", t2 === t1);
  const after = egg.activeEggs(s, s.egg.until + 1);
  check("C4 到期回收且安排下一轮", !after.includes(t1) && s.egg.nextRollAt > s.egg.until);
  s.egg.type = 2; s.egg.until = now + 9999;
  s.frog.status = 1; // 出门
  check("C5 出门即收蛋", !egg.activeEggs(s, now).includes(2));
})();

// --- D. tick 推送 ---
(() => {
  const s = mk();
  const pushed = [];
  const push = (cmd, data) => pushed.push({ cmd, data });
  s.weather.weather = 4; s.guest = { id: 1 }; // 大雨+胖胖
  check("D1 变化时推送 easteregg_load", egg.eggTick(s, push, now) === true
    && pushed.length === 1 && pushed[0].cmd === "easteregg_load"
    && pushed[0].data.egg_list.includes(104));
  check("D2 无变化不重复推", egg.eggTick(s, push, now + 1) === false && pushed.length === 1);
  s.guest = null;
  check("D3 NPC 离场 → 再推移除", egg.eggTick(s, push, now + 2) === true
    && !pushed[1].data.egg_list.includes(104));
})();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
