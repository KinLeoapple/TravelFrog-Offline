/**
 * 成就任务 + 故事 + 彩蛋时刻验证:
 *   A. task.js: 进度计算 (旅行次数/照片含蛙/合影/笔记/套装) 与 task_load 载荷
 *   B. task_get_reward: 领奖校验 / 三叶草与道具发奖推送 / 重复领取拒绝
 *   C. 故事: 聚会掉落 → story_read_new_story 清红点 → send_gift 扣货排程 → 回礼邮件到期
 *   D. misc_moment_unlock 幂等 + client_set_icon 持久化
 * 进程内, 无需服务器
 * 运行: node test_tasks.js
 */
const saveMod = require("../save");
const travel = require("../travel");
const taskMod = require("../task");
const storyMod = require("../story");
const photo = require("../photo");
const handlersMod = require("../handlers");
const handlers = handlersMod.handlers;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

function mkCtx(s) {
  const ctx = { save: s, pushed: [], reply() {}, synced: true };
  ctx.push = (cmd, data) => ctx.pushed.push({ cmd, data });
  return ctx;
}
const run = (s, cmd, data) => handlers[cmd.replace(/\./g, "_")](mkCtx(s), data || {});

// --- A. 进度计算 ---
(() => {
  const s = saveMod.newSave("tk_a");
  // 旅行回来 1 次
  s.travel.tripCount = 1;
  // 笔记: 1 见闻 + 1 旅友
  s.note_list.push({ id: 100, read: 1, timestamp: 1 }, { id: 2000, read: 1, timestamp: 1 });
  // 含蛙照片 x1 + 合影 x1 (从配置表里挑真实存在的)
  let frogPic = null, compPic = null;
  for (const [id, row] of photo.PICTURE_DB) {
    if (frogPic == null && row.frogPose && photo.composeLayers(id)) frogPic = id;
    if (compPic == null && (row.travelerPose || []).some(Boolean)) {
      const layers = photo.composeLayers(id);
      if (layers && layers.some((l) => {
        const n = photo.nameOfTexId(l.layer[0]);
        return n && /_(bh|cw|yhc)$/i.test(n);
      })) compPic = id;
    }
    if (frogPic != null && compPic != null) break;
  }
  s.pictures.push({ id: 1, pic_id: frogPic, read: 1, new: 0 });
  s.pictures.push({ id: 2, pic_id: compPic, read: 1, new: 0 });

  const pro = taskMod.progressMap(s);
  check("A1 旅行回来 1 次 → 任务1 进度 1", pro[1] === 1, `pro[1]=${pro[1]}`);
  check("A2 笔记 2 篇 → 任务102 进度 2 (未封顶)", pro[102] === 2, `pro[102]=${pro[102]}`);
  check("A2b 进度封顶不超过 count (任务101 count=1)", pro[101] === 1, `pro[101]=${pro[101]}`);
  check("A3 旅友笔记 1 篇 → 任务103 进度 1", pro[103] === 1, `pro[103]=${pro[103]}`);
  check("A4 含蛙照片 → 任务7 进度 1", pro[7] === 1, `pro[7]=${pro[7]}`);
  check("A5 合影 → 任务9 进度 1", pro[9] === 1, `pro[9]=${pro[9]}`);

  const pl = taskMod.payload(s);
  check("A6 载荷含全部 30 项且带 pro/is_reward",
    pl.tasks.length === 30 && pl.tasks.every((t) => typeof t.pro === "number" && t.is_reward === 0));

  // 面板打开时客户端主动拉取 (GuideTaskViewControl.open): 兜底 {code:0} 会清空成就
  const r = run(s, "task.load", {});
  check("A7 task.load 请求回完整载荷 (面板打开不清空)",
    r.code === 0 && r.tasks.length === 30 && r.tasks.every((t) => typeof t.pro === "number")
    && r.list.length === 67 && r.list.every((t) => typeof t.pro === "number"),
    `tasks=${(r.tasks || []).length} list=${(r.list || []).length}`);
})();

