/**
 * 动态照片引擎 (AnimPicture: 显影制作台)
 *
 * 官方语义 (main.min.js AnimPictureModel/AnimPictureMakePage 逆向):
 *   - animpicture_load 载荷 = {guide, page_num, phase, item_num, exp,
 *     exp_pic: [PictureInfo], pic_list: [{id, put_num, pictures: [PictureInfo]}]}
 *     · pic_map: 源照片 pic_id → 模板 id (animpictureData.list 1..6), 只有映射内
 *       的照片能制作; 模板 phase_list 按层叠加 spine 动画 (phase=已解锁层数)
 *     · select_pic: 新照片桶取一张 → 建页 {id, put_num:0, pictures: []}, phase =
 *       phase_list.length==1?0:1; canShowEmpty 要求 pic_list.length < page_num
 *       (动态相框 9001 是制页材料)
 *     · add_pic: 最多 5 张模板关联照片入 exp_pic (经验槽); remove_pic 取回
 *     · use_item: 消耗显影液 8002/8003/8004 (单色/双色/多色, 效果递增), 响应
 *       {phase}; phase==0 = 一轮显影完成 → item_num++, exp=0, exp_pic 全部
 *       退回新照片桶
 *     · get_item: 领取奖励 = 照片存储开启物 9002 × item_num (客户端 checkGetItem
 *       固定弹 9002)
 *   - guide: 引导步计数 (animpicture_guide 无参自增, 5 时弹 AnimPictureGuideView)
 *
 * 离线语义 (服务器权威; 官方数值黑盒, 已注明):
 *   - 经验: exp_pic 每张每分钟 +1 (5 张满槽 → 5/分), 相位阈值取模板 phase_list
 *     的 exp 字段 (50/80/120/150/180/220)
 *   - 显影液: 8002 +25 / 8003 +50 / 8004 +100 经验
 *   - 相框: 首页免费, 第 2 页起每页消耗 1× 9001 动态相框
 *   - 材料来源: 旅行归来 12% 带回 1 件 (8002 权重5 / 8003 权重3 / 8004 权重1 /
 *     9001 权重1) —— 与祈愿木片并列的旅行材料掉落
 */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "resource", "China", "config");
const AP = JSON.parse(fs.readFileSync(path.join(CFG, "animpicture", "animpictureData.json"), "utf-8"));
const LIST = AP.list || {};                 // 模板 id → {phase_list, pic_list}
const PIC_MAP = AP.pic_map || {};           // 源照片 pic_id → 模板 id
const FLUID_EXP = { 8002: 25, 8003: 50, 8004: 100 };
const FRAME_ID = 9001;                      // 动态相框
const REWARD_ID = 9002;                     // 照片存储开启物
const EXP_PER_PHOTO_PER_MIN = 1;
const MAX_EXP_PIC = 5;

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * s.animpic = {guide, phase, item_num, exp, exp_pic: [照片对象],
 *   pic_list: [{id, put_num, pictures: [照片对象|null]}], lastAt: ts}
 */
function node(s) {
  if (!s.animpic) {
    s.animpic = { guide: 0, phase: 0, item_num: 0, exp: 0, exp_pic: [], pic_list: [], lastAt: 0 };
  }
  return s.animpic;
}

/** 挂机经验结算 + 相位推进; 返回 true 表示状态变化 (调用方推载荷) */
function tick(s, now) {
  const a = node(s);
  if (!a.lastAt || (a.phase === 0 && a.exp_pic.length === 0)) {
    a.lastAt = now;
    return false;
  }
  const gain = Math.floor((now - a.lastAt) / 60) * a.exp_pic.length * EXP_PER_PHOTO_PER_MIN;
  a.lastAt = now;
  if (gain <= 0) return false;
  return addExp(s, gain, now);
}

/** 经验入账 + 相位推进; phase 推到头 → 完成一轮 (照片退桶, item_num++) */
function addExp(s, amount, now) {
  const a = node(s);
  const page = a.pic_list[a.pic_list.length - 1];
  const tpl = page ? LIST[page.id] : null;
  a.exp += amount;
  let changed = true;
  if (!tpl || a.phase === 0) return changed; // 无进行中页: 经验只在制作中生效
  while (a.phase < tpl.phase_list.length && a.exp >= Number(tpl.phase_list[a.phase].exp)) {
    a.phase++;
    if (a.phase >= tpl.phase_list.length) {
      // 一轮显影完成: 照片退回新照片桶, 奖励计数
      a.phase = 0;
      a.item_num++;
      a.exp = 0;
      for (const pic of a.exp_pic) s.albumPending.push(pic);
      a.exp_pic = [];
      break;
    }
  }
  return changed;
}

/** house 物品数 */
function houseCount(s, id) {
  const row = s.items.house.find((x) => x.item_id === id);
  return row ? row.count : 0;
}
function addHouse(s, id, n) {
  const row = s.items.house.find((x) => x.item_id === id);
  if (row) row.count += n;
  else if (n > 0) s.items.house.push({ item_id: id, count: n });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
}

/** 可用页数 = 1 免费页 + 持有动态相框 */
function pageNum(s) {
  return 1 + houseCount(s, FRAME_ID);
}

/** animpicture_load 载荷 */
function payload(s, withLayers) {
  const a = node(s);
  const ser = (p) => (p && p.pic_id ? withLayers(p) : p);
  return {
    guide: a.guide,
    page_num: pageNum(s),
    phase: a.phase,
    item_num: a.item_num,
    exp: a.exp,
    exp_pic: a.exp_pic.map(ser),
    pic_list: a.pic_list.map((pg) => ({
      id: pg.id, put_num: pg.put_num, pictures: pg.pictures.map(ser),
    })),
  };
}

