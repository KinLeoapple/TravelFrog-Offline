/**
 * 旅行地图 35 城官方数据 (map_cities.js)
 * 城市表原样提取自官方 prism-qingwa-map 页 webpack 包内嵌的
 * {city, city_name, city_title, latitude, longitude, defaultImg} 表
 * (取证: 官方截图/assets/de9fc90f_0.js, 2026-09-18, 停服前)。
 * 照片归城: Picture.json 的 place 字段 1..35 与城市一一对应;
 * 无 place 的活动照 / 100+ 博物馆照按地理位置归入最近官方城市。
 */
const fs = require("fs");
const path = require("path");

const CITIES = [
  { city: "g_beijing", name: "北京", lng: 116.414668, lat: 39.852476 },
  { city: "g_tianjin", name: "天津", lng: 117.208431, lat: 38.978269 },
  { city: "g_ningxia", name: "宁夏", lng: 106.20741, lat: 38.375579 },
  { city: "g_qingdao", name: "青岛", lng: 120.378102, lat: 36.073841 },
  { city: "g_chengdu", name: "成都", lng: 104.0348, lat: 30.3935 },
  { city: "g_yunnan", name: "云南", lng: 102.4218, lat: 25.023 },
  { city: "g_lasa", name: "拉萨", lng: 91.06, lat: 29.39 },
  { city: "g_shanghai", name: "上海", lng: 121.2811, lat: 31.1354 },
  { city: "g_suzhou", name: "苏州", lng: 120.639194, lat: 31.272421 },
  { city: "g_hangzhou", name: "杭州", lng: 120.12, lat: 30.16 },
  { city: "g_hainan", name: "海南", lng: 109.834981, lat: 19.259396 },
  { city: "g_guilin", name: "桂林", lng: 110.1048, lat: 25.1404 },
  { city: "g_guangzhou", name: "广州", lng: 113.15, lat: 23.07 },
  { city: "g_xianggang", name: "香港", lng: 114.202397, lat: 22.243194 },
  { city: "g_tw_kending", name: "垦丁", lng: 120.803042, lat: 21.991696 },
  { city: "g_tw_shifen", name: "十分", lng: 121.529894, lat: 24.795443 },
  { city: "g_haerbin", name: "哈尔滨", lng: 126.3145, lat: 45.4805 },
  { city: "g_liaoning", name: "辽宁", lng: 123.2653, lat: 41.4744 },
  { city: "g_zhangjiajie", name: "张家界", lng: 110.2844, lat: 29.0701 },
  { city: "g_wuhan", name: "武汉", lng: 114.19, lat: 30.35 },
  { city: "g_luoyang", name: "洛阳", lng: 112.2715, lat: 34.371 },
  { city: "g_anhui", name: "安徽", lng: 117.16, lat: 31.51 },
  { city: "g_xian", name: "西安", lng: 108.5633, lat: 34.154 },
  { city: "g_jiuquan", name: "酒泉", lng: 98.2938, lat: 39.4402 },
  { city: "g_chongqing", name: "重庆", lng: 106.33, lat: 29.33 },
  { city: "g_guizhou", name: "贵州", lng: 106.4222, lat: 26.3423 },
  { city: "g_fujian", name: "福建", lng: 119.17, lat: 26.09 },
  { city: "g_jiangxi", name: "江西", lng: 115.5255, lat: 28.3649 },
  { city: "g_shanxi", name: "山西", lng: 112.5787, lat: 37.8139 },
  { city: "g_jilin", name: "吉林", lng: 125.3548, lat: 43.8848 },
  { city: "g_aomen", name: "澳门", lng: 113.54, lat: 22.19 },
  { city: "g_qinghai", name: "青海", lng: 101.78, lat: 36.62 },
  { city: "g_hebei", name: "河北", lng: 114.51, lat: 38.04 },
  { city: "g_neimenggu", name: "内蒙古", lng: 111.75, lat: 40.84 },
  { city: "g_xinjiang", name: "新疆", lng: 87.62, lat: 43.83 },
];

// Picture.json place → 城市键 (place 1..35)
const PLACE_CITY = {
  1: "g_beijing", 2: "g_chengdu", 3: "g_chongqing", 4: "g_guangzhou", 5: "g_guilin",
  6: "g_hangzhou", 7: "g_suzhou", 8: "g_tianjin", 9: "g_tw_shifen", 10: "g_tw_kending",
  11: "g_xianggang", 12: "g_haerbin", 13: "g_zhangjiajie", 14: "g_wuhan", 15: "g_luoyang",
  16: "g_xian", 17: "g_jiuquan", 18: "g_yunnan", 19: "g_lasa", 20: "g_shanghai",
  21: "g_hainan", 22: "g_guizhou", 23: "g_ningxia", 24: "g_fujian", 25: "g_jiangxi",
  26: "g_anhui", 27: "g_liaoning", 28: "g_qingdao", 29: "g_shanxi", 30: "g_jilin",
  31: "g_aomen", 32: "g_qinghai", 33: "g_hebei", 34: "g_neimenggu", 35: "g_xinjiang",
};

// 无 place / 100+ 的特殊照片键 → 城市 (地理就近)
// bwg_* 博物馆日, sanxia 三峡 (大坝在湖北宜昌), g_hhly 黄河流域活动
// (壶口瀑布主体在山西吉县, 小浪底在洛阳), changbaishan 长白山归吉林
const SPECIAL_KEY = {
  bwg_jiangxi: "g_jiangxi", bwg_shandong: "g_qingdao", bwg_nanyuewang: "g_guangzhou",
  bwg_wuwenhua: "g_suzhou", bwg_shanxi: "g_shanxi",
  sanxia: "g_wuhan", g_hhly_hkpp: "g_shanxi", g_hhly_xld: "g_luoyang",
  changbaishan: "g_jilin",
};

// pic_id → 城市键
const PIC_CITY = (() => {
  const t = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "resource", "China", "config", "PictureData", "Picture.json"), "utf-8"));
  const rows = Array.isArray(t) ? t : Object.values(t);
  const map = {};
  for (const r of rows) {
    if (typeof r.id !== "number") continue;
    const key = String(r.name || "").replace(/\d+.*$/, ""); // beijing1_s → beijing
    const city = PLACE_CITY[r.place] || SPECIAL_KEY[key] ||
      (CITIES.some((c) => c.city === "g_" + key) ? "g_" + key : null);
    if (city) map[r.id] = city;
  }
  return map;
})();

// 存档 → 地图页 payload: 全部 35 城 (status=1 已点亮), 附照片 id 列表
function payload(save) {
  const groups = {}; // city → pic_id[]
  const seen = {};   // city → Set(pic_id) 去重
  for (const p of [].concat(save.pictures || [], save.albumPending || [], save.giftPictures || [])) {
    const city = PIC_CITY[Number(p.pic_id)];
    if (!city) continue;
    (seen[city] = seen[city] || new Set()).add(Number(p.pic_id));
  }
  for (const [city, set] of Object.entries(seen)) groups[city] = [...set];
  return {
    cities: CITIES.map((c) => ({
      city: c.city, name: c.name, lng: c.lng, lat: c.lat,
      status: groups[c.city] ? 1 : 0,
      count: groups[c.city] ? groups[c.city].length : 0,
      pics: groups[c.city] || [],
    })),
  };
}

module.exports = { CITIES, PIC_CITY, payload };
