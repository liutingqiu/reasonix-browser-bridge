# Reasonix Browser Bridge

Reasonix 的自动化浏览器插件（开源）—— 通过 MCP 让 Reasonix 直接控制你的浏览器：标签页、Cookie、任意 JavaScript 执行。Chrome / Edge 通用。

```
┌─────────────┐   stdio / MCP   ┌──────────────────┐   WebSocket    ┌───────────────┐
│  MCP Client │ ⇄─────────────⇄ │  MCP Server (Node)│ ⇄ 127.0.0.1:8747 ⇄ │  Extension    │
│ (Reasonix…) │                 └──────────────────┘                 │ (MV3)         │
└─────────────┘                                                      └───────┬───────┘
                                                                            │
                                                                   tabs / cookies /
                                                          scripting / debugger (CDP)
                                                                            ▼
                                                                        Browser
```

- **Extension** (`extension/`): Manifest V3, connects to `ws://127.0.0.1:8747`, auto-reconnects. Install once per browser (Chrome and Edge).
- **MCP Server** (`server/`): stdio MCP server that bridges to the extension and exposes browser tools.
- **No special flags** needed to launch the browser — no `--remote-debugging-port`, no native host / registry setup. Install the extension, run the server, done.

## Features / Tools

| Tool | Description |
|---|---|
| `browser_list` | List all connected browsers (chrome / edge) |
| `browser_state` | Extension connection status, version, heartbeat |
| `browser_tabs_list` | List all tabs (optional URL filter) |
| `browser_tabs_open` | Open a new tab |
| `browser_tabs_activate` | Switch to a tab |
| `browser_tabs_close` | Close one or more tabs |
| `browser_tabs_reload` | Reload a tab |
| `browser_cookies_getAll` / `get` / `set` / `remove` | Full cookie access |
| `browser_script_execute` | Run **arbitrary JavaScript** on any page via CDP (bypasses page CSP) |
| `browser_screenshot` | Screenshot a tab (base64 PNG/JPEG, AI can see the page) |
| `browser_downloads_download` / `search` | Trigger / query downloads |
| `browser_proxy_get` / `set` | Read / switch proxy settings (direct / system / fixed / PAC) |
| `browser_browsingdata_remove` | Clear cache / cookies / history / localStorage ... |
| `browser_management_list` | List all installed extensions (with enabled state) |
| `browser_history_search` | Search browsing history |
| `browser_bookmarks_list` | Read bookmark tree |
| `browser_notify` | System notification |
| `browser_webnav_frames` | List iframes of a tab |
| `browser_storage_get` / `set` | Read/write the extension's local storage |

**Multi-browser**: Chrome and Edge are both supported. Install the extension in each browser you want to control — every instance auto-connects to the bridge. Most tools accept an optional `browser` parameter (`"chrome"` / `"edge"`) to target a specific browser; when only one browser is connected it is used automatically, and when several are connected without a `browser` argument the server tells you to specify one.

## Install

### 1. Install the extension (Chrome / Edge — install once per browser)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** / **加载未打包的扩展程序** and select the `extension/` folder.
4. Pin it if you like — the icon shows bridge status (green **M** = connected).

> Note: Chrome 137+ blocks the `--load-extension` command-line flag on branded builds; the developer-mode UI install above is the supported way. The same extension folder works in both browsers (same extension ID).

### 2. Start the MCP server

```bash
cd server
npm install
npm start
```

You should see `✅ 插件已连接 / plugin connected` once the extension auto-connects.

### 3. Configure your MCP client

Add to your MCP client config (Reasonix `config.toml`):

```json
{
  "mcpServers": {
    "reasonix-browser-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/server/index.js"]
    }
  }
}
```

## Usage example

Ask your AI:

> List my open tabs. Then run `document.title` on tab #123.

It maps to `browser_tabs_list` and `browser_script_execute`.

`browser_script_execute` takes a **JS expression** (no `return` keyword; use an IIFE for async):

```
document.title
({ count: document.querySelectorAll('a').length })
(async () => { const r = await fetch('/api/data').then(r => r.json()); return r; })()   // set awaitPromise: true
```

## Security

- The WebSocket bridge binds to **127.0.0.1 only**; the extension only connects to localhost.
- No remote access, no native messaging, no registry changes.
- The extension requests **full permissions** (tabs, cookies, scripting, debugger, downloads, proxy, browsingData, management, history, bookmarks, clipboard, notifications, ... + `<all_urls>`) — it is designed as Reasonix's automation bridge, so it can do anything the browser can. Install it only if you trust this project.

## Project layout

```
browser-mcp-bridge/
├── extension/      # MV3 browser extension
│   ├── manifest.json
│   ├── background.js   # WS bridge + browser gateway
│   ├── popup.*         # minimal status popup
│   ├── content.js      # page marker (document_start)
│   └── icons/
├── server/         # MCP server (Node)
│   ├── index.js
│   └── package.json
├── README.md
└── LICENSE
```

## License

MIT
