// 通过 CDP 将 edge-extension 安装进 Edge 9222（Edge 扩展管理页自动化）
const BASE = "http://127.0.0.1:9222";
const EXT_DIR = "D:\\makemoneyreasonix\\edge-extension";

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

async function main() {
  // [1] 定位/创建标签
  console.log("[1] 定位 edge://extensions 标签 …");
  let list = await fetch(BASE + "/json/list").then(r => r.json());
  let tab = list.find(t => t.type === "page" && t.url.startsWith("edge://extensions"));
  if (!tab) {
    await fetch(BASE + "/json/new?edge://extensions", { method: "PUT" });
    await sleep(1500);
    list = await fetch(BASE + "/json/list").then(r => r.json());
    tab = list.find(t => t.type === "page" && t.url.startsWith("edge://extensions"));
  }
  if (!tab) throw new Error("无法创建 edge://extensions 标签");

  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });

  const evalJs = async (label, expr) => {
    const r = await withTimeout(cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 4000 }), 15000, "eval:" + label);
    if (r.exceptionDetails) throw new Error("eval异常[" + label + "]: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  };

  // 等待就绪
  for (let i = 0; i < 30; i++) {
    try { if (await evalJs("ready", "document.readyState === 'complete' && !!document.querySelector('root-app')")) break; } catch (_) {}
    await sleep(500);
  }

  // [2] 开启开发者模式
  console.log("[2] 开启开发者模式 …");
  const devState = await evalJs("dev", `
    (() => {
      const ra = document.querySelector('root-app').shadowRoot;
      const sps = ra.querySelector('side-nav-pane').shadowRoot;
      const pt = sps.querySelector('profile-toggles');
      const dms = pt.shadowRoot.querySelector('developer-mode-switch');
      const sw = dms.shadowRoot.querySelector('fluent-switch#dev-switch');
      const checkedProp = typeof sw.checked === 'boolean' ? sw.checked : (sw.hasAttribute('checked') && sw.getAttribute('checked') !== 'false');
      if (!checkedProp) { sw.click(); return 'clicked-open'; }
      return 'already-on';
    })()`);
  console.log("    dev:", devState);
  await sleep(1200);

  // 轮询确认开发者模式已开启（fluent-switch 用 checked property）
  let devOk = false;
  for (let i = 0; i < 10; i++) {
    const c = await evalJs("devcheck", `
      (() => {
        const ra = document.querySelector('root-app').shadowRoot;
        const sps = ra.querySelector('side-nav-pane').shadowRoot;
        const pt = sps.querySelector('profile-toggles');
        const dms = pt.shadowRoot.querySelector('developer-mode-switch');
        const sw = dms.shadowRoot.querySelector('fluent-switch#dev-switch');
        return typeof sw.checked === 'boolean' ? sw.checked : (sw.hasAttribute('checked') && sw.getAttribute('checked') !== 'false');
      })()`);
    if (c === true) { devOk = true; break; }
    await sleep(500);
  }
  console.log("    devCheck:", devOk);
  if (!devOk) throw new Error("开发者模式未能开启");

  // [3] 查找"加载解压缩的扩展"按钮（穿透 shadow，剪枝；放宽条件 + 长等待）
  console.log("[3] 查找『加载解压缩的扩展』按钮 …");
  let btnInfo = null;
  for (let i = 0; i < 40; i++) {
    btnInfo = await evalJs("findbtn", `
      (() => {
        const found = [];
        const raw = [];
        function walk(el) {
          const t = (el.textContent || '');
          if (t.includes('加载') || t.includes('Load')) {
            const tag = el.tagName || '';
            if (/加载解压缩|Load unpacked/.test(t.trim())) {
              found.push({ tag: el.tagName, text: t.trim().slice(0, 30), parent: el.parentElement ? el.parentElement.tagName : '' });
            }
            raw.push(tag + ':' + t.trim().slice(0, 20));
          }
          if (el.shadowRoot) walk(el.shadowRoot);
          for (const c of el.children) walk(c);
        }
        walk(document.querySelector('root-app'));
        return { found: found.slice(0, 5), raw: raw.slice(0, 20) };
      })()`);
    if (btnInfo && btnInfo.found && btnInfo.found.length) break;
    if (i === 4) console.log("    debug:", JSON.stringify(btnInfo));
    await sleep(750);
  }
  if (!btnInfo || !btnInfo.found || !btnInfo.found.length) {
    console.log("    final debug:", JSON.stringify(btnInfo));
    throw new Error("未找到『加载解压缩的扩展』按钮");
  }
  console.log("    btn:", JSON.stringify(btnInfo.found));

  // [4] 点击按钮 + 拦截文件选择器
  console.log("[4] 点击加载按钮，拦截文件选择器 …");
  let chooserMode = null;
  let chooserResolve;
  const chooserPromise = new Promise((res) => (chooserResolve = res));
  cdp.on("Page.fileChooserOpened", async (params) => {
    chooserMode = params.mode;
    console.log("    fileChooserOpened: mode=" + params.mode);
    try {
      await cdp.send("Page.handleFileChooser", { files: [EXT_DIR] });
      console.log("    → 已填入目录:", EXT_DIR);
      chooserResolve("handled");
    } catch (e) {
      console.log("    → handleFileChooser 失败:", e.message);
      chooserResolve("failed:" + e.message);
    }
  });

  await evalJs("clickbtn", `
    (() => {
      const found = [];
      function walk(el) {
        const t = el.textContent || '';
        if (!t.includes('加载解压缩') && !t.includes('Load unpacked')) return;
        if (/加载解压缩|Load unpacked/.test(t.trim())) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        for (const c of el.children) walk(c);
      }
      walk(document.querySelector('root-app'));
      const btn = found[0];
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked:' + btn.tagName + ':' + btn.textContent.trim();
    })()`);
  const chooserResult = await Promise.race([chooserPromise, sleep(8000).then(() => "timeout")]);
  console.log("    chooser:", chooserResult);
  if (chooserMode === "selectFolder" || chooserResult === "handled") {
    console.log("    目录选择模式，可能需再次确认（部分版本点击两次）");
  }

  // [5] 验证安装
  console.log("[5] 验证 …");
  let verify = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    try {
      verify = await evalJs("verify", `
        (() => {
          const ra = document.querySelector('root-app');
          const bodyText = (ra ? ra.textContent : document.body.innerText) || '';
          const items = bodyText.includes('Reasonix');
          return { hasReasonix: items, snippet: bodyText.replace(/\\s+/g, ' ').slice(0, 300) };
        })()`);
    } catch (_) { continue; }
    if (verify && verify.hasReasonix) break;
  }
  console.log("    verify:", JSON.stringify(verify));

  // 提取扩展 ID（详情查看）
  const extId = await evalJs("extid", `
    (() => {
      const ra = document.querySelector('root-app');
      const t = (ra ? ra.textContent : '') || '';
      const m = t.match(/[a-p]{32}/);
      return m ? m[0] : null;
    })()`).catch(() => null);
  console.log("    extensionId(猜测):", extId);

  const ok = verify && verify.hasReasonix;
  console.log(ok ? "\n✅ 插件安装成功！" : "\n❌ 未检测到插件，请查看输出");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
