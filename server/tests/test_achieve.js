/**
 * 称号系统 (achieve.js) 单元测试
 * 覆盖: 配置解析 / 全量判定各条件 / 道具称号限时激活+叠加+过期 /
 *       便当连击 / 登录天数 / 佩戴协议 client_set_achieve / rolePayload 三字段下发
 * 运行: node test_achieve.js
 */
const assert = require("assert");
const saveMod = require("../save");
const achieve = require("../achieve");
const travel = require("../travel");
const handlersMod = require("../handlers");

const now = Math.floor(Date.now() / 1000);
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

// ---- 1. 配置解析 ----
check("称号表 103 条", achieve.ACHIEVE_TABLE.size === 103, `size=${achieve.ACHIEVE_TABLE.size}`);
check("特产总数 66", achieve.SPECIALTY_TOTAL === 66, `total=${achieve.SPECIALTY_TOTAL}`);
check("道具称号 21 个 (203001-203027)", achieve.TICKET_ACHIEVE.size === 21, `size=${achieve.TICKET_ACHIEVE.size}`);
check("果汁便当=苹果汁 id 14", achieve.JUICE_LUNCH_ID === 14, `id=${achieve.JUICE_LUNCH_ID}`);
check("数量类规则 ≥60 条", achieve.COUNT_RULES.size >= 60, `items=${achieve.COUNT_RULES.size}`);
// 道具称号映射抽查: 203001 蛙选之人·3天 → 900
const tk = achieve.TICKET_ACHIEVE.get(203001);
check("203001 → 称号 900", !!tk && tk.achieveId === 900, JSON.stringify(tk || null));
check("203027 → 称号 902", (achieve.TICKET_ACHIEVE.get(203027) || {}).achieveId === 902);