/** select_pic {id}: 新照片桶的照片建页 (pic_map 映射 + 页数/相框校验) */
function selectPic(s, photoId) {
  const a = node(s);
  const idx = s.albumPending.findIndex((p) => p.id === Number(photoId));
  if (idx < 0) return { code: 1 };
  const tplId = PIC_MAP[String(s.albumPending[idx].pic_id)];
  const tpl = tplId != null ? LIST[tplId] : null;
  if (!tpl) return { code: 1 };
  if (a.phase !== 0) return { code: 1 }; // 上一页还在显影中
  if (a.pic_list.length >= pageNum(s)) return { code: 1 };
  if (a.pic_list.length >= 1) {
    if (houseCount(s, FRAME_ID) < 1) return { code: 1 };
    addHouse(s, FRAME_ID, -1); // 第 2 页起消耗动态相框
  }
  s.albumPending.splice(idx, 1);
  a.pic_list.push({ id: Number(tplId), put_num: 0, pictures: [] });
  a.phase = tpl.phase_list.length === 1 ? 0 : 1;
  a.exp = 0;
  a.lastAt = Math.floor(Date.now() / 1000); // 挂机经验从建页起算
  return { code: 0 };
}

/** add_pic {ids: [照片 uid]}: 模板关联照片入经验槽 (≤5) */
function addPic(s, ids) {
  const a = node(s);
  const page = a.pic_list[a.pic_list.length - 1];
  if (!page) return { code: 1 };
  const allow = new Set((LIST[page.id] && LIST[page.id].pic_list) || []);
  for (const id of ids || []) {
    if (a.exp_pic.length >= MAX_EXP_PIC) break;
    const idx = s.albumPending.findIndex((p) => p.id === Number(id));
    if (idx < 0 || !allow.has(s.albumPending[idx].pic_id)) continue;
    a.exp_pic.push(s.albumPending.splice(idx, 1)[0]);
  }
  a.lastAt = Math.floor(Date.now() / 1000); // 槽变动重置挂机计时
  return { code: 0 };
}

/** remove_pic {index, is_delete}: 经验槽照片退回新照片桶 (1-based) */
function removePic(s, index) {
  const a = node(s);
  const i = Number(index) - 1;
  if (i < 0 || i >= a.exp_pic.length) return { code: 1 };
  s.albumPending.push(a.exp_pic.splice(i, 1)[0]);
  return { code: 0 };
}

/** open_album {index}: 页内加一槽 (put_num++) */
function openAlbum(s, index) {
  const a = node(s);
  const pg = a.pic_list[Number(index) - 1];
  if (!pg) return { code: 1 };
  pg.put_num++;
  pg.pictures.push(null);
  return { code: 0 };
}

/** album_add_pic {anim_index, pic_index, pic_uid}: 新照片桶 → 页槽 */
function albumAddPic(s, animIndex, picIndex, picUid) {
  const a = node(s);
  const pg = a.pic_list[Number(animIndex) - 1];
  if (!pg) return { code: 1 };
  const slot = Number(picIndex) - 1;
  if (slot < 0 || slot > pg.pictures.length) return { code: 1 };
  const idx = s.albumPending.findIndex((p) => p.id === Number(picUid));
  if (idx < 0) return { code: 1 };
  const pic = s.albumPending.splice(idx, 1)[0];
  if (slot === pg.pictures.length) pg.pictures.push(pic);
  else pg.pictures[slot] = pic;
  return { code: 0 };
}

/** album_remove_pic {anim_index, pic_index, is_delete}: 页槽照片退桶 */
function albumRemovePic(s, animIndex, picIndex) {
  const a = node(s);
  const pg = a.pic_list[Number(animIndex) - 1];
  if (!pg) return { code: 1 };
  const slot = Number(picIndex) - 1;
  if (slot < 0 || slot >= pg.pictures.length || !pg.pictures[slot]) return { code: 1 };
  s.albumPending.push(pg.pictures[slot]);
  pg.pictures[slot] = null;
  return { code: 0 };
}

/**
 * use_item {id: 8002|8003|8004}: 消耗显影液 → 经验跳档 → 返回新 phase
 * (客户端只读响应的 phase 字段)
 */
function useItem(s, itemId, now) {
  const a = node(s);
  const boost = FLUID_EXP[Number(itemId)];
  if (!boost) return { code: 1, phase: a.phase };
  if (a.phase === 0) return { code: 1, phase: a.phase }; // 无进行中页
  if (houseCount(s, Number(itemId)) < 1) return { code: 1, phase: a.phase };
  addHouse(s, Number(itemId), -1);
  a.lastAt = now;
  addExp(s, boost, now);
  return { code: 0, phase: a.phase };
}

/** get_item: 领取完成奖励 (照片存储开启物 × item_num) */
function getItem(s) {
  const a = node(s);
  if (a.item_num <= 0) return { code: 1 };
  const n = a.item_num;
  addHouse(s, REWARD_ID, n);
  a.item_num = 0;
  return { code: 0, item_id: REWARD_ID, count: n };
}

/** guide: 计数 +1 */
function guide(s) {
  const a = node(s);
  a.guide++;
  return { code: 0 };
}

/** 旅行材料掉落: 12% 一件 (显影液/相框) */
function rollDrop() {
  if (Math.random() >= 0.12) return -1;
  const table = [8002, 8002, 8002, 8002, 8002, 8003, 8003, 8003, 8004, FRAME_ID];
  return table[randInt(0, table.length - 1)];
}

module.exports = {
  LIST, PIC_MAP, FLUID_EXP, FRAME_ID, REWARD_ID, MAX_EXP_PIC,
  payload, tick, selectPic, addPic, removePic,
  openAlbum, albumAddPic, albumRemovePic, useItem, getItem, guide, rollDrop,
};
