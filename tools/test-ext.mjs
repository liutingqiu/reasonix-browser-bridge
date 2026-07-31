// 修正版验证：awaitPromise + isolated world 检测 content script
const BASE = "http://127.0.0.1:9222";
const EXT_ID = "opkhlmbkpneaikfekhelkhhkbfljokff";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error("TIMEOUT:" + label); })]);
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }
      else if (m.method) { for (const h of this.handlers.get(m.method) || []) h(m.params); }
    };
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(method, h) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(h); }
  static async connect(url) { const ws = new WebSocket(url); await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 10000, "ws-connect"); return new CDP(ws); }
}
const evalJs = async (cdp, label, expr) => {
  const r = await withTimeout(cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 5000, awaitPromise: true }), 15000, "eval:" + label);
  if (r.exceptionDetails) return "EXC: " + JSON.stringify(r.exceptionDetails).slice(0, 200);
  return r.result.value;
};

let list = await fetch(BASE + "/json/list").then(r => r.json());
const dash = list.find(t => t.type === "page" && t.url.includes(EXT_ID) && t.url.includes("dashboard"));
const cdp = await CDP.connect(dash.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

// 心跳 storage（awaitPromise 修正）
const hb = await evalJs(cdp, "hb", `
  (async () => {
    const data = await chrome.storage.local.get('heartbeat');
    return data.heartbeat || null;
  })()`);
console.log("[1] 心跳 storage:", JSON.stringify(hb));

// 网关 tabs-list
const gw = await evalJs(cdp, "gw", `
  (async () => {
    const res = await chrome.runtime.sendMessage({ type: 'tabs-list', query: {} });
    return { count: res.length, first: res[0] && { id: res[0].id, url: res[0].url, title: (res[0].title||'').slice(0,30) } };
  })()`);
console.log("[2] 网关 tabs-list:", JSON.stringify(gw));

// 网关 cookies-getAll（域统计）
const ck = await evalJs(cdp, "ck", `
  (async () => {
    const cookies = await chrome.runtime.sendMessage({ type: 'cookies-getAll', details: {} });
    const byDom = {};
    for (const c of cookies) byDom[c.domain] = (byDom[c.domain] || 0) + 1;
    const top = Object.entries(byDom).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { total: cookies.length, top };
  })()`);
console.log("[3] 网关 cookies:", JSON.stringify(ck));

// content script：找 example.com 的 isolated world
let list2 = await fetch(BASE + "/json/list").then(r => r.json());
const ex = list2.find(t => t.type === "page" && t.url.startsWith("https://example.com"));
console.log("[4] content script 检测（example.com）…");
const contexts = [];
const cdp2 = await CDP.connect(ex.webSocketDebuggerUrl);
cdp2.on("Runtime.executionContextCreated", (p) => {
  const ctx = p.context;
  contexts.push({ id: ctx.id, origin: ctx.origin, name: ctx.name, aux: ctx.auxData && { type: ctx.auxData.type, isDefault: ctx.auxData.isDefault } });
});
await cdp2.send("Runtime.enable");
await sleep(1500);
const iso = contexts.filter(c => String(c.origin).includes(EXT_ID));
console.log("    isolated contexts:", JSON.stringify(iso));
console.log("    → content script 注入:", iso.length > 0 ? "✅ 成功" : "❌ 未注入");

// 在 isolated world 里直接读 __REASONIX__
if (iso.length) {
  const cid = iso[0].id;
  const r = await cdp2.send("Runtime.evaluate", { expression: "window.__REASONIX__ === true", returnByValue: true, contextId: cid });
  console.log("    isolated world __REASONIX__:", r.result && r.result.value);
}
process.exit(0);
