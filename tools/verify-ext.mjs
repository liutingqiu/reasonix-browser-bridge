// 验证 Reasonix 插件是否已加载 + 打开特权控制台测试
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error("TIMEOUT:" + label); })]);
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } };
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  static async connect(url) { const ws = new WebSocket(url); await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 10000, "ws-connect"); return new CDP(ws); }
}

// 1) 浏览器级目标列表，找 chrome-extension:// 目标
const browserWs = (await fetch(BASE + "/json/version").then(r => r.json())).webSocketDebuggerUrl;
const b = await CDP.connect(browserWs);
const targets = await b.send("Target.getTargets");
const extTargets = targets.targetInfos.filter(t => (t.url || "").startsWith("chrome-extension://"));
console.log("extension targets:", extTargets.length);
for (const t of extTargets) console.log("  -", t.type, t.url);

// 2) 若扩展已加载，打开特权控制台
const ids = [...new Set(extTargets.map(t => t.url.split("/")[2]))];
const extId = ids[0] || null;
console.log("extId:", extId);

if (extId) {
  // 用 browser CDP 直接创建 tab 打开 dashboard
  const { targetId } = await b.send("Target.createTarget", { url: `chrome-extension://${extId}/dashboard.html` });
  console.log("dashboard targetId:", targetId);
  await sleep(2500);

  // attach 到 dashboard 验证页面是否正常渲染
  const pageWs = "ws://127.0.0.1:9222/devtools/page/" + targetId;
  let ok = false;
  try {
    const p = await CDP.connect(pageWs);
    await p.send("Runtime.enable");
    const r = await withTimeout(p.send("Runtime.evaluate", { expression: "({ title: document.title, hasChrome: typeof chrome !== 'undefined', permCount: document.getElementById('permCount') ? document.getElementById('permCount').textContent : null })", returnByValue: true }), 8000, "eval");
    console.log("dashboard check:", JSON.stringify(r.result.value));
    ok = true;
  } catch (e) { console.log("dashboard attach fail:", e.message); }
  console.log(ok ? "\n✅ 插件工作正常" : "\n⚠️ dashboard 校验异常");
}

// 3) 通过扩展管理页再确认扩展列表（含 ID）
const list = await fetch(BASE + "/json/list").then(r => r.json());
const extTab = list.find(t => t.type === "page" && t.url.startsWith("edge://extensions"));
if (extTab && extId) {
  const p = await CDP.connect(extTab.webSocketDebuggerUrl);
  await p.send("Runtime.enable");
  const r = await withTimeout(p.send("Runtime.evaluate", { expression: `
    (() => {
      const ra = document.querySelector('root-app');
      const t = (ra ? ra.textContent : '') || '';
      return { hasReasonix: t.includes('Reasonix'), snippet: t.replace(/\\s+/g,' ').slice(0, 200) };
    })()`, returnByValue: true }), 8000, "eval2");
  console.log("ext page:", JSON.stringify(r.result.value));
}
process.exit(0);
