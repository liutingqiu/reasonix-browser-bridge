# Reasonix Browser Bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-brightgreen.svg)](extension/manifest.json)

Reasonix 的自动化浏览器插件（开源）—— 通过 MCP 让 Reasonix 直接控制你的浏览器：标签页、Cookie、任意 JavaScript 执行、截图、下载、代理、数据清理。**Chrome / Edge 通用**。

```
┌─────────────┐   stdio / MCP   ┌──────────────────┐   WebSocket    ┌───────────────┐
│  MCP 客户端  │ ⇄─────────────⇄ │  MCP Server (Node)│ ⇄ 127.0.0.1:8747 ⇄ │  浏览器插件    │
│ (Reasonix…) │                 └──────────────────┘                 │ (MV3)         │
└─────────────┘                                                      └───────┬───────┘
                                                                            │
                                                                   tabs / cookies /
                                                          scripting / debugger (CDP)
                                                                            ▼
                                                                        浏览器
```

- **插件**（`extension/`）：Manifest V3，自动连接 `ws://127.0.0.1:8747` 并自动重连。每个浏览器装一次（Chrome 和 Edge 都支持）。
- **MCP Server**（`server/`）：stdio MCP server，桥接插件并把浏览器能力暴露为 MCP 工具。
- **无需任何特殊启动参数**——不需要 `--remote-debugging-port`、不需要 native host、不需要注册表。装插件、跑 server、完事。

## 功能 / 工具

| 工具 | 说明 |
|---|---|
| `browser_list` | 列出所有已连接的浏览器（chrome / edge） |
| `browser_state` | 插件连接状态、版本、心跳 |
| `browser_tabs_list` | 列出所有标签页（可选 URL 过滤） |
| `browser_tabs_open` | 打开新标签页 |
| `browser_tabs_activate` | 切换到指定标签页 |
| `browser_tabs_close` | 关闭一个或多个标签页 |
| `browser_tabs_reload` | 刷新标签页 |
| `browser_cookies_getAll` / `get` / `set` / `remove` | Cookie 全量读写 |
| `browser_script_execute` | 在任意页面执行**任意 JavaScript**（CDP 通道，绕过页面 CSP） |
| `browser_screenshot` | 标签页截图（base64 PNG/JPEG，AI 可直接看图） |
| `browser_downloads_download` / `search` | 触发 / 查询下载 |
| `browser_proxy_get` / `set` | 读取 / 切换代理（直连 / 系统 / 固定 / PAC） |
| `browser_browsingdata_remove` | 清理缓存 / Cookie / 历史 / localStorage 等 |
| `browser_management_list` | 列出所有已安装扩展（含启停状态） |
| `browser_history_search` | 搜索浏览历史 |
| `browser_bookmarks_list` | 读取书签树 |
| `browser_notify` | 系统通知 |
| `browser_webnav_frames` | 列出标签页的所有 iframe |
| `browser_storage_get` / `set` | 读写插件本地存储 |

**多浏览器**：Chrome 和 Edge 都支持。想控制哪个浏览器就在哪个浏览器装一次插件——每个实例都会自动连上桥。大多数工具支持可选 `browser` 参数（`"chrome"` / `"edge"`）指定目标浏览器；只连了一个浏览器时自动使用，连了多个又没指定时会提示你指定。

## 安装

### 1. 安装插件（Chrome / Edge —— 每个浏览器装一次）

1. 打开 `chrome://extensions`（Chrome）或 `edge://extensions`（Edge）。
2. 开启**开发者模式**。
3. 点「**加载已解压的扩展程序**」→ 选择 `extension/` 文件夹。
4. 可选：固定到工具栏——图标显示桥接状态（绿色 **M** = 已连接）。

> 注意：Chrome 137+ 在正式版上禁用了 `--load-extension` 命令行参数，请用上面的开发者模式安装。同一个 `extension/` 文件夹在 Chrome 和 Edge 通用（扩展 ID 相同）。

### 2. 启动 MCP server

```bash
cd server
npm install
npm start
```

看到 `✅ plugin connected`（或 `plugin connected`）即插件已自动连上。

### 3. 配置 MCP 客户端

在 MCP 客户端配置中添加（如 Reasonix 的 `config.toml`）：

```json
{
  "mcpServers": {
    "reasonix-browser-bridge": {
      "command": "node",
      "args": ["/绝对路径/server/index.js"]
    }
  }
}
```

## 使用示例

对 AI 说：

> 列出我打开的标签页，然后在 123 号标签页执行 `document.title`。

对应工具为 `browser_tabs_list` 和 `browser_script_execute`。

`browser_script_execute` 接收**JS 表达式**（不能写 `return`；异步用 IIFE）：

```
document.title
({ count: document.querySelectorAll('a').length })
(async () => { const r = await fetch('/api/data').then(r => r.json()); return r; })()   // 设置 awaitPromise: true
```

## 安全说明

- WebSocket 桥**仅绑定 127.0.0.1**，插件只连接 localhost。
- 无远程访问、无 native messaging、无注册表改动。
- 插件申请**全部权限**（tabs、cookies、scripting、debugger、downloads、proxy、browsingData、management、history、bookmarks、clipboard、notifications 等 + `<all_urls>`）——它定位为 Reasonix 的自动化桥，浏览器能做的它都能做。只在信任本项目时安装。

## 项目结构

```
reasonix-browser-bridge/
├── extension/      # MV3 浏览器插件
│   ├── manifest.json
│   ├── background.js   # WS 桥 + 浏览器操作网关
│   ├── popup.*         # 极简状态弹窗
│   ├── content.js      # 页面标记（document_start）
│   └── icons/
├── server/         # MCP server (Node)
│   ├── index.js
│   └── package.json
├── tools/          # 开发 / 安装辅助脚本
├── README.md       # 英文文档
├── README.zh-CN.md # 中文文档（本文件）
└── LICENSE
```

## License

MIT
