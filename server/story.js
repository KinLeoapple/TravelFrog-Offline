/**
 * 涂鸦派对故事 (StoryData/story.json, 25 件派对纪念品)
 *
 * 玩法 (客户端 StoryModel/StoryView 逆向):
 *   - 聚会回家随机带回未拥有的故事纪念品 → new_story_id 红点 + story_load 推送
 *   - 阅读新故事 → story_read_new_story (客户端本地清零, 服务端必须同步清)
 *   - 给故事送礼: story_send_gift {id, gift} —— 客户端 consumeHouseItem 只做
 *     校验不扣货, 扣减必须服务端做; 送出后延迟收到邻居回礼邮件 (type 6
 *     StoryGift), 拆信可选回 story_feedback_gift 致谢 (客户端 fire-and-forget)
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");

const STORY_ROWS = (() => {
  const t = JSON.parse(fs.readFileSync(path.join(CFG, "StoryData", "story.json"), "utf-8"));
  return t.story || [];
})();
const STORY_BY_ID = new Map(STORY_ROWS.map((s) => [s.storyid, s]));
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** 送礼后的回礼邮件延迟 (秒): 官方为异步邮寄, 取 2~4h 制造时延感 */
const GIFT_MAIL_DELAY = () => randInt(2 * 3600, 4 * 3600);

/** 聚会回家掉落: 随机一件未拥有的故事纪念品 (集齐返回 null) */
function dropStory(s) {
  const pool = STORY_ROWS
    .map((r) => r.storyid)
    .filter((id) => !(s.stories || []).some((x) => x.id === id));
  if (!pool.length) return null;
  const id = pool[randInt(0, pool.length - 1)];
  if (!Array.isArray(s.stories)) s.stories = [];
  s.stories.push({ id, gift: -1 });
  s.new_story_id = id;
  return id;
}

/**
 * 送礼: 校验 + 服务端扣货 (客户端只校验不扣) + 排程回礼
 * @returns {boolean}
 */
function sendGift(s, id, giftId, takeItem) {
  const story = (s.stories || []).find((x) => x.id === Number(id));
  if (!story || story.gift !== -1) return false;
  if (!(Number(giftId) > 0) || !takeItem(Number(giftId), 1)) return false;
  story.gift = Number(giftId);
  story.giftAt = Math.floor(Date.now() / 1000) + GIFT_MAIL_DELAY();
  return true;
}

/**
 * 回礼邮件到期检查 (tick 驱动): 送出过的故事到点寄来回礼
 * @returns {boolean} 是否发出了邮件 (调用方推送 mail_load)
 */
function storyTick(s) {
  const now = Math.floor(Date.now() / 1000);
  let sent = false;
  for (const story of s.stories || []) {
    if (!(story.giftAt > 0) || story.giftAt > now) continue;
    const row = STORY_BY_ID.get(story.id);
    s.mailSeq = (s.mailSeq || 0) + 1;
    s.mails.push({
      id: s.mailSeq,
      type: 6, // Mail.EvtId.StoryGift (客户端显示 mail_friendGiftIcon)
      title: "谢谢你送的礼物",
      message: (row ? "关于「" + row.name + "」的故事收到啦，" : "") +
        "小伙伴们都很开心! 随信附上一点小心意。",
      sender: -1,
      auto_open: false,
      expire: 0,
      read: false,
      opened: false,
      resource: { clover_point: randInt(20, 40), ticket: 0, reward_gacha: 0, ads_id: "", share_id: "" },
      items: [],
      pictures: [],
    });
    story.giftAt = 0; // 已寄出
    sent = true;
  }
  return sent;
}

module.exports = { dropStory, sendGift, storyTick, STORY_BY_ID };
