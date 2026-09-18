/**
 * 旅行青蛙中国之旅 · 自研离线服务器
 *
 * 职责:
 *   1. 静态托管客户端 (根目录 index.html)
 *   2. WebSocket 游戏协议服务 (端口 8080, 与官方线格式兼容)
 *   3. 开发者模式: /gm 面板 + POST /gm/api (端口 8000, 同一 HTTP 服务)
 *
 * 启动: node server.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const WebSocket = require("ws");
const { handlers } = require("./handlers");
const saveMod = require("./save");
const travel = require("./travel");
const drawing = require("./drawing");
const storyMod = require("./story");
const eggMod = require("./egg");
const gm = require("./gm");
const photoRender = require("./render_photo");

// ---------- 旅行地图 API (游戏内 tmLayer 高德页数据源, 城市表见 map_cities.js) ----------
// 高德 Key 配置 (根目录 amap.key.json, 与 map_data.json 同级; 服务端私有, 不进客户端源码); /amap/maps.js 代理 loader
const AMAP_CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "amap.key.json"), "utf-8")); }
  catch (e) { return { key: "", securityJsCode: "" }; }
})();
let amapLoaderCache = null;
function handleAmapLoader(req, res, url) {
  if (url.pathname !== "/amap/maps.js" || req.method !== "GET") return false;
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(body);
  };
  if (amapLoaderCache) { send(200, amapLoaderCache); return true; }
  if (!AMAP_CFG.key) { send(500, "// server/amap.key.json 未配置 key"); return true; }
  https.get("https://webapi.amap.com/maps?v=1.4.15&key=" + encodeURIComponent(AMAP_CFG.key), (r) => {
    const parts = [];
    r.on("data", (c) => parts.push(c));
    r.on("end", () => {
      if (r.statusCode !== 200) { send(r.statusCode, "// amap loader 代理失败: HTTP " + r.statusCode); return; }
      let body = Buffer.concat(parts);
      // 安全密钥 (2021-12 后创建的 Key 需要) 在 SDK 执行前注入, 同样不落客户端源码
      if (AMAP_CFG.securityJsCode) {
        body = Buffer.concat([Buffer.from("window._AMapSecurityConfig={securityJsCode:" + JSON.stringify(AMAP_CFG.securityJsCode) + "};"), body]);
      }
      amapLoaderCache = body;
      send(200, body);
    });
  }).on("error", (e) => send(502, "// amap loader 代理错误: " + e.code));
  return true;
}
function mapAccount(url) {
  const a = url.searchParams.get("account");
  if (a) return a.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_");
  // 无账号: 取在线连接, 否则最新修改的存档 (用户存档分级在 data/user/)
  if (liveConns.size) return [...liveConns.keys()][0];
  const dir = path.join(__dirname, "data", "user");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({
    f, t: fs.statSync(path.join(dir, f)).mtimeMs,
  })).sort((x, y) => y.t - x.t);
  return files.length ? files[0].f.replace(/\.json$/, "") : null;
}
function handleMapApi(req, res, url) {
  const route = url.pathname;
  if (route === "/api/map" && req.method === "GET") {
    const account = mapAccount(url);
    if (!account) return json(res, 200, { account: null, locations: [] });
    let save;
    try { save = saveMod.load(account); } catch (e) { return json(res, 500, { error: e.message }); }
    // 官方 35 城表 (坐标/名称来自官方地图页) + 照片归城, 见 map_cities.js
    return json(res, 200, { account, ...require("./map_cities").payload(save) });
  }
  if (route.startsWith("/api/map/photo/") && req.method === "GET") {
    const id = Number(route.split("/").pop().replace(/\.png$/, ""));
    const png = photoRender.renderPng(id);
    if (!png) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.end(png);
    return true;
  }
  return false;
}

const ROOT = path.join(__dirname, ".."); // 客户端根目录
const HTTP_PORT = 8000;
const WS_PORT = 8080;

// 在线连接注册表: account -> ctx (GM API 找到连接后直接推送/共享存档引用)
const liveConns = new Map();

// ---------- GM HTTP 服务 (与静态托管共用 8000) ----------
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
  return true; // 路由已完结: 调方 return json(...) 防止落穿到静态处理器 (二次 writeHead 会崩进程)
}

/** 执行 GM 动作: 在线连接直接操作其存档引用并实时推送; 离线则 load+persist */
function gmExecute(account, action, params) {
  if (!account || typeof account !== "string") return { ok: false, info: "缺少 account" };
  const safe = account.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_");
  const conn = liveConns.get(safe);
  if (conn && conn.save) {
    const r = gm.run(conn.save, action, params, (cmd, data) => {
      conn.push(cmd, data); // conn.push 内部已做 readyState 检查与日志
    });
    try { saveMod.persist(conn.save); } catch (e) { /* 存档失败不阻断 GM 结果 */ }
    return Object.assign(r, { online: true });
  }
  // 离线: 加载 → 执行 → 存档 (推送丢弃)
  let save;
  try { save = saveMod.load(safe); } catch (e) { return { ok: false, info: "存档读取失败: " + e.message }; }
  const r = gm.run(save, action, params, null);
  if (r.ok) {
    try { saveMod.persist(save); }
    catch (e) { return Object.assign(r, { ok: false, info: "存档失败: " + e.message, online: false }); }
  }
  return Object.assign(r, { online: false });
}

