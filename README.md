# 旅行青蛙·中国之旅 — 离线单机版

为已停运的《旅行青蛙·中国之旅》(灵犀互娱 / Egret 引擎)制作的离线私服:
Node 自研服务器 + 官方客户端原件 + Electron 桌面壳,单机可玩、存档本地化。

> 仅用于个人学习与停服存档备份。游戏内容与素材版权归 © 官方所有。
>
> 本项目参考了 [xiaochong3432/TravelFrog-offline](https://github.com/xiaochong3432/TravelFrog-offline):
> 照片图层数据(社区预烘表演变而来的坐标/姿势映射)与离线化思路源自其社区考据与数据整理,特此致谢。

## 快速开始

```bash
npm install        # 安装 Electron (二进制走 .npmrc 配置的国内镜像)
npm start          # 启动桌面窗口 (内嵌游戏服务器, 关窗即优雅存档退出)
```

或直接双击 `start.bat`。浏览器游玩:启动后访问 `http://127.0.0.1:8000/`(WebSocket 协议端口 8080)。

## 密钥配置

两个密钥文件不入库,首次使用请复制模板并填入自己的值:

| 模板 | 用途 |
|---|---|
| `amap.key.example.json` → `amap.key.json` | 游戏内旅行地图的高德 Key(服务端代理下发,不进客户端) |
| `eab.key.example.json` → `eab.key.json` | 官方 config.eab 资源包的 XXTEA 解密密钥(eab 工具/测试用) |

## 目录结构

```
desktop/    Electron 桌面壳 (main.js + 国服官方图标)
server/     游戏服务器 (Node, 无框架): handlers.js 协议路由 + 各玩法模块
  data/user/  玩家存档 (运行时生成, 不入库)
  tests/      回归测试 (node tests/test_*.js)
js/         官方客户端 (main.min.js 为逆向修补版)
resource/   官方资源包 (China: 配置/贴图/eab)
picture-data.json   照片图层数据 (官方抓包直查表 + 公式坐标)
map_data.json       旅行地图城市表
protocol_table.json 协议模式表
```

## 玩法节奏(对齐官方值,环境变量可覆盖)

- 旅行时长 1~6 小时(`FROG_TRAVEL_MIN/MAX_SEC`),回家休息 400~900 秒
- 收拾好背包后 3~8 分钟内自行出门(`FROG_WAIT_MIN/MAX_SEC`),出发前可反悔
- 三叶草约 2 小时长满,放浪短途(没带便当)10~20 分钟

## 测试

```bash
cd server/tests
node test_tasks.js       # 成就任务 + 故事
node test_plans.js       # 周期计划 (伴蛙前行)
node test_travel.js      # 旅行状态机
node test_photo_assets.js# 照片资产完整性
```

## GM 面板

服务器启动后访问 `http://127.0.0.1:8000/gm`(发放物品/三叶草、时间旅行等调试功能)。