// ---- 2. 全量判定: 各条件独立触发 ----
// 旅行次数 10/25/50/100 → 1/2/3/20
{
  const s = saveMod.newSave("ach_trip");
  s.travel.tripCount = 25;
  achieve.check(s, now);
  check("旅行 25 次 → 称号 1+2", s.frog.achieves.includes(1) && s.frog.achieves.includes(2));
  check("旅行 25 次未到 50 → 无称号 3", !s.frog.achieves.includes(3));
  s.travel.tripCount = 100;
  achieve.check(s, now);
  check("旅行 100 次 → 称号 3+20", s.frog.achieves.includes(3) && s.frog.achieves.includes(20));
  check("新档默认解锁称号 0", s.frog.achieves.includes(0));
}
// 特产图鉴 20/30/40/66 → 17/18/19/6
{
  const s = saveMod.newSave("ach_spec");
  for (let i = 0; i < 30; i++) s.handbook.specialtys.push(3000 + i);
  achieve.check(s, now);
  check("特产 30 种 → 称号 17+18", s.frog.achieves.includes(17) && s.frog.achieves.includes(18));
  check("特产 30 种未到 40 → 无称号 19", !s.frog.achieves.includes(19));
}
// 纪念品 5/10/15/20 → 13/14/15/16
{
  const s = saveMod.newSave("ach_coll");
  for (let i = 0; i < 15; i++) s.handbook.collections.push(5000 + i);
  achieve.check(s, now);
  check("纪念品 15 件 → 称号 13+14+15", s.frog.achieves.includes(13) && s.frog.achieves.includes(14) && s.frog.achieves.includes(15));
  check("纪念品 15 件未到 20 → 无称号 16", !s.frog.achieves.includes(16));
}
// 三叶草 >10 万 → 9; 抽奖 ≥20 → 10
{
  const s = saveMod.newSave("ach_res");
  s.res.clover_point = 100001;
  s.stats.gachaCount = 20;
  achieve.check(s, now);
  check("三叶草 10 万+ → 称号 9", s.frog.achieves.includes(9));
  check("抽奖 20 次 → 称号 10", s.frog.achieves.includes(10));
}
// 连续 4 次果汁出发 → 11 (onDepart 记录)
{
  const s = saveMod.newSave("ach_juice");
  for (let i = 0; i < 4; i++) achieve.onDepart(s, 14);
  achieve.check(s, now);
  check("连续 4 次苹果汁 → 称号 11", s.frog.achieves.includes(11));
  const s2 = saveMod.newSave("ach_juice2");
  achieve.onDepart(s2, 14); achieve.onDepart(s2, 14); achieve.onDepart(s2, 14);
  achieve.onDepart(s2, 1); achieve.onDepart(s2, 14); // 中断后不足 4 连
  achieve.check(s2, now);
  check("果汁连击中断 → 无称号 11", !s2.frog.achieves.includes(11),
    `lunchHistory=[${s2.stats.lunchHistory.join(",")}]`);
}
// 登录天数 60/100/180/280/360 → 21/22/23/71/72
{
  const s = saveMod.newSave("ach_login");
  s.stats.loginDays = 360;
  achieve.check(s, now);
  check("登录 360 天 → 称号 21/22/23/71/72",
    [21, 22, 23, 71, 72].every((id) => s.frog.achieves.includes(id)));
}
// 数量类: 三明治超过 10 个 (称号条件抽查 — 用表内第一条可满足规则)
{
  const s = saveMod.newSave("ach_count");
  const [itemId, rules] = achieve.COUNT_RULES.entries().next().value;
  const minCount = Math.min(...rules.map((r) => r.count));
  s.items.house.push({ item_id: itemId, count: minCount });
  achieve.check(s, now);
  const wanted = rules.filter((r) => minCount >= r.count).map((r) => r.achieveId);
  check(`数量类 ${itemId}=${minCount} → 称号 ${wanted.join("/")}`,
    wanted.every((id) => s.frog.achieves.includes(id)),
    `achieves=[${s.frog.achieves.join(",")}]`);
}
// 装饰插花: 蜡梅(100) 花苞/绽放 → 73/74
{
  const s = saveMod.newSave("ach_deco");
  s.furniture.decorate = { putId: 100, status: 2 };
  achieve.check(s, now);
  check("蜡梅绽放 → 称号 73+74", s.frog.achieves.includes(73) && s.frog.achieves.includes(74));
  check("蜡梅 → 无木槿称号 79", !s.frog.achieves.includes(79));
}
// 24h 未归 → 8; 短途 (30 分钟内回家) → 7
{
  const s = saveMod.newSave("ach_late");
  s.frog.status = 1;
  s.travel.departAt = now - 86401;
  achieve.check(s, now);
  check("24h 未归 → 称号 8", s.frog.achieves.includes(8));
  const s2 = saveMod.newSave("ach_short");
  achieve.check(s2, now, { tripWindow: 1799 });
  check("30 分钟内回家 → 称号 7", s2.frog.achieves.includes(7));
}
// 照片典藏 4/8/12/20 → 82/83/84/85
{
  const s = saveMod.newSave("ach_pic");
  for (let i = 0; i < 12; i++) s.pictures.push({ id: 1 + i });
  achieve.check(s, now);
  check("照片 12 张 → 称号 82/83/84",
    [82, 83, 84].every((id) => s.frog.achieves.includes(id)) && !s.frog.achieves.includes(85));
}

