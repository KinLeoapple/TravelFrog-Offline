/**
 * 博物馆 (museum_load): 官方"地图"系统的静态部分 —— 5 省博物馆照片墙。
 *
 * 客户端契约 (main.min.js MuseumModel/MuseumListView 逆向):
 *   小仓库菜单 museumBtn → MuseumListView (requestMuseum 发 museum_load)
 *   响应 {museum_list: [{id, pic_list, collections}]}; 视图按 MuseumDB
 *   (Cooking/museumData.json, switch==1 才展示) 逐馆渲染:
 *     pic_list    = 玩家已拥有的该馆照片 (museumData.pic_id 交集)
 *     collections = 玩家已收集的该馆藏品 (collection_id 交集, Collection.json)
 *   展馆详情 (MuseumView): 照片墙 (back_pos 相框位) + 藏品 + 门票展示。
 */
const fs = require("fs");
const path = require("path");

const MUSEUMS = Object.values(JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "resource", "China", "config", "Cooking", "museumData.json"), "utf-8"
))).filter((m) => Number(m["switch"]) === 1)
  .map((m) => ({
    id: Number(m.id),
    pics: (m.pic_id || []).map(Number),
    colls: String(m.collection_id || "").split(",").map(Number).filter(Boolean),
  }));

/** 玩家照片全集 (归档/待归档/礼盒/回收站: 拥有过即点亮照片墙) */
function ownedPics(s) {
  const set = new Set();
  for (const p of [].concat(s.pictures || [], s.albumPending || [], s.giftPictures || [], s.albumDeleted || [])) {
    set.add(Number(p.pic_id));
  }
  return set;
}

/** museum_load 载荷 */
function payload(s) {
  const pics = ownedPics(s);
  const colls = new Set(s.handbook && s.handbook.collections || []);
  return {
    museum_list: MUSEUMS.map((m) => ({
      id: m.id,
      pic_list: m.pics.filter((id) => pics.has(id)),
      collections: m.colls.filter((id) => colls.has(id)),
    })),
  };
}

module.exports = { payload, MUSEUMS };
