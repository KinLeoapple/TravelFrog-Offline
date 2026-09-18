/**
 * 装饰插花 (室内花瓶)
 *
 * 官方语义 (main.min.js 逆向):
 *   - client_load_decorate {has_list, put_id, status}: 客户端 decorationList =
 *     convertArray(has_list) (条目 {id: 装饰id, num}), put_id = 当前插的花,
 *     status 1=花苞 2=绽放 (pic[status-1] 选图)
 *   - changeDecoration(id): send client_change_decorate {id}, code 0 时客户端
 *     本地扣旧花 (decorationList 中 id==putID 条目 num--, 归零 splice) +
 *     putID=新花 + status=1 —— 据此反推服务器语义 (Design B):
 *     插新花不消耗库存 (花仍在 has_list), 换花时旧花被用掉 (扣 1)
 *   - decoration.json 32 项 (100-106 礼物花/1001-1005 野草/10011-10063 种植花),
 *     与 Item.json type14 插花物品按名字一一对应 (32/32 全匹配)
 */
const fs = require("fs");
const path = require("path");

const CFG_DIR = path.join(__dirname, "..", "resource", "China", "config");
const read = (p) => JSON.parse(fs.readFileSync(path.join(CFG_DIR, p), "utf-8"));

const DECORATION_TABLE = read(path.join("Decoration", "decoration.json"));
const DECORATION_BY_ID = new Map(Object.keys(DECORATION_TABLE).map((k) => [Number(k), DECORATION_TABLE[k]]));

// 装饰 id <-> type14 插花物品 id (按名字一一对应)
const ITEM_BY_DEC = new Map();
const DEC_BY_ITEM = new Map();
(() => {
  const t = read(path.join("MainData", "Item.json"));
  const arr = Array.isArray(t) ? t : Object.values(t);
  for (const it of arr) {
    if (Number(it.type) !== 14 || !it.name) continue;
    for (const [decId, row] of DECORATION_BY_ID) {
      if (row.name === it.name) {
        ITEM_BY_DEC.set(decId, Number(it.id));
        DEC_BY_ITEM.set(Number(it.id), decId);
        break;
      }
    }
  }
})();

// 【自设计】绽放节奏 (原版服务端不可考): 花苞 1h 后绽放
const BLOOM_SEC = Math.max(10, Number(process.env.FROG_DECORATE_BLOOM_SEC || 3600));

const nowSec = () => Math.floor(Date.now() / 1000);

/** 存档 decorate 节点兜底 (挂在 furniture 下, 与 tumbler/pocket 同级) */
function node(s) {
  const f = s.furniture || (s.furniture = {});
  if (!f.decorate) f.decorate = { putId: 0, status: 0, putAt: 0 };
  if (typeof f.decorate.putId !== "number") f.decorate.putId = 0;
  if (typeof f.decorate.status !== "number") f.decorate.status = 0;
  if (typeof f.decorate.putAt !== "number") f.decorate.putAt = 0;
  return f.decorate;
}

/** client_load_decorate 载荷: has_list = house 中 type14 花按名映射装饰 id */
function decoratePayload(s) {
  const d = node(s);
  const has_list = [];
  for (const row of s.items.house) {
    const decId = DEC_BY_ITEM.get(Number(row.item_id));
    if (decId && row.count > 0) has_list.push({ id: decId, num: row.count });
  }
  return { has_list, put_id: d.putId, status: d.status };
}

/** house 物品增减 (与 handlers.js 同语义) */
function addItem(s, itemId, count) {
  const row = s.items.house.find((x) => x.item_id === itemId);
  if (row) row.count += count;
  else s.items.house.push({ item_id: itemId, count });
  if (row && row.count <= 0) s.items.house = s.items.house.filter((x) => x.count > 0);
}

/**
 * 插花/换花 (client_change_decorate {id}):
 * Design B —— 插新花不消耗库存; 换花时旧花被用掉 (客户端扣旧花逻辑反推)。
 * @returns {{code:number}} code 0=成功 2=没有这朵花
 */
function changeDecorate(s, id) {
  const d = node(s);
  const decId = Number(id);
  if (!DECORATION_BY_ID.has(decId)) return { code: -1 };
  const itemId = ITEM_BY_DEC.get(decId);
  const row = itemId ? s.items.house.find((x) => x.item_id === itemId) : null;
  if (!row || row.count <= 0) return { code: 2 };
  if (d.putId && d.putId !== decId) {
    const oldItemId = ITEM_BY_DEC.get(d.putId);
    if (oldItemId) addItem(s, oldItemId, -1); // 旧花用掉
  }
  d.putId = decId;
  d.status = 1; // 花苞
  d.putAt = nowSec();
  return { code: 0 };
}

/**
 * 绽放推进 (travelTick 驱动): status 1 → 2 经 BLOOM_SEC。
 * 返回 true 表示状态变化 (调用方推 client_load_decorate)。
 */
function decorateTick(s, now) {
  const d = node(s);
  if (d.status !== 1) return false;
  if (now - d.putAt < BLOOM_SEC) return false;
  d.status = 2;
  return true;
}

module.exports = { node, decoratePayload, changeDecorate, decorateTick, DECORATION_BY_ID, ITEM_BY_DEC, DEC_BY_ITEM };
