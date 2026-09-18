/**
 * 周末小插曲 (lottery.js) —— 彩票/周末帮小伙伴挑礼物
 *
 * 客户端契约 (main.min.js LotteryModel/LotteryView/LotterySettleView 逆向):
 *   lottery_load          —— {last_phase, phase, state, select_list, answer,
 *                             extra_item:{item_id,count}, right_flag, egg_num, reward}
 *   lottery_open          → {open_item:{item_id,count}, extra_item}  开蛋即得+周末礼提示
 *   lottery_select {select:[物品id×5]} → {code}   帮小伙伴选 5 件礼物
 *   lottery_confirm_reward → {code}               结算领奖 → 下一轮
 *   adsmgr_share {type:3} → {code}                周末礼领取 → 邮件 (resource.ticket)
 *
 * 玩法: 周六 00:00 ~ 周一 00:00 开放 (客户端 getLeftTime 周六日返回>0)。
 *   小伙伴 (困困/胖胖/跳跳/嘟嘟, (phase-1)%4+1 轮换) 愁眉苦脸来求助 ——
 *   从 8 件候选食物里挑 5 件帮他送礼; 命中隐藏喜好的数量 (right_flag) 决定
 *   结算文案档位 (settle_desc[0..5]) 与三叶草奖励。一轮 = open→select→(10min)→reward→confirm。
 *   每周期最多 5 轮; 第 5 轮结算追加剧情文案 (extra_desc) + 兑奖券。
 *   周末礼 (extra_item): 每周期一次, 看广告/分享后经 adsmgr_share(3) 以邮件到账。
 *
 * 【自设计】(原版服务端不可考): 候选池=全部食物(type0); 喜好=候选随机 5 件;
 *   奖励=三叶草10×命中数, 末轮+兑奖券×5; open_item=随机食物×1; 结算延迟 10min。
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const ITEM_ROWS = Object.values(JSON.parse(fs.readFileSync(path.join(CFG, "MainData", "Item.json"), "utf-8")));
const FOOD_POOL = ITEM_ROWS.filter((r) => Number(r.type) === 0 && Number(r.id) >= 0).map((r) => Number(r.id));
// type14 资源型物品 (三叶草 200000 / 兑奖券 200001): 仅作 reward/extra 展示 id,
// 实际入账走 s.res (clover_point / ticket)
const ID_CLOVER = 200000, ID_TICKET = 200001;

const MAX_ROUNDS = 5;                       // 每周期轮数 (第 5 轮结算有加成剧情)
const CANDIDATE_N = 8, LIKED_N = 5;         // 候选 8 件, 隐藏喜好 5 件
const REWARD_PER_RIGHT = 10;                // 每命中一件 = 10 三叶草
const EXTRA_TICKETS = 5;                    // 周末礼 = 兑奖券×5 (一次抽奖的量)
const SETTLE_SEC = Number(process.env.FROG_LOTTERY_SETTLE_SEC || 600);

const STATE = { open: 0, select: 1, complete: 2, reward: 3 };
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nowSec = () => Math.floor(Date.now() / 1000);

/** 周期号: 以"本周一 00:00"为锚的周序号 (周末内稳定, 逐周 +1) */
function weekPhase(now) {
  const d = new Date(now * 1000);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return Math.floor(monday.getTime() / 1000 / 604800) + 1;
}

/** 周六/周日 (客户端 getLeftTime: 周六日返回剩余, 周一 00:00 归零) */
function isWeekend(now) {
  const day = new Date(now * 1000).getDay();
  return day === 6 || day === 0;
}

function newRound() {
  const candidates = shuffle([...FOOD_POOL]).slice(0, CANDIDATE_N);
  const liked = shuffle([...candidates]).slice(0, LIKED_N);
  return { candidates, liked };
}

/** 存档 lottery 节点兜底 + 周期滚动 */
function node(s, now) {
  let L = s.lottery;
  const phase = weekPhase(now);
  if (!L || L.phase !== phase) {
    // 新周期 (或首次): 保留上个周期的 last_phase 供结算背景轮换
    const last = L ? L.phase : Math.max(0, phase - 1);
    const { candidates, liked } = newRound();
    L = s.lottery = {
      phase, lastPhase: last, state: STATE.open, rounds: 0,
      candidates, liked,
      answer: [], rightFlag: [], reward: [],
      settleAt: 0,
      extraItem: { item_id: ID_TICKET, count: EXTRA_TICKETS },
      extraDone: L ? L.extraDone : 0, // 已领周末礼的周期
    };
  }
  return L;
}

/** 结算推进 (complete→reward); 服务器 tick / 请求前调用, 变化时推 lottery_load */
function tick(s, push, now) {
  const L = s.lottery;
  if (!L || L.state !== STATE.complete || now < L.settleAt) return false;
  L.state = STATE.reward;
  if (push) push("lottery_load", payload(s));
  return true;
}

