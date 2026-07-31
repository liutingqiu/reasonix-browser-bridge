// Reasonix Browser Bridge - MCP server
// Reasonix 的自动化浏览器插件配套 MCP server：
// 通过本地 WebSocket 桥接扩展，把浏览器能力暴露为 MCP 工具。
// 架构: MCP Client ⇄ stdio/MCP ⇄ 本 server ⇄ ws://127.0.0.1:8747 ⇄ 扩展 ⇄ 浏览器
//
// - 多浏览器支持：Chrome / Edge 各装一个插件，自动连上桥；工具用可选 browser 参数路由。
// - 多实例自适应：第一个实例作为桥（server 模式监听 8747）；后续实例自动降级为 client 连主桥。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

const PORT = 8747;
const VERSION = "2.3.1";

let rpcSend = null; // (type, params, timeoutMs, browser) => Promise

// ---------- 桥（server / client 自适应） ----------
async function initBridge() {
  // 尝试作为 server 监听
  try {
    const wss = await new Promise((resolve, reject) => {
      const s = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
      s.once("listening", () => resolve(s));
      s.once("error", (e) => reject(e));
    });

    const plugins = new Map(); // browser -> { ws, connectedAt }
    const extPending = new Map(); // innerId -> { ws: clientSocket, clientId }
    let innerSeq = 0;

    const pluginFor = (browser) => {
      if (browser) {
        const p = plugins.get(browser);
        if (!p || p.ws.readyState !== WebSocket.OPEN) throw new Error(`浏览器 "${browser}" 未连接。已连接: ${[...plugins.keys()].join(", ") || "无"}`);
        return p.ws;
      }
      if (plugins.size === 0) throw new Error("没有浏览器插件连接。请先安装扩展并确认桥接正常（工具栏图标显示绿色 M）。");
      if (plugins.size === 1) return [...plugins.values()][0].ws;
      throw new Error(`检测到多个浏览器插件 (${[...plugins.keys()].join(", ")})，请用 browser 参数指定（如 chrome / edge）。`);
    };

    wss.on("connection", (ws) => {
      ws.isExtension = false;
      ws.isClient = false;
      ws.on("message", (data) => {
        let m;
        try { m = JSON.parse(data.toString()); } catch { return; }
        // 握手
        if (m && m.type === "hello") {
          if (m.role === "extension") {
            const browser = m.browser || "browser-" + plugins.size;
            const old = plugins.get(browser);
            if (old && old.ws !== ws) { try { old.ws.close(); } catch (_) {} }
            plugins.set(browser, { ws, connectedAt: Date.now() });
            ws.isExtension = true;
            ws.browser = browser;
            console.error(`[bridge] ✅ ${browser} 插件已连接（server 模式）`);
          } else if (m.role === "client") {
            ws.isClient = true;
            console.error("[bridge] ✅ MCP 客户端已接入（server 模式）");
          }
          return;
        }
        // 插件响应 → 路由回对应 MCP 客户端（或本实例 rpc）
        if (ws.isExtension && typeof m.id === "number") {
          const rec = extPending.get(m.id);
          if (rec) {
            extPending.delete(m.id);
            if (rec.self) {
              m.error ? rec.self.reject(new Error(m.error)) : rec.self.resolve(m.result);
            } else {
              try {
                rec.ws.send(JSON.stringify(m.error ? { id: rec.clientId, error: m.error } : { id: rec.clientId, result: m.result }));
              } catch (_) {}
            }
          }
          return;
        }
        // MCP 客户端请求 → 转发给对应浏览器插件
        if (ws.isClient && typeof m.id === "number" && typeof m.type === "string") {
          if (m.type === "bridge-list") {
            try {
              ws.send(JSON.stringify({ id: m.id, result: [...plugins.entries()].map(([b, p]) => ({ browser: b, connectedAt: p.connectedAt })) }));
            } catch (_) {}
            return;
          }
          let target;
          try { target = pluginFor(m.browser); } catch (e) {
            try { ws.send(JSON.stringify({ id: m.id, error: e.message })); } catch (_) {}
            return;
          }
          const innerId = ++innerSeq;
          extPending.set(innerId, { ws, clientId: m.id });
          try {
            target.send(JSON.stringify({ id: innerId, type: m.type, params: m.params || {} }));
          } catch (e) {
            extPending.delete(innerId);
            try { ws.send(JSON.stringify({ id: m.id, error: "转发失败: " + e.message })); } catch (_) {}
            return;
          }
          setTimeout(() => {
            if (extPending.has(innerId)) {
              extPending.delete(innerId);
              try { ws.send(JSON.stringify({ id: m.id, error: "请求超时: " + m.type })); } catch (_) {}
            }
          }, 30000);
          return;
        }
      });
      ws.on("close", () => {
        if (ws.isExtension && ws.browser && plugins.get(ws.browser)?.ws === ws) {
          plugins.delete(ws.browser);
          console.error(`[bridge] ⚠️ ${ws.browser} 插件已断开（server 模式）`);
        }
        if (ws.isClient) console.error("[bridge] MCP 客户端断开");
        for (const [k, v] of [...extPending]) {
          if (v.ws === ws) { extPending.delete(k); }
        }
      });
      ws.on("error", () => { try { ws.close(); } catch (_) {} });
    });

    // 本实例作为 MCP server 直接转发到插件
    rpcSend = (type, params = {}, timeoutMs = 30000, browser) =>
      new Promise((resolve, reject) => {
        if (type === "bridge-list") {
          resolve([...plugins.entries()].map(([b, p]) => ({ browser: b, connectedAt: p.connectedAt })));
          return;
        }
        let target;
        try { target = pluginFor(browser); } catch (e) { reject(e); return; }
        const id = ++innerSeq;
        extPending.set(id, { ws: null, clientId: null, self: { resolve, reject } });
        target.send(JSON.stringify({ id, type, params }));
        setTimeout(() => {
          const rec = extPending.get(id);
          if (rec) { extPending.delete(id); if (rec.self) rec.self.reject(new Error("请求超时: " + type)); }
        }, timeoutMs);
      });
    console.error(`[bridge] 桥已启动（server 模式）: ws://127.0.0.1:${PORT}`);
    return;
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
  // 端口被占 → client 模式连主桥
  console.error("[bridge] 检测到已有桥实例，降级为 client 模式…");
  let ws = null;
  let handshakeDone = false;
  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => {
      handshakeDone = true;
      console.error("[bridge] ✅ 已连接主桥（client 模式）");
      try { ws.send(JSON.stringify({ type: "hello", role: "client" })); } catch (_) {}
    });
    ws.on("error", () => { try { ws.close(); } catch (_) {} });
  };
  connect();
  const pending = new Map();
  let seq = 0;
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m && typeof m.id === "number") {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
    }
  });
  ws.on("close", () => {
    for (const [, p] of pending) p.reject(new Error("主桥断开"));
    pending.clear();
    if (handshakeDone) {
      handshakeDone = false;
      console.error("[bridge] ⚠️ 主桥断开，2s 后重连…");
      setTimeout(connect, 2000);
    }
  });
  rpcSend = (type, params = {}, timeoutMs = 30000, browser) =>
    new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("桥未连接")); return; }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, type, params, browser }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("请求超时: " + type)); } }, timeoutMs);
    });
}