// ---- 3. 道具称号: 激活 / 叠加 / 过期 ----
{
  const s = saveMod.newSave("ach_ticket");
  s.mailSeq = 2;
  // addItem→onItemGain 接线经 mail_open (附件入账即激活道具称号)
  s.mails.push({ id: 1, type: 3, title: "t", read: false, items: [{ item_id: 203001, count: 1 }] });
  handlersMod.handlers["mail_open"]({ save: s, push: () => {} }, { id: 1 });
  check("mail_open 领取 203001 → 解锁称号 900", s.frog.achieves.includes(900));
  const entry = s.frog.achieves_time.find((x) => x.id === 900);
  check(`称号 900 限时 ${tk.days} 天 (203001 蛙选之人)`,
    entry && entry.time > now + (tk.days - 1) * 86400 && entry.time <= now + tk.days * 86400 + 60,
    JSON.stringify(entry || null));
  // 叠加: 再得一个 → 时长累加
  const before = entry.time;
  s.mails.push({ id: 2, type: 3, title: "t2", read: false, items: [{ item_id: 203001, count: 1 }] });
  handlersMod.handlers["mail_open"]({ save: s, push: () => {} }, { id: 2 });
  check("重复获得时长叠加", entry.time === before + tk.days * 86400, `${before}→${entry.time}`);
  // 过期: 时间推进到过期后 → 清理 + 佩戴重置
  s.frog.cur_achieve = 900;
  const later = entry.time + 1;
  achieve.check(s, later);
  check("过期后称号 900 移除", !s.frog.achieves.includes(900) && !s.frog.achieves_time.some((x) => x.id === 900));
  check("过期后佩戴重置为 0", s.frog.cur_achieve === 0, `cur=${s.frog.cur_achieve}`);
}

// ---- 4. 登录天数: 同日不重复 / 跨日 +1 ----
{
  // 锚定本地正午: onLogin 同日判定按本地日, 裸时间戳在本地 23~24 点运行时 +3600 会跨日 (flake)
  const noon = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
  const s = saveMod.newSave("ach_lg2");
  achieve.onLogin(s, noon);
  const d1 = s.stats.loginDays;
  achieve.onLogin(s, noon + 3600); // 同一天
  check("同日重复登录不加天数", s.stats.loginDays === d1, `days=${s.stats.loginDays}`);
  achieve.onLogin(s, noon + 86400); // 次日
  check("次日登录 +1 天", s.stats.loginDays === d1 + 1, `days=${s.stats.loginDays}`);
}

// ---- 5. 佩戴协议 client_set_achieve ----
{
  const s = saveMod.newSave("ach_wear");
  s.frog.achieves.push(1);
  handlersMod.handlers["client_set_achieve"]({ save: s }, { id: 1 });
  check("佩戴已解锁称号 1", s.frog.cur_achieve === 1, `cur=${s.frog.cur_achieve}`);
  handlersMod.handlers["client_set_achieve"]({ save: s }, { id: 99 }); // 未解锁
  check("未解锁称号拒绝 (仍佩戴 1)", s.frog.cur_achieve === 1);
  handlersMod.handlers["client_set_achieve"]({ save: s }, { id: 0 });
  check("重置佩戴 0", s.frog.cur_achieve === 0);
}

// ---- 6. rolePayload 三字段下发 ----
{
  const s = saveMod.newSave("ach_role");
  s.mailSeq = 2;
  s.mails.push({ id: 1, type: 3, title: "t", read: false, items: [{ item_id: 203001, count: 1 }] });
  handlersMod.handlers["mail_open"]({ save: s, push: () => {} }, { id: 1 }); // 激活限时称号 900
  achieve.grant(s, 1);
  achieve.check(s, now); // 默认称号 0 在全量检查中授予 (登录/tick 路径)
  s.frog.cur_achieve = 1;
  const p = travel.rolePayload(s);
  check("rolePayload 含 cur_achieve/achieves/achieves_time",
    p.frog.cur_achieve === 1 && Array.isArray(p.frog.achieves) && Array.isArray(p.frog.achieves_time));
  check("rolePayload.achieves 含 0/1/900", [0, 1, 900].every((id) => p.frog.achieves.includes(id)),
    `achieves=[${p.frog.achieves.join(",")}]`);
  check("rolePayload 不泄露内部字段 (motionPattern 等)",
    p.frog.motionPattern === undefined && p.frog.motionStep === undefined);
  const t = p.frog.achieves_time.find((x) => x.id === 900);
  check("achieves_time 含 900 过期时间戳", !!t && t.time > now, JSON.stringify(t || null));
}

console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