function payload(s) {
  const L = s.lottery;
  if (!L) return { last_phase: 0, phase: 0, state: 0, select_list: [], answer: [], extra_item: { item_id: 0, count: 0 }, right_flag: [], egg_num: 0, reward: [] };
  // 周末礼已领 (本周期) → 下发 0 客户端不显示入口角标
  const extra = L.extraDone >= L.phase ? { item_id: 0, count: 0 } : L.extraItem;
  return {
    last_phase: L.lastPhase,
    phase: L.phase,
    state: L.state,
    select_list: L.rounds >= MAX_ROUNDS ? [] : L.candidates, // 满轮清空 → 客户端入口隐藏
    answer: L.answer,
    extra_item: extra,
    right_flag: L.rightFlag,
    egg_num: L.rounds, // 结算视图: 5==egg_num 追加剧情文案
    reward: L.reward,
  };
}

/** 开蛋: 即得随机食物 ×1, 进入挑选态 (候选本轮稳定; now 可注入供测试) */
function openRound(s, now = nowSec()) {
  if (!isWeekend(now)) return { code: 1 };
  const L = node(s, now);
  if (L.rounds >= MAX_ROUNDS) return { code: 1 };
  if (L.state !== STATE.open) return { code: 1 };
  // 候选保持本轮稳定 (confirmReward 时重掷下一轮): LotteryView 开弹窗时已按
  // 当前 select_list 建格子, 中途换候选会造成显示与校验不一致
  L.state = STATE.select;
  const open_item = { item_id: L.candidates[randInt(0, L.candidates.length - 1)], count: 1 };
  const row = s.items.house.find((x) => x.item_id === open_item.item_id);
  if (row) row.count += 1; else s.items.house.push({ item_id: open_item.item_id, count: 1 });
  const extra = L.extraDone >= L.phase ? { item_id: 0, count: 0 } : L.extraItem;
  return { code: 0, open_item, extra_item: extra };
}

/** 挑选 5 件; 命中 liked 记 right_flag, 进入 complete (等结算) */
function select(s, list) {
  const L = s.lottery;
  if (!L || L.state !== STATE.select) return { code: 1 };
  const picks = Array.isArray(list) ? list.map(Number) : [];
  if (picks.length !== 5 || !picks.every((id) => L.candidates.includes(id))) return { code: 1 };
  L.answer = picks;
  L.rightFlag = picks.map((id) => (L.liked.includes(id) ? 1 : 0));
  L.rounds += 1;
  L.state = STATE.complete;
  L.settleAt = nowSec() + SETTLE_SEC;
  // 奖励: 三叶草 10×命中; 第 5 轮追加兑奖券×5 (蛋形角标)
  const right = L.rightFlag.reduce((a, b) => a + b, 0);
  L.reward = [{ id: ID_CLOVER, num: right * REWARD_PER_RIGHT, is_egg: 0 }];
  if (L.rounds >= MAX_ROUNDS) L.reward.push({ id: ID_TICKET, num: EXTRA_TICKETS, is_egg: 1 });
  return { code: 0 };
}

/** 结算领奖 → 回到 open 态; 满轮则封盘 */
function confirmReward(s, push) {
  const L = s.lottery;
  if (!L || L.state !== STATE.reward) return { code: 1 };
  let clover = 0, ticket = 0;
  for (const r of L.reward) {
    if (r.id === ID_CLOVER) clover += Number(r.num) || 0;
    if (r.id === ID_TICKET) ticket += Number(r.num) || 0;
  }
  if (clover) { s.res.clover_point += clover; push("clover_update", { clover: s.res.clover_point }); }
  if (ticket) { s.res.ticket += ticket; push("item_update_ticket", { ticket: s.res.ticket }); }
  L.answer = []; L.rightFlag = []; L.reward = [];
  if (L.rounds >= MAX_ROUNDS) {
    L.state = STATE.open; // select_list 已清空 (payload) → 客户端入口隐藏
  } else {
    const { candidates, liked } = newRound();
    L.candidates = candidates; L.liked = liked;
    L.state = STATE.open;
  }
  push("lottery_load", payload(s));
  return { code: 0 };
}

/** 周末礼领取 (adsmgr_share type=3): 邮件到账 (客户端弹"叮咚~邮箱有动静") */
function claimExtra(s, push) {
  const L = s.lottery;
  if (!L || L.extraDone >= L.phase || !(L.extraItem.count > 0)) return { code: 1 };
  L.extraDone = L.phase;
  s.mailSeq = (s.mailSeq || 0) + 1;
  s.mails.push({
    id: s.mailSeq,
    type: 3, // Mail.EvtId.Gift
    title: "周末小插曲",
    message: "谢谢你的帮忙! 这份周末的小心意, 请收下吧。",
    sender: (L.phase - 1) % 4, // 困困/胖胖/跳跳/嘟嘟
    auto_open: false,
    expire: 0,
    read: false,
    opened: false,
    resource: { clover_point: 0, ticket: L.extraItem.count, reward_gacha: 0, ads_id: "", share_id: "" },
    items: [],
    pictures: [],
  });
  push("mail_load", s.mails);
  // 不推 lottery_load: adsmgr_share code=0 后客户端 onGetExtraItem 本地清 extra,
  // 推送替换 data 反而让开着的视图读到旧引用
  return { code: 0 };
}

module.exports = { node, tick, payload, openRound, select, confirmReward, claimExtra, isWeekend, weekPhase, MAX_ROUNDS };