// ---------- 工具返回辅助 ----------
const ok = (text) => ({ content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }] });
const clean = (obj) => JSON.parse(JSON.stringify(obj));

// 工具参数辅助：每个浏览器工具带可选 browser 参数
const browserParam = { browser: z.string().optional().describe("目标浏览器：chrome / edge（插件报告的标识）。省略时：只有一个浏览器插件则用它，多个则报错列出。") };

// ---------- MCP Server ----------
const server = new McpServer({ name: "reasonix-browser-bridge", version: VERSION });

server.tool("browser_list", "列出所有已连接的浏览器插件（chrome / edge 等）", {}, async () => {
  const list = await rpcSend("bridge-list", {});
  return ok(clean(list));
});

server.tool("browser_state", "查询指定浏览器的插件连接状态、版本与心跳", browserParam, async ({ browser }) => {
  const s = await rpcSend("get-state", {}, 30000, browser);
  return ok(clean(s));
});

server.tool(
  "browser_tabs_list",
  "列出指定浏览器的所有标签页（可选按 URL 子串过滤）",
  { ...browserParam, urlContains: z.string().optional().describe("URL 包含的子串，用于过滤") },
  async ({ browser, urlContains }) => {
    const query = urlContains ? { url: "*" + urlContains + "*" } : {};
    const tabs = await rpcSend("tabs-list", { query }, 30000, browser);
    return ok(tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })));
  }
);

server.tool(
  "browser_tabs_open",
  "在指定浏览器打开一个新标签页",
  { ...browserParam, url: z.string().describe("要打开的 URL"), active: z.boolean().optional().describe("是否立即激活（默认 true）") },
  async ({ browser, url, active }) => {
    const t = await rpcSend("tabs-open", { data: { url, active: active !== false } }, 30000, browser);
    return ok(clean(t));
  }
);

server.tool(
  "browser_tabs_activate",
  "激活（切换到）指定标签页",
  { ...browserParam, tabId: z.number(), windowId: z.number().optional() },
  async ({ browser, tabId, windowId }) => {
    const t = await rpcSend("tabs-activate", { tabId, windowId }, 30000, browser);
    return ok(clean(t));
  }
);

