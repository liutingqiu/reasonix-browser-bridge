// 热重载插件（ID 不变，无需重装）
const BASE = "http://127.0.0.1:9222";
const EXT_ID = "opkhlmbkpneaikfekhelkhhkbfljokff";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error("TIMEOUT:" + label); })]);
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } };
  }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  static async connect(url) { const ws = new WebSocket(url); await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 10000, "ws-connect"); return new CDP(ws); }
}
const list = await fetch(BASE + "/json/list").then(r => r.json());
const tab = list.find(t => t.type === "page" && t.url.startsWith("edge://extensions"));
if (!tab) { console.error("找不到 edge://extensions 标签"); process.exit(1); }
const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
const evalJs = async (label, expr) => {
  const r = await withTimeout(cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 5000, awaitPromise: true }), 15000, "eval:" + label);
  if (r.exceptionDetails) throw new Error("eval异常[" + label + "]: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};
const r = await evalJs("reload", `(async () => { try { await window.chrome.developerPrivate.reload('${EXT_ID}'); return 'reloaded'; } catch (e) { return 'err:' + (e.message || e); } })()`);
console.log("reload:", r);
await sleep(2500);
// 确认插件仍在
const check = await evalJs("check", `(async () => { try { const info = await window.chrome.developerPrivate.getExtensionInfo('${EXT_ID}'); return { name: info.name, state: info.state, version: info.version }; } catch (e) { return 'err:' + (e.message || e); } })()`);
console.log("check:", JSON.stringify(check));
process.exit(0);