function handleGmApi(req, res, url) {
  const route = url.pathname;
  if (req.method === "GET" && (route === "/gm" || route === "/gm/")) {
    fs.readFile(path.join(__dirname, "gm.html"), (err, data) => {
      if (err) { res.writeHead(500); return res.end("gm.html missing"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return true;
  }
  if (req.method === "GET" && route === "/gm/api/items") {
    json(res, 200, { items: gm.itemCatalog() });
    return true;
  }
  if (req.method === "GET" && route === "/gm/api/accounts") {
    const accounts = [...liveConns.entries()].map(([account, c]) => ({
      account,
      frog: c.save ? c.save.frog.status : -1,
      synced: !!c.synced,
    }));
    json(res, 200, { accounts });
    return true;
  }
  if (req.method === "POST" && route === "/gm/api") {
    let body = "";
    req.on("data", (ch) => { body += ch; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const { account, action, params } = JSON.parse(body || "{}");
        json(res, 200, gmExecute(account, action, params));
      } catch (e) {
        json(res, 400, { ok: false, info: "请求格式错误: " + e.message });
      }
    });
    return true;
  }
  return false;
}

// ---------- 本地 launcher 代理 (ejoySDK 公告/打点 → 离线空实现, 规避 CORS) ----------
function handleLocalLauncher(req, res, url) {
  const p = url.pathname.replace(/\/{2,}/g, "/"); // 官方 URL 拼接会产生 //ann 双斜杠
  if (req.method === "GET" && p.startsWith("/local-launcher/ann/v2/")) {
    // 公告列表/详情: 返回无 hash 的空对象 → SDK 判定无公告 (与官方无公告时行为一致)
    return json(res, 200, {});
  }
  if (req.method === "POST" && p.startsWith("/local-launcher/trace/")) {
    req.resume(); // 丢弃打点请求体
    return json(res, 200, { code: 200, message: "ok" }); // tagLog 校验 code==200
  }
  return json(res, 404, { code: 404, message: "not found" });
}

// ---------- 静态文件服务 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg",
  ".mp4": "video/mp4", ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject",
  ".eab": "application/octet-stream", ".thm": "application/octet-stream",
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // GM 路由优先
  if (url.pathname === "/gm" || url.pathname.startsWith("/gm/")) {
    if (handleGmApi(req, res, url)) return;
  }
  // 旅行地图 API
  if (url.pathname.startsWith("/api/map")) {
    if (handleMapApi(req, res, url)) return;
  }
  // 高德 loader 代理 (Key 留在服务端)
  if (handleAmapLoader(req, res, url)) return;
  // ejoySDK 本地代理 (公告/打点, 同源规避 CORS)
  if (url.pathname.startsWith("/local-launcher/")) {
    return handleLocalLauncher(req, res, url);
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === "/") file = path.join(ROOT, "index.html");
  // 防目录穿越
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  // 服务端私有目录 (存档 data/ 等) 禁止 Web 直访
  if (url.pathname === "/server" || url.pathname.startsWith("/server/")) { res.writeHead(403); return res.end(); }
  // 根目录密钥配置 (amap.key.json / eab.key.json): 虽在 Web 根下, 严禁客户端下载
  if (/\.key\.json$/i.test(url.pathname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("404"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" }); // no-cache: 无验证器时浏览器会永久缓存, 客户端补丁不生效
    res.end(data);
  });
}).listen(HTTP_PORT, () => console.log(`[http] 客户端: http://127.0.0.1:${HTTP_PORT}/  |  GM 面板: http://127.0.0.1:${HTTP_PORT}/gm`));

// ---------- WebSocket 协议服务 ----------
let connSeq = 0;
const wss = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`[ws]   游戏协议: ws://127.0.0.1:${WS_PORT}/`));