server.tool(
  "browser_tabs_close",
  "关闭一个或多个标签页",
  { ...browserParam, tabIds: z.array(z.number()).describe("标签 ID 数组") },
  async ({ browser, tabIds }) => {
    await rpcSend("tabs-close", { tabIds }, 30000, browser);
    return ok("已关闭 " + tabIds.length + " 个标签页");
  }
);

server.tool(
  "browser_tabs_reload",
  "刷新指定标签页",
  { ...browserParam, tabId: z.number(), bypassCache: z.boolean().optional() },
  async ({ browser, tabId, bypassCache }) => {
    await rpcSend("tabs-reload", { tabId, data: bypassCache ? { bypassCache: true } : undefined }, 30000, browser);
    return ok("已刷新标签 #" + tabId);
  }
);

server.tool(
  "browser_cookies_getAll",
  "获取指定浏览器的 Cookie（可按域名过滤）",
  { ...browserParam, domain: z.string().optional().describe("按域名过滤，如 example.com") },
  async ({ browser, domain }) => {
    const cookies = await rpcSend("cookies-getAll", { details: domain ? { domain } : {} }, 30000, browser);
    return ok(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate })));
  }
);

server.tool(
  "browser_cookies_get",
  "获取单个 Cookie",
  { ...browserParam, url: z.string(), name: z.string() },
  async ({ browser, url, name }) => {
    const c = await rpcSend("cookies-get", { details: { url, name } }, 30000, browser);
    return ok(c ? clean(c) : { notFound: true });
  }
);

server.tool(
  "browser_cookies_set",
  "设置/更新 Cookie",
  { ...browserParam, url: z.string(), name: z.string(), value: z.string(), domain: z.string().optional(), path: z.string().optional(), secure: z.boolean().optional(), httpOnly: z.boolean().optional(), expirationDate: z.number().optional() },
  async (d) => {
    const { browser, ...details } = d;
    const c = await rpcSend("cookies-set", { details }, 30000, browser);
    return ok(clean(c));
  }
);

server.tool(
  "browser_cookies_remove",
  "删除 Cookie",
  { ...browserParam, url: z.string(), name: z.string() },
  async ({ browser, url, name }) => {
    const r = await rpcSend("cookies-remove", { details: { url, name } }, 30000, browser);
    return ok(clean(r));
  }
);

server.tool(
  "browser_script_execute",
  "在指定浏览器的标签页执行任意 JavaScript 代码（CDP 通道，绕过 CSP；直接写表达式，如 document.title 或 (async () => { ... })()）",
  { ...browserParam, tabId: z.number().describe("目标标签页 ID，可用 browser_tabs_list 获取"), code: z.string().describe("要执行的 JS 表达式/语句（不能写 return，直接写表达式；异步用 IIFE：(async () => { await ...; return x })()）"), awaitPromise: z.boolean().optional().describe("代码返回 Promise 时设 true 等待其 resolve（默认 false）") },
  async ({ browser, tabId, code, awaitPromise }) => {
    const res = await rpcSend("scripting-eval", { tabId, code, awaitPromise }, 60000, browser);
    return ok(clean(res));
  }
);

server.tool(
  "browser_script_execute_batch",
  "在指定标签页一次 attach 批量执行多条 JS（只闪烁一次调试提示条，减少主题闪变）；scripts 为字符串数组或 {code, awaitPromise} 对象数组",
  { ...browserParam, tabId: z.number(), scripts: z.array(z.union([z.string(), z.object({ code: z.string(), awaitPromise: z.boolean().optional() })])).describe("要执行的脚本列表，顺序执行，返回每条结果") },
  async ({ browser, tabId, scripts }) => {
    const res = await rpcSend("scripting-eval-batch", { tabId, scripts }, 120000, browser);
    return ok(clean(res));
  }
);

server.tool(
  "browser_webnav_frames",
  "获取标签页的所有 iframe 帧信息",
  { ...browserParam, tabId: z.number() },
  async ({ browser, tabId }) => {
    const frames = await rpcSend("webnav-frames", { tabId }, 30000, browser);
    return ok(clean(frames));
  }
);

server.tool(
  "browser_storage_get",
  "读取指定浏览器插件的本地存储（JSON 键值）",
  { ...browserParam, keys: z.array(z.string()).optional() },
  async ({ browser, keys }) => {
    const data = await rpcSend("storage-get", { keys }, 30000, browser);
    return ok(clean(data));
  }
);

server.tool(
  "browser_storage_set",
  "写入指定浏览器插件的本地存储（JSON 键值）",
  { ...browserParam, data: z.record(z.any()) },
  async ({ browser, data }) => {
    const r = await rpcSend("storage-set", { data }, 30000, browser);
    return ok(clean(r));
  }
);