// --- B. 领奖 ---
(() => {
  const s = saveMod.newSave("tk_b");
  s.travel.tripCount = 1; // 任务1 可领: 200000 x10 (三叶草)
  const cloverBefore = s.res.clover_point;

  const ctx = mkCtx(s);
  const r1 = handlers["task_get_reward"](ctx, { id: 1 });
  const push = ctx.pushed.find((p) => p.cmd === "clover_update");
  check("B1 领奖响应 code 0", r1.code === 0, JSON.stringify(r1));
  check("B2 三叶草入账推送", !!push && push.data.clover >= cloverBefore + 10,
    push ? `clover=${push.data.clover}` : "无推送");
  check("B3 台账记录", s.tasks.includes(1));
  check("B4 重复领取被拒", run(s, "task.get_reward", { id: 1 }).code === 1);

  // 道具奖励: 任务101 (笔记1篇, 奖 1000 四叶草护符 x1)
  s.note_list.push({ id: 100, read: 1, timestamp: 1 });
  const ctx3 = mkCtx(s);
  handlers["task_get_reward"](ctx3, { id: 101 });
  const itemPush = ctx3.pushed.find((p) => p.cmd === "item_update");
  check("B5 道具入账推送", !!itemPush && itemPush.data.item.item_id === 1000,
    itemPush ? JSON.stringify(itemPush.data.item) : "无推送");
  check("B6 四叶草累计计数 (成就902)", (s.stats.fourLeafGained || 0) >= 1, `fourLeaf=${s.stats.fourLeafGained}`);

  // 未达成领取被拒
  check("B7 未达成领取被拒", run(s, "task.get_reward", { id: 2 }).code === 1);
})();

// --- C. 故事 ---
(() => {
  const s = saveMod.newSave("tk_c");
  // 掉落
  const id = storyMod.dropStory(s);
  check("C1 聚会掉落故事并置红点", id != null && s.stories.length === 1 && s.new_story_id === id);
  // 阅读清红点
  check("C2 story_read 清红点", run(s, "story.read_new_story").code === 0 && s.new_story_id === 0);
  // 送礼: 无货被拒 (8000 材料不在初始背包)
  check("C3 送礼无货被拒", run(s, "story.send_gift", { id, gift: 8000 }).code === 1 && s.stories[0].gift === -1);
  // 送礼: 有货成功
  s.items.house.push({ item_id: 101, count: 2 });
  const ctx = mkCtx(s);
  handlers["story_send_gift"](ctx, { id, gift: 101 });
  const row = s.items.house.find((x) => x.item_id === 101);
  check("C4 送礼扣货 + 台账 + 排程回礼",
    s.stories[0].gift === 101 && row && row.count === 1 && s.stories[0].giftAt > Date.now() / 1000);
  check("C5 送礼推送 item_update", ctx.pushed.some((p) => p.cmd === "item_update" && p.data.item.count === 1));
  check("C6 重复送礼被拒", run(s, "story.send_gift", { id, gift: 101 }).code === 1);
  // 回礼未到期不寄
  check("C7 未到期不寄回礼", storyMod.storyTick(s) === false && s.mails.length === 0);
  // 到期寄信 (type 6 StoryGift)
  s.stories[0].giftAt = Math.floor(Date.now() / 1000) - 1;
  check("C8 到期寄出 StoryGift 邮件",
    storyMod.storyTick(s) === true && s.mails.length === 1 && s.mails[0].type === 6);
  check("C9 回执 story_feedback_gift", run(s, "story.feedback_gift", { id }).code === 0);
})();

// --- D. 时刻 + 头像 ---
(() => {
  const s = saveMod.newSave("tk_d");
  run(s, "misc.moment_unlock", { id: 3 });
  run(s, "misc.moment_unlock", { id: 3 });
  check("D1 时刻解锁幂等", s.moments.length === 1 && s.moments[0] === 3);
  run(s, "client.set_icon", { id: 5 });
  check("D2 头像持久化", s.frog.icon === 5);
})();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