wss.on("connection", (ws) => {
  const connId = ++connSeq;
  const tag = () => {
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    return `[${t}] [#${connId}]`;
  };
  console.log(`${tag()} ========== 客户端已连接 ==========`);
  // 每连接上下文: 存档 + 推送器
  const ctx = {
    save: null,
    token: null,
    synced: false,
    /** 推送 (服务器主动) */
    push(cmd, data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cmd, data }));
        console.log(`${tag()} PUSH  ${cmd} ${JSON.stringify(data)}`);
      }
    },
    /** 应答 (回填请求回调) */
    reply(session, data) {
      ws.send(JSON.stringify({ session, data }));
      console.log(`${tag()} <--   #${session} ${JSON.stringify(data)}`);
    },
  };
  let dirty = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const cmd = msg.cmd ? msg.cmd.replace(".", "_") : "";
    const data = msg.data || {};
    const handler = handlers[cmd];

    console.log(`${tag()} -->   ${msg.cmd}${msg.session != null ? `(#${msg.session})` : "(无会话)"} ${JSON.stringify(data)}`);

    let result;
    try {
      // 惰性推进旅行状态机 (离线期间到期的出门/回家在请求前追平;
      // 客户端 syncComplete 前不实时推送 —— 全量下发由 load_all_info 呈现, 避免重复弹窗)
      // 涂鸦派对先于旅行推进 (锁包出发/聚会回家需在旅行守卫检查前生效)
      if (ctx.save && drawing.drawingTick(ctx.save, ctx.synced ? ctx.push : null)) dirty = true;
      if (ctx.save && travel.travelTick(ctx.save, ctx.synced ? ctx.push : null)) dirty = true;
      // 周末小插曲: 结算到期 (complete→reward) 推 lottery_load
      if (ctx.save && require("./lottery").tick(ctx.save, ctx.synced ? ctx.push : null, Math.floor(Date.now() / 1000))) dirty = true;
      // 在线 tick: 挂机期间蛙也会出门/回家 (30s 粒度 + 实时推送)
      if (ctx.save && !ctx.tickTimer) {
        ctx.tickTimer = setInterval(() => {
          try {
            if (ctx.save && drawing.drawingTick(ctx.save, ctx.synced ? ctx.push : null)) dirty = true;
            if (ctx.save && travel.travelTick(ctx.save, ctx.synced ? ctx.push : null)) {
              dirty = true;
              if (!ctx.saveTimer) {
                ctx.saveTimer = setTimeout(() => {
                  ctx.saveTimer = null;
                  if (dirty) {
                    try { saveMod.persist(ctx.save); dirty = false; }
                    catch (e) { console.error(`${tag()} ERROR 存档失败(将重试): ${e.message}`); }
                  }
                }, 800);
              }
            }
            if (ctx.save && require("./lottery").tick(ctx.save, ctx.synced ? ctx.push : null, Math.floor(Date.now() / 1000))) dirty = true;
            // 故事送礼回礼邮件到期投递 (story.js storyTick)
            if (ctx.save && ctx.synced && storyMod.storyTick(ctx.save)) {
              ctx.push("mail_load", ctx.save.mails);
              dirty = true;
            }
            // 彩蛋激活集合变化推送 (egg.js: 雨具随 NPC 到场/雨天, 萤火虫随夏夜)
            if (ctx.save && ctx.synced && eggMod.eggTick(ctx.save, ctx.push, Math.floor(Date.now() / 1000))) {
              dirty = true;
            }
          } catch (e) { console.error(`${tag()} ERROR tick 异常:\n${e.stack}`); }
        }, Number(process.env.FROG_TICK_SEC || 30) * 1000);
      }
      result = handler ? handler(ctx, data) : { code: 0 }; // 未实现协议兜底
      if (!handler) console.log(`${tag()} NOTE  ${cmd} 未实现, 兜底 {code:0}`);
    } catch (e) {
      console.error(`${tag()} ERROR ${cmd} 处理异常:\n${e.stack}`);
      result = { code: 0 };
    }
    if (msg.session != null) ctx.reply(msg.session, result);
    // 数组响应 (如 clover_harvest_resend 裸数组) 无 code 字段, 同样视为已变更
    if (ctx.save && result && (result.code === 0 || Array.isArray(result))) {
      // 即时存档 (防抖 800ms): 强杀/崩溃也不丢关键进度
      dirty = true;
      if (!ctx.saveTimer) {
        ctx.saveTimer = setTimeout(() => {
          ctx.saveTimer = null;
          if (dirty) {
            try { saveMod.persist(ctx.save); dirty = false; }
            catch (e) { console.error(`${tag()} ERROR 存档失败(将重试): ${e.message}`); }
          }
        }, 800);
      }
    }
    // GM 在线注册: 存档就绪即登记 (GM API 据此共享引用并实时推送)
    if (ctx.save && ctx.save.account) liveConns.set(ctx.save.account, ctx);
  });

  ws.on("close", () => {
    if (ctx.tickTimer) { clearInterval(ctx.tickTimer); ctx.tickTimer = null; }
    if (ctx.saveTimer) { clearTimeout(ctx.saveTimer); ctx.saveTimer = null; }
    if (ctx.save && dirty) {
      try { saveMod.persist(ctx.save); console.log(`${tag()} SAVE  ${ctx.save.account} 已存档`); }
      catch (e) { console.error(`${tag()} ERROR 存档失败: ${e.message}`); }
    }
    if (ctx.save && ctx.save.account && liveConns.get(ctx.save.account) === ctx) {
      liveConns.delete(ctx.save.account);
    }
    console.log(`${tag()} ========== 连接关闭 ==========`);
  });
  ws.on("error", () => {});
});

/** 优雅停机 (Electron 桌面壳 window-all-closed 调用): 在线连接存档落盘 */
function shutdown() {
  for (const ctx of liveConns.values()) {
    if (ctx.tickTimer) { clearInterval(ctx.tickTimer); ctx.tickTimer = null; }
    if (ctx.saveTimer) { clearTimeout(ctx.saveTimer); ctx.saveTimer = null; }
    if (ctx.save) {
      try { saveMod.persist(ctx.save); console.log(`[shutdown] SAVE  ${ctx.save.account} 已存档`); }
      catch (e) { console.error(`[shutdown] ERROR 存档失败: ${e.message}`); }
    }
  }
}

module.exports = { shutdown };
