# 悬浮AI小助手 🤖

一个悬浮在屏幕上的 AI 小助手，**直接接你本机正在运行的 DeepSeek Harness (DSH)** ——
不单独调用模型 API，不单独存 key，完全复用 DSH 的模型、工具、会话体系。

```
┌────────────┐  同源  ┌──────────────────┐  转发  ┌─────────────────┐
│ 浏览器页面  │ ─────► │ 本地代理 server.mjs │ ─────► │ DSH (127.0.0.1:3080) │
│ 悬浮球+聊天 │  8787  │ 静态文件 + /api    │        │ 会话/Agent/模型    │
└────────────┘        └──────────────────┘        └─────────────────┘
```

## 为什么需要这个代理？

DSH 的服务器**没有开 CORS**，浏览器页面从别的端口直接调 `127.0.0.1:3080` 会被同源策略拦下。
`server.mjs` 让页面和 API 同源（都走 8787），再原样转发给 DSH —— 事件流（SSE）也能正常推送。

## 启动

**方式一（推荐）**：桌面快捷方式「悬浮AI小助手」（已安装）——双击即用。

**方式二**：双击项目里的 `启动悬浮助手-桌面版.bat`（首次运行会自动安装 Electron，走国内镜像源）。

**开机自启动**：已安装（登录 Windows 自动启动）。想卸载：
- 删除桌面/启动文件夹里的「悬浮AI小助手」快捷方式，或
- 双击 `卸载快捷方式与开机自启.bat`

> 前提：DSH 正在运行（即 `http://127.0.0.1:3080` 能打开）；DSH 没开时悬浮窗会自动重试连接。

> 说明：`server.mjs` 是内部服务（网页/API 同源代理），由桌面版自动拉起，
> 不需要手动操作，也不会弹出浏览器。

## 使用

- **拖动**悬浮球：按住拖动，放到顺手的位置
- **点击**悬浮球：打开/收起聊天面板
- **Enter** 发送，**Shift+Enter** 换行，**Esc** 收起面板
- **■ 停止**：打断当前回复（等价于 DSH 的 session.cancel）
- **右键悬浮球**：退出应用
- **⚙ 绑定对话**：选择要绑定的**工作区**，再选里面的**对话**。
  绑定关系保存在项目根目录 `config.json`，重启、换浏览器都继承同一个对话。
- **点击穿透**：悬浮窗透明区域不会挡住下层应用——鼠标移到悬浮球/聊天面板上才响应，
  移开就透传点击给下面的窗口（微信、浏览器随便点）。
- 在 DSH 网页里也能看到这同一段对话、打断它、改它的模型。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 本地代理端口 |
| `DSH_ORIGIN` | `http://127.0.0.1:3080` | DSH 服务地址 |

例：`PORT=9000 node server.mjs`

## 安全说明 ⚠️

- 本代理**只监听 127.0.0.1**，不暴露到局域网/公网。
- DSH 的 `/api` 本身无鉴权，安全模型是"只绑本机 + 只收 JSON"。请保持
  DSH 也只监听本机 —— **不要把 3080 或 8787 端口暴露到公网**，
  否则任何人都能指挥你的 agent。
- 页面与代理之间没有任何 token：因为你就在本机，DSH 自己保管模型 key。

## 技术要点（写给想改的人）

与 DSH 的通信协议（已在源码中实测验证）：

```
发消息    POST /api/session.prompt    {"type":"client-request","rpcId":"<uuid>",
                                       "method":"session.prompt",
                                       "payload":{"sessionId":"…","mode":"queue",
                                                  "content":[{"type":"text","text":"你好"}],
                                                  "clientTimeZone":"Asia/Shanghai"}}
收事件流  WS   /api/events.mux         WebSocket，消息为 {…"payload":{type:"session/event",
                                       event:{type:"assistant/chunk",data:{chunk:{type:"text-delta",text:"你"}}}}}
```

> 注：事件流必须是 **WebSocket 升级**（普通 GET 会被拒，HTTP 426）。
> 代理 server.mjs 已处理升级转发。

关键事件：`user/message`（用户消息）、`assistant/chunk`（流式增量）、
`assistant/message`（完整消息）、`turn/end`（回合结束）。

## 路线图

- [x] M1 悬浮球 + 绑定工作区对话 + 流式回复
- [x] M2 桌面悬浮窗版（Electron：无边框、置顶、透明、盖在任何应用上）
- [ ] 收到回复时系统通知 / 声音提醒
- [ ] 语音输入（浏览器 Web Speech API 即可）
- [ ] 快捷指令（如"截图问 AI"）
- [ ] 打包成 exe 分发

## 目录结构

```
悬浮AI小助手/
├── server.mjs                   # 内部服务：静态文件 + /api 代理 + WebSocket 转发
├── 启动悬浮助手-桌面版.bat       # 桌面悬浮窗启动（首次装 Electron）
├── 安装桌面快捷方式与开机自启.bat # 装桌面快捷方式 + 开机自启
├── 卸载快捷方式与开机自启.bat     # 卸掉上面两个
├── 安装快捷方式.ps1              # 上面两个 bat 调用的脚本
├── icon.ico                     # 快捷方式图标（自动生成）
├── electron/                    # 桌面悬浮窗（Electron）
│   ├── main.js                  # 主进程：窗口、拖拽、展开/收起、自愈
│   └── preload.js               # 页面 ↔ 主进程桥
├── config.json                  # 绑定的工作区 + 对话（自动生成）
├── e2e-test.mjs                 # 端到端自检脚本（node e2e-test.mjs）
└── widget/
    ├── index.html               # 悬浮球 UI（桌面窗内部加载）
    ├── style.css
    └── app.js                   # 连接、绑定、流式渲染
```

> `config.json`（绑定的工作区/会话 ID）是运行时生成的，已在 `.gitignore` 里，
> 克隆后第一次「⚙ 绑定对话」会自动重建。

## 许可

MIT，见 [LICENSE](LICENSE) © 2026 梁锋 (liangfeng113)。

依赖与边界：

| 部件 | 许可 | 说明 |
|---|---|---|
| 本项目代码（`server.mjs`、`widget/`、`electron/`） | MIT | 本仓库 |
| Electron | MIT | 由 `electron/package.json` 在本地安装，不随仓库分发 |
| DeepSeek Harness (DSH) | DeepSeek 官方条款 | **不包含在本仓库内**，只是通过本机 `127.0.0.1:3080` 的 HTTP/WebSocket API 与之通信 |

本仓库不含任何模型 key、cookie 或 DSH 源码；代理只监听 `127.0.0.1`。
