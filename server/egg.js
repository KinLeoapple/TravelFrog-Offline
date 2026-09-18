/**
 * 彩蛋引擎 (easteregg_load): 服务端决定当前激活的彩蛋集合, 客户端据此
 * 渲染彩蛋并开放"抓拍" (misc_moment_unlock) 触发链路。
 *
 * 客户端契约 (main.min.js EasterEggModel 逆向):
 *   easteregg_load {egg_list: [id]} —— 整表替换
 *   hasEgg(id): 雨具变体 (egg_101_rain_dd 等) 只在对应彩蛋激活时播放;
 *   hasFrogEgg() (id 1..5): 蛙在家播稀有动作 (照镜子/吃饭/做饭/粽子/吃西瓜),
 *   并影响屋内灯光; 抓拍判定 curAnimName == momentData.param。
 *
 * 彩蛋枚举 (Tabikaeru.EasterEgg):
 *   1 Grooming 梳毛照镜子 / 2 Drowsy 埋头干饭 / 3 Cook 扇风做饭
 *   4 Zongzi 端午粽子 / 5 Watermelon 夏日西瓜          —— 蛙彩蛋 (状态机调度)
 *   101 DDShelter 嘟嘟雨具 / 102 TTShelter 跳跳 / 103 KKShelter 困困
 *   104 PPShelter 胖胖                                  —— 雨天 NPC (纯计算)
 *   201 FireFly 萤火虫 (夏夜庭院, 抓拍区 rect)          —— 纯计算
 */
const WEATHER_RAIN = new Set([3, 4]); // WeatherType.light_rain / heavy_rain

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// 蛙彩蛋调度参数 (env 可调, 便于测试)
const PACE = {
  ROLL_SEC: Number(process.env.FROG_EGG_ROLL_SEC || 2 * 3600),   // 蛋间隔 2~4h
  ROLL_JITTER: Number(process.env.FROG_EGG_JITTER_SEC || 2 * 3600),
  DURATION_MIN: Number(process.env.FROG_EGG_MIN_SEC || 20 * 60), // 单蛋持续 20~40min
  DURATION_JITTER: Number(process.env.FROG_EGG_JITTER_SEC || 20 * 60),
};

/** 蛙彩蛋候选池: 按季节/节日过滤 (原版不可考, 取合理近似) */
function frogEggPool(now) {
  const m = new Date(now * 1000);
  const month = m.getMonth() + 1;
  const pool = [1, 2, 3]; // 梳毛 / 干饭 / 做饭: 常驻
  if (month >= 6 && month <= 8) pool.push(5);          // 西瓜: 夏季
  // 粽子: 端午前后 (公历 6 月上中旬近似农历五月)
  if (month === 6 && m.getDate() >= 1 && m.getDate() <= 20) pool.push(4);
  return pool;
}

/**
 * 蛙彩蛋状态机: 在家时掷蛋 (同时最多 1 个), 到期/出门即失效。
 * 状态: s.egg = {type: 0|1..5, until: ts, nextRollAt: ts}
 * @returns {number} 当前蛙彩蛋 id (0 = 无)
 */
function frogEggState(s, now) {
  if (!s.egg) s.egg = { type: 0, until: 0, nextRollAt: 0 };
  const e = s.egg;
  if (s.frog.status !== 0) { // 出门/聚会: 蛋收起, 回家后重掷
    if (e.type) e.type = 0;
    if (!e.nextRollAt) e.nextRollAt = now + randInt(0, PACE.ROLL_JITTER);
    return 0;
  }
  if (e.type && now >= e.until) { // 到期
    e.type = 0;
    e.nextRollAt = now + randInt(PACE.ROLL_SEC, PACE.ROLL_SEC + PACE.ROLL_JITTER);
  }
  if (!e.type && now >= (e.nextRollAt || 0)) {
    const pool = frogEggPool(now);
    e.type = pool[randInt(0, pool.length - 1)];
    e.until = now + randInt(PACE.DURATION_MIN, PACE.DURATION_MIN + PACE.DURATION_JITTER);
  }
  return e.type || 0;
}

/**
 * 当前激活彩蛋全集 (纯函数, 不改状态 —— 蛙蛋状态机除外)
 * @returns {number[]}
 */
function activeEggs(s, now) {
  const out = [];
  const frogEgg = frogEggState(s, now);
  if (frogEgg) out.push(frogEgg);
  const w = s.weather || {};
  // 雨具: 雨天 + 对应 NPC 在场 (困困wugui→103 / 胖胖maotouying→104 / 跳跳songshu→102 / 嘟嘟→101)
  if (WEATHER_RAIN.has(w.weather)) {
    if (s.guest && s.guest.id >= 0 && s.guest.id <= 2) out.push([103, 104, 102][s.guest.id]);
    if (s.merchant && s.merchant.shop) out.push(101);
  }
  // 萤火虫: 夏季傍晚/夜晚 (抓拍区在庭院, 白天不可见)
  if (w.season === 2 && (w.hours_type === 2 || w.hours_type === 3)) out.push(201);
  return out;
}

/**
 * tick: 激活集合变化时推送 easteregg_load (客户端整表替换)
 * @returns {boolean} 是否推送
 */
function eggTick(s, push, now) {
  const list = activeEggs(s, now);
  const prev = s.egg && s.egg.pushed ? s.egg.pushed : [];
  const changed = list.length !== prev.length || list.some((v, i) => v !== prev[i]);
  if (changed && s.egg) s.egg.pushed = list.slice();
  if (changed && push) push("easteregg_load", { egg_list: list });
  return changed;
}

/** 登录全量下推用载荷 (同步 pushed 基线, eggTick 据此判变化) */
function eggPayload(s) {
  const list = activeEggs(s, Math.floor(Date.now() / 1000));
  if (s.egg) s.egg.pushed = list.slice();
  return { egg_list: list };
}

module.exports = { activeEggs, eggTick, eggPayload, WEATHER_RAIN };
