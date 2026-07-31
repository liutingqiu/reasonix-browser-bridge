// Reasonix Browser Bridge - 后台 service worker
// 功能：本地 WebSocket 桥 + 统一浏览器操作网关（tabs/cookies/scripting/screenshot/downloads/proxy/...）
// MCP server 监听 ws://127.0.0.1:8747，插件自动连接，Reasonix 即可控制浏览器。

const VERSION = "2.3.0";
const WS_URL = "ws://127.0.0.1:8747";
const RECONNECT_MS = 3000;

// ---------- 心跳 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bmb-heartbeat", { periodInMinutes: 5 });
  chrome.alarms.create("bmb-reconnect", { periodInMinutes: 1 });
  heartbeat();
  connectWS();
});
chrome.runtime.onStartup.addListener(() => {
  heartbeat();
  connectWS();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bmb-heartbeat") heartbeat();
  // 兜底重连：SW 休眠会挂起 setTimeout，alarms 可唤醒 SW 检查连接
  if (a.name === "bmb-reconnect") ensureConnected();
});

async function heartbeat() {
  const now = Date.now();
  const last = (await chrome.storage.local.get("heartbeat")).heartbeat || {};
  const gapMin = last.ts ? Math.round((now - last.ts) / 60000) : 0;
  await chrome.storage.local.set({ heartbeat: { ts: now, gapMin, version: VERSION } });
}

