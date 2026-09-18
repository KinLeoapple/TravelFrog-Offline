/**
 * 周末小插曲 (lottery.js) 单元测试
 * 覆盖: 周期建档/payload 结构/开蛋/挑选校验与正误/结算推进/领奖入账/
 *       5 轮封盘 (select_list 清空)/周末礼邮件/非周末门控
 * 运行: node test_lottery.js
 */
const assert = require("assert");
const saveMod = require("../save");
const lottery = require("../lottery");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

const now = Math.floor(Date.now() / 1000);

// ---- 1. 周期与建档 ----
const s = saveMod.newSave();
check("周末判定 (本地时钟, 供参考)", true, `isWeekend=${lottery.isWeekend(now)}`);
const L = lottery.node(s, now);
check("建档 phase>0", L.phase > 0, `phase=${L.phase}`);
check("初始 state=open(0)", L.state === 0);
check("候选 8 件", L.candidates.length === 8, L.candidates.join(","));
check("喜好 5 件且全在候选内", L.liked.length === 5 && L.liked.every((x) => L.candidates.includes(x)));
const p0 = lottery.payload(s);
check("payload 字段齐全", ["last_phase", "phase", "state", "select_list", "answer", "extra_item", "right_flag", "egg_num", "reward"]
  .every((k) => k in p0), JSON.stringify(Object.keys(p0)));
check("payload extra_item=兑奖券×5", p0.extra_item.item_id === 200001 && p0.extra_item.count === 5);
check("last_phase < phase (背景轮换)", p0.last_phase < p0.phase);

// ---- 2. 开蛋 ----
const cloverBefore = s.res.clover_point;
const houseBefore = s.items.house.length;
const r1 = lottery.openRound(s);
check("开蛋 code=0 + open_item 食物×1", r1.code === 0 && r1.open_item.count === 1 && r1.open_item.item_id >= 0 && r1.open_item.item_id <= 134,
  JSON.stringify(r1.open_item));
check("开蛋后 state=select", s.lottery.state === 1);
check("open_item 已入 house", s.items.house.some((x) => x.item_id === r1.open_item.item_id && x.count > 0));
check("重复开蛋被拒 (state!=open)", lottery.openRound(s).code === 1);

// ---- 3. 挑选 ----
check("选 4 件被拒", lottery.select(s, L.candidates.slice(0, 4)).code === 1);
check("选候选外物品被拒", lottery.select(s, [9999, 1, 2, 3, 4]).code === 1);
const picks = [...L.liked.slice(0, 3), ...L.candidates.filter((x) => !L.liked.includes(x)).slice(0, 2)];
const r2 = lottery.select(s, picks);
check("合法 5 件 code=0", r2.code === 0);
check("state=complete + rounds=1", s.lottery.state === 2 && s.lottery.rounds === 1);
check("right_flag 与 liked 对齐 (3 中)", s.lottery.rightFlag.join("") === "11100", s.lottery.rightFlag.join(""));
check("奖励 = 30 三叶草 (10×3)", s.lottery.reward[0].id === 200000 && s.lottery.reward[0].num === 30);

// ---- 4. 结算推进 ----
check("未到期不推进", lottery.tick(s, null, now + 1) === false);
const settleAt = s.lottery.settleAt;
check("到期推进 complete→reward", lottery.tick(s, null, settleAt + 1) === true && s.lottery.state === 3);
check("重复 tick 幂等", lottery.tick(s, null, settleAt + 2) === false);

// ---- 5. 领奖 ----
const pushes = [];
const push = (cmd, data) => pushes.push(cmd);
const cr = lottery.confirmReward(s, push);
check("confirm code=0", cr.code === 0);
check("三叶草入账 +30", s.res.clover_point === cloverBefore + 30);
check("推送 clover_update + lottery_load", pushes.includes("clover_update") && pushes.includes("lottery_load"));
check("confirm 后回 open 态且清上轮", s.lottery.state === 0 && s.lottery.answer.length === 0);
check("新轮候选已重掷", s.lottery.candidates.length === 8);

// ---- 6. 5 轮封盘 ----
for (let i = 2; i <= lottery.MAX_ROUNDS; i++) {
  assert.strictEqual(lottery.openRound(s).code, 0, `第${i}轮开蛋`);
  const l2 = s.lottery;
  lottery.select(s, l2.liked.slice(0, 5)); // 全命中
  lottery.tick(s, null, l2.settleAt + 1);
  const tkB = s.res.ticket;
  lottery.confirmReward(s, () => {});
  if (i === lottery.MAX_ROUNDS) {
    check("第 5 轮全命中奖励 = 30+50×4 草 + 末轮 5 券",
      s.res.clover_point === cloverBefore + 30 + 50 * 4 && s.res.ticket === tkB + 5,
      `clover=${s.res.clover_point} (期望 ${cloverBefore + 230}) ticket=${s.res.ticket}`);
  }
}
check("满 5 轮 payload select_list 为空 (客户端入口隐藏)", lottery.payload(s).select_list.length === 0);
check("满轮后再开蛋被拒", lottery.openRound(s).code === 1);

// ---- 7. 周末礼 (adsmgr_share type=3) ----
const s2 = saveMod.newSave();
lottery.node(s2, now);
const mailsB = s2.mails.length;
const pushes2 = [];
const r3 = lottery.claimExtra(s2, (c, d) => pushes2.push(c));
check("领取 code=0", r3.code === 0);
check("邮件 +1 带兑奖券", s2.mails.length === mailsB + 1 && s2.mails[s2.mails.length - 1].resource.ticket === 5);
check("推送 mail_load (不推 lottery_load, 防视图旧引用)", pushes2.includes("mail_load") && !pushes2.includes("lottery_load"));
check("payload extra 清零", lottery.payload(s2).extra_item.item_id === 0);
check("重复领取被拒", lottery.claimExtra(s2, () => {}).code === 1);

// ---- 8. 非周末门控 (构造下周一正午) ----
const d = new Date(now * 1000);
const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 7, 12);
const mondaySec = Math.floor(monday.getTime() / 1000);
const s3 = saveMod.newSave();
check("非周末开蛋被拒", lottery.openRound(s3, mondaySec).code === 1);
const p3 = lottery.payload(s3);
check("无档 payload 全空安全", p3.phase === 0 && p3.select_list.length === 0 && p3.extra_item.item_id === 0,
  JSON.stringify(p3).slice(0, 80));

// ---- 9. 周期滚动 ----
const s4 = saveMod.newSave();
const L4 = lottery.node(s4, now);
L4.rounds = 3;
const nextPhase = lottery.weekPhase(now) + 1;
const L4b = lottery.node(s4, now + 604800); // 下一周
check("跨周重建档 phase+1", L4b.phase === nextPhase && L4b.rounds === 0, `phase=${L4b.phase}`);
check("last_phase 继承旧 phase", L4b.lastPhase === L4.phase);

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
