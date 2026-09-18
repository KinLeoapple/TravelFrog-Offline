/**
 * 旅行青蛙·中国之旅 —— Electron 桌面壳
 * 主进程内直接挂载游戏服务器 (server/server.js, HTTP 8000 + WS 8080),
 * 无需外部 node 进程; 窗口全关时优雅停机 (在线存档落盘) 后退出。
 * 启动: 项目根目录 `npm start` 或双击 start.bat
 */
const { app, Menu, BrowserWindow, shell } = require("electron");
const path = require("path");

const GAME_URL = "http://127.0.0.1:8000/";
let win = null;

function startServer() {
  try {
    require("../server/server.js"); // 监听 8000/8080 (require 时同步建好)
  } catch (e) {
    // 端口被占 (外部已有服务器在跑) 等: 照常开窗连接现有服务
    console.error("[desktop] 内嵌服务器启动失败, 尝试连接既有服务:", e.message);
  }
}

function createWindow() {
  // 游戏设计分辨率 640x1136 (竖屏 9:16), 内容区按比例给桌面尺寸
  win = new BrowserWindow({
    width: 480,
    height: 854,
    minWidth: 360,
    minHeight: 640,
    useContentSize: true,
    resizable: true,
    title: "旅行青蛙·中国之旅",
    icon: path.join(__dirname, "app_icon.png"), // 国服官方 App 图标 (APK 抽取, 512x512 斗笠蛙)
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null); // 去掉默认菜单栏 (DevTools 仍可 F12)
  // 外部链接 (如礼包码/客服) 交给系统浏览器, 不在游戏窗内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 服务器慢一拍导致的首载失败: 最多重试 3 次
  let retries = 0;
  win.webContents.on("did-fail-load", () => {
    if (retries++ < 3) setTimeout(() => win && !win.isDestroyed() && win.loadURL(GAME_URL), 600);
  });
  win.loadURL(GAME_URL);
  win.on("closed", () => { win = null; });
}

// 单实例: 重复启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// 全部窗口关闭: 优雅停机 (存档落盘) 后退出
app.on("window-all-closed", () => {
  try { require("../server/server.js").shutdown(); } catch (e) { /* 服务器未启动等 */ }
  app.quit();
});