// ---------- 徽章：显示桥接状态 ----------
async function setBadge() {
  const connected = ws && ws.readyState === WebSocket.OPEN;
  const hb = (await chrome.storage.local.get("heartbeat")).heartbeat;
  const minAgo = hb ? Math.round((Date.now() - hb.ts) / 60000) : 99;
  if (connected) {
    chrome.action.setBadgeText({ text: "M" });
    chrome.action.setBadgeBackgroundColor({ color: "#2b8a3e" });
  } else if (minAgo <= 15) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e8590c" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- 统一操作网关 ----------
// 输入 {type, params}，输出 {result} 或 {error}。同时服务 popup 与 WS 桥。
async function handleGateway(type, params = {}) {
  switch (type) {
    case "get-state":
      return { result: { version: VERSION, heartbeat: (await chrome.storage.local.get("heartbeat")).heartbeat || null, connected: !!(ws && ws.readyState === WebSocket.OPEN) } };

    case "tabs-list": {
      const tabs = await chrome.tabs.query(params.query || {});
      return { result: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, status: t.status, favIconUrl: t.favIconUrl, incognito: t.incognito })) };
    }
    case "tabs-open":
      return { result: await chrome.tabs.create(params.data || {}) };
    case "tabs-activate": {
      const tab = await chrome.tabs.update(params.tabId, { active: true });
      if (params.windowId) await chrome.windows.update(params.windowId, { focused: true });
      return { result: tab };
    }
    case "tabs-update":
      return { result: await chrome.tabs.update(params.tabId, params.data || {}) };
    case "tabs-close":
      return { result: await chrome.tabs.remove(params.tabIds) };
    case "tabs-reload":
      return { result: await chrome.tabs.reload(params.tabId, params.data) };
    case "tabs-query":
      return { result: await chrome.tabs.query(params.query || {}) };

    case "cookies-getAll":
      return { result: await chrome.cookies.getAll(params.details || {}) };
    case "cookies-get":
      return { result: await chrome.cookies.get(params.details) };
    case "cookies-set":
      return { result: await chrome.cookies.set(params.details) };
    case "cookies-remove":
      return { result: await chrome.cookies.remove(params.details) };

    case "scripting-execute": {
      const res = await chrome.scripting.executeScript({
        target: { tabId: params.tabId, allFrames: !!params.allFrames },
        func: params.func,
        args: params.args || []
      });
      return { result: res.map((r) => ({ frameId: r.frameId, result: r.result, error: r.error })) };
    }
    // 代码字符串注入：把任意 JS 代码字符串在目标页执行（同步执行器，规避扩展页 CSP 与 promise-await 语义差异）
    case "scripting-execute-code": {
      const INJECTOR = (code) => { const fn = new Function(code); return fn(); };
      const res = await chrome.scripting.executeScript({
        target: { tabId: params.tabId, allFrames: !!params.allFrames },
        func: INJECTOR,
        args: [params.code]
      });
      return { result: res.map((r) => ({ frameId: r.frameId, result: r.result, error: r.error })) };
    }
    // 任意 JS 执行：用 CDP Runtime.evaluate，绕过页面 CSP（executeScript 无法 eval 字符串）
    case "scripting-eval": {
      if (!params.tabId) return { error: "tabId required" };
      await chrome.debugger.attach({ tabId: params.tabId }, "1.3");
      try {
        const r = await chrome.debugger.sendCommand({ tabId: params.tabId }, "Runtime.evaluate", {
          expression: params.code,
          returnByValue: true,
          awaitPromise: !!params.awaitPromise
        });
        return { result: { result: r.result ? r.result.value : null, exceptionDetails: r.exceptionDetails || null } };
      } finally {
        try { await chrome.debugger.detach({ tabId: params.tabId }); } catch (_) {}
      }
    }
    // 标签页截图：CDP Page.captureScreenshot，返回 base64
    case "screenshot": {
      if (!params.tabId) return { error: "tabId required" };
      await chrome.debugger.attach({ tabId: params.tabId }, "1.3");
      try {
        const r = await chrome.debugger.sendCommand({ tabId: params.tabId }, "Page.captureScreenshot", {
          format: params.format || "png",
          quality: params.quality,
          fromSurface: true
        });
        return { result: { data: r.data } };
      } finally {
        try { await chrome.debugger.detach({ tabId: params.tabId }); } catch (_) {}
      }
    }
    // 下载
    case "downloads-download":
      return { result: await chrome.downloads.download(params.options) };
    case "downloads-search":
      return { result: await chrome.downloads.search(params.query || {}) };
    case "downloads-cancel":
      return { result: await chrome.downloads.cancel(params.id) };
    // 代理
    case "proxy-get":
      return { result: await chrome.proxy.settings.get(params.details || {}) };
    case "proxy-set":
      await chrome.proxy.settings.set({ value: params.value, scope: params.scope || "regular" });
      return { result: { ok: true } };
    // 浏览数据清理
    case "browsingdata-remove":
      await chrome.browsingData.remove(params.options || {}, params.dataTypes || {});
      return { result: { ok: true } };
    // 扩展管理
    case "management-list":
      return { result: (await chrome.management.getAll()).map((e) => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, installType: e.installType, version: e.version })) };
    case "management-setEnabled":
      return { result: await chrome.management.setEnabled(params.id, params.enabled) };
    // 历史 / 书签
    case "history-search":
      return { result: await chrome.history.search(params.query) };
    case "bookmarks-list":
      return { result: await chrome.bookmarks.getTree() };
    // 系统通知
    case "notify": {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: params.title || "Reasonix Browser Bridge",
        message: params.message || ""
      });
      return { result: { ok: true } };
    }
    case "scripting-insertCSS":
      return { result: await chrome.scripting.insertCSS({ target: { tabId: params.tabId }, css: params.css }) };
    case "scripting-removeCSS":
      return { result: await chrome.scripting.removeCSS({ target: { tabId: params.tabId }, css: params.css }) };

    case "webnav-frames":
      return { result: await chrome.webNavigation.getAllFrames({ tabId: params.tabId }) };

    case "storage-get":
      return { result: await chrome.storage.local.get(params.keys) };
    case "storage-set":
      await chrome.storage.local.set(params.data);
      return { result: { ok: true } };
    case "storage-clear":
      await chrome.storage.local.clear();
      return { result: { ok: true } };

    default:
      return { error: "unknown type: " + type };
  }
}

// ---------- 本地 WebSocket 桥（连接 MCP server） ----------
let ws = null;
let reconnectTimer = null;

function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    setBadge();
    try {
      const browser = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
      ws.send(JSON.stringify({ type: "hello", role: "extension", browser }));
    } catch (_) {}
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    const id = msg.id;
    let reply;
    try {
      reply = await handleGateway(msg.type, msg.params || {});
    } catch (e) {
      reply = { error: String((e && e.message) || e) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ id, ...reply })); } catch (_) {}
    }
  };
  ws.onclose = () => { setBadge(); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, RECONNECT_MS);
}

// alarms 兜底：WS 断开且 SW 休眠后重连
function ensureConnected() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connectWS();
  }
}

// ---------- popup 消息 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  handleGateway(msg.type, msg.params || {})
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // 异步
});

connectWS();
