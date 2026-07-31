// 通过 CDP 将扩展安装进 Chrome（9223）
// 流程: 打开 chrome://extensions → 开发者模式 → 点"加载已解压的扩展" → dialog-auto.py 填路径 → 验证
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:9223";
const EXT_DIR = "D:\\makemoneyreasonix\\edge-extension";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function findOrCreateExtensionsTab() {
  let list = await fetch(BASE + "/json/list").then(r => r.json());
  let tab = list.find(t => t.type === "page" && t.url.startsWith("chrome://extensions"));
  if (!tab) {
    await fetch(BASE + "/json/new?chrome://extensions", { method: "PUT" });
    await sleep(1500);
    list = await fetch(BASE + "/json/list").then(r => r.json());
    tab = list.find(t => t.type === "page" && t.url.startsWith("chrome://extensions"));
  }
  return tab;
}

const runDialogAuto = () => new Promise((resolve) => {
  const p = spawn("python", [path.join(__dirname, "dialog-auto.py")], { stdio: "inherit" });
  p.on("close", (code) => resolve(code));
});

async function main() {
  console.log("[1] 定位 chrome://extensions 标签 …");
  const tab = await findOrCreateExtensionsTab();
  if (!tab) throw new Error("无法创建 chrome://extensions 标签");
  console.log("    tab:", tab.id, tab.url);

  console.log("[2] 连接 CDP …");
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  try { await cdp.send("Page.reload"); await sleep(2000); } catch (_) {}

  const evalJs = async (label, expr) => {
    const r = await withTimeout(cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 4000 }), 15000, "eval:" + label);
    if (r.exceptionDetails) throw new Error("eval异常[" + label + "]: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  };

  for (let i = 0; i < 30; i++) {
    try { if (await evalJs("ready", "document.readyState === 'complete' && !!document.querySelector('extensions-manager')")) break; } catch (_) {}
    await sleep(500);
  }

  console.log("[3] 检查开发者模式 + 加载按钮 …");
  // Chrome 标准结构：extensions-toolbar > [shadow] > cr-toolbar 区域；devMode toggle / loadUnpacked 穿透查找
  let state = null;
  for (let i = 0; i < 20; i++) {
    state = await evalJs("state", `
      (() => {
        const mgr = document.querySelector('extensions-manager');
        let toggle = null, btn = null;
        function find(el, depth) {
          if (depth > 10) return;
          if (el.tagName === 'CR-TOGGLE' && el.id === 'devMode') toggle = { checked: !!el.checked };
          if (el.tagName === 'CR-BUTTON' && el.id === 'loadUnpacked') btn = { disabled: el.disabled, text: el.textContent.trim() };
          if (el.shadowRoot) find(el.shadowRoot, depth + 1);
          for (const c of el.children) find(c, depth + 1);
        }
        find(mgr, 0);
        return { toggle, btn };
      })()`);
    if (state && state.btn) break;
    await sleep(700);
  }
  console.log("    state:", JSON.stringify(state));
  if (!state || !state.btn) throw new Error("未找到 loadUnpacked 按钮");
  if (!state.toggle || !state.toggle.checked) {
    // 开启开发者模式
    await evalJs("dev", `
      (() => {
        const mgr = document.querySelector('extensions-manager');
        function find(el) {
          if (el.tagName === 'CR-TOGGLE' && el.id === 'devMode') { el.click(); return 'clicked'; }
          if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; }
          for (const c of el.children) { const r = find(c); if (r) return r; }
          return null;
        }
        return find(mgr) || 'not-found';
      })()`);
    await sleep(1000);
    console.log("    devMode 已开启");
  }

  // 点 loadUnpacked → 弹文件选择器。优先 CDP 拦截（handleFileChooser），失败则 Win32 自动化
  console.log("[4] 点击加载按钮，触发文件选择器 …");
  let chooserFired = false;
  let chooserResolve;
  const chooserPromise = new Promise((res) => (chooserResolve = res));
  cdp.on("Page.fileChooserOpened", async (params) => {
    chooserFired = true;
    console.log("    fileChooserOpened: mode=" + params.mode);
    try {
      await cdp.send("Page.handleFileChooser", { files: [EXT_DIR] });
      console.log("    → CDP 已填入目录:", EXT_DIR);
      chooserResolve("handled");
    } catch (e) {
      console.log("    handleFileChooser 失败:", e.message);
      chooserResolve("failed");
    }
  });
  await evalJs("click", `
    (() => {
      const mgr = document.querySelector('extensions-manager');
      function find(el) {
        if (el.tagName === 'CR-BUTTON' && el.id === 'loadUnpacked') { el.click(); return 'clicked'; }
        if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; }
        for (const c of el.children) { const r = find(c); if (r) return r; }
        return null;
      }
      return find(mgr) || 'not-found';
    })()`);
  const chooserResult = await Promise.race([chooserPromise, sleep(4000).then(() => "timeout")]);
  console.log("    chooser:", chooserResult);
  if (!chooserFired) {
    console.log("[5] CDP 拦截未触发，Win32 自动化填路径 …");
    const code = await runDialogAuto();
    console.log("    dialog-auto 退出码:", code);
  } else {
    console.log("[5] CDP 已处理，跳过 Win32");
  }
  await sleep(2000);

  console.log("[6] 验证扩展加载 …");
  let verify = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    verify = await evalJs("verify", `
      (() => {
        const mgr = document.querySelector('extensions-manager');
        const list = mgr && mgr.shadowRoot.querySelector('extensions-item-list');
        if (!list) return { err: 'no-list' };
        const items = Array.from(list.shadowRoot.querySelectorAll('extensions-item'));
        return items.map(i => ({ name: i.getAttribute('name'), id: i.getAttribute('id'), errors: i.getAttribute('errors') }));
      })()`);
    if (verify && Array.isArray(verify) && verify.some(n => n.name && String(n.name).includes("Browser MCP Bridge"))) break;
  }
  console.log("    verify:", JSON.stringify(verify, null, 1));

  const ok = verify && Array.isArray(verify) && verify.some(n => n.name && String(n.name).includes("Browser MCP Bridge"));
  console.log(ok ? "\n✅ Chrome 插件安装成功！" : "\n❌ 未检测到插件");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