server.tool(
  "browser_screenshot",
  "对指定标签页截图，返回 base64 PNG/JPEG（AI 可直接看图）",
  { ...browserParam, tabId: z.number(), format: z.enum(["png", "jpeg"]).optional().describe("默认 png"), quality: z.number().min(0).max(100).optional().describe("jpeg 质量 0-100") },
  async ({ browser, tabId, format, quality }) => {
    const r = await rpcSend("screenshot", { tabId, format, quality }, 60000, browser);
    const data = r && r.data ? r.data : null;
    return ok(data ? "data:image/" + (format || "png") + ";base64," + data : JSON.stringify(r));
  }
);

server.tool(
  "browser_downloads_download",
  "触发浏览器下载一个 URL",
  { ...browserParam, url: z.string(), filename: z.string().optional().describe("保存文件名（可选）"), conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).optional() },
  async ({ browser, url, filename, conflictAction }) => {
    const options = { url };
    if (filename) options.filename = filename;
    if (conflictAction) options.conflictAction = conflictAction;
    const id = await rpcSend("downloads-download", { options }, 60000, browser);
    return ok({ downloadId: id });
  }
);

server.tool(
  "browser_downloads_search",
  "查询浏览器下载记录",
  { ...browserParam, limit: z.number().optional().describe("返回条数，默认 10"), query: z.string().optional().describe("按文件名/URL 模糊搜索") },
  async ({ browser, limit, query }) => {
    const q = { limit: limit || 10, orderBy: ["-startTime"] };
    if (query) q.query = [query];
    const items = await rpcSend("downloads-search", { query: q }, 30000, browser);
    return ok(items.map((i) => ({ id: i.id, url: i.url, filename: i.filename, state: i.state, bytesReceived: i.bytesReceived, totalBytes: i.totalBytes, error: i.error })));
  }
);

server.tool(
  "browser_proxy_get",
  "查看当前代理设置",
  browserParam,
  async ({ browser }) => {
    const r = await rpcSend("proxy-get", {}, 30000, browser);
    return ok(clean(r));
  }
);

server.tool(
  "browser_proxy_set",
  "设置浏览器代理。value 格式：直连 {mode:'direct'}；系统 {mode:'system'}；固定代理 {mode:'fixed_servers', rules:{singleProxy:{scheme:'http',host:'127.0.0.1',port:7890}}}；PAC {mode:'pac_script', pacScript:{url:'...'}}",
  { ...browserParam, value: z.any().describe("代理配置对象，见描述") },
  async ({ browser, value }) => {
    const r = await rpcSend("proxy-set", { value }, 30000, browser);
    return ok(clean(r));
  }
);

server.tool(
  "browser_browsingdata_remove",
  "清除浏览数据。dataTypes 如 {cache:true, cookies:true, history:true, localStorage:true, passwords:false}",
  { ...browserParam, dataTypes: z.record(z.boolean()).describe("要清除的数据类型布尔映射"), since: z.number().optional().describe("自某时间戳（ms）以来，默认清除全部") },
  async ({ browser, dataTypes, since }) => {
    const options = since ? { since } : {};
    const r = await rpcSend("browsingdata-remove", { options, dataTypes }, 60000, browser);
    return ok(clean(r));
  }
);

server.tool(
  "browser_management_list",
  "列出浏览器中所有扩展（含启停状态）",
  browserParam,
  async ({ browser }) => {
    const list = await rpcSend("management-list", {}, 30000, browser);
    return ok(clean(list));
  }
);

server.tool(
  "browser_history_search",
  "搜索浏览历史",
  { ...browserParam, text: z.string().describe("搜索关键词（空串=全部）"), maxResults: z.number().optional() },
  async ({ browser, text, maxResults }) => {
    const items = await rpcSend("history-search", { query: { text: text || "", maxResults: maxResults || 50 } }, 30000, browser);
    return ok(items.map((i) => ({ url: i.url, title: i.title, lastVisitTime: i.lastVisitTime, visitCount: i.visitCount })));
  }
);

server.tool(
  "browser_bookmarks_list",
  "列出书签树",
  browserParam,
  async ({ browser }) => {
    const tree = await rpcSend("bookmarks-list", {}, 30000, browser);
    return ok(clean(tree));
  }
);

server.tool(
  "browser_notify",
  "发送系统通知（标题+消息）",
  { ...browserParam, title: z.string().optional(), message: z.string().optional() },
  async ({ browser, title, message }) => {
    const r = await rpcSend("notify", { title, message }, 30000, browser);
    return ok(clean(r));
  }
);

// ---------- 启动 ----------
await initBridge();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[bridge] MCP server 已就绪（stdio）。");
