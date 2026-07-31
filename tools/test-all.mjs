// 全量测试：覆盖全部 25 个 MCP 工具
// 策略：只读工具 → edge（真实数据）；破坏性工具 → chrome（非运营浏览器）+ 最小影响
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: ["index.js"], cwd: serverDir });
const client = new Client({ name: "full-suite", version: "1.0.0" });
await client.connect(transport);
await new Promise((r) => setTimeout(r, 4000));

const results = [];
const R = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content[0].text;
};
const jp = (txt) => { try { return JSON.parse(txt); } catch { return null; } };

try {
  // ---------- 只读工具（edge，真实数据） ----------
  const E = { browser: "edge" };
  const C = { browser: "chrome" };

  // 1 browser_list
  const bl = jp(await call("browser_list", {}));
  R("browser_list", Array.isArray(bl) && bl.length >= 2, `连接: ${bl.map((b) => b.browser).join(", ")}`);

  // 2 browser_state
  const st = jp(await call("browser_state", E));
  R("browser_state", st && st.connected === true, `v${st && st.version} heartbeat-ok`);

  // 3 browser_tabs_list
  const tabs = jp(await call("browser_tabs_list", E));
  R("browser_tabs_list", Array.isArray(tabs) && tabs.length > 0, `${tabs.length} 个标签`);

  // 4 browser_tabs_open → 记录新 tab
  const opened = jp(await call("browser_tabs_open", { ...C, url: "https://example.com", active: false }));
  R("browser_tabs_open", opened && opened.id, `tab#${opened && opened.id}`);
  const newTabId = opened && opened.id;
  await new Promise((r) => setTimeout(r, 2000));

  // 5 browser_tabs_activate
  const act = jp(await call("browser_tabs_activate", { ...C, tabId: newTabId }));
  R("browser_tabs_activate", act && act.active === true, `tab#${newTabId} 已激活`);

  // 6 browser_tabs_reload
  const rel = await call("browser_tabs_reload", { ...C, tabId: newTabId });
  R("browser_tabs_reload", /已刷新/.test(rel), rel);

  // 7 browser_tabs_close → 移到末尾统一清理（后续步骤还要用 newTabId）

  // 8 cookies_getAll
  const ck = jp(await call("browser_cookies_getAll", E));
  R("browser_cookies_getAll", Array.isArray(ck), `${ck.length} 条 cookie`);

  // 9-11 cookies get/set/remove（example.com 测试 cookie，Chrome）
  const cg = jp(await call("browser_cookies_get", { ...C, url: "https://example.com/", name: "__test_rbb" }));
  R("browser_cookies_get", cg && (cg.notFound === true || cg.name === "__test_rbb"), cg && cg.notFound ? "不存在（预期）" : "已存在");

  const cs = jp(await call("browser_cookies_set", { ...C, url: "https://example.com/", name: "__test_rbb", value: "ok123" }));
  R("browser_cookies_set", cs && cs.name === "__test_rbb", `${cs.name}=${cs.value}`);

  const cg2 = jp(await call("browser_cookies_get", { ...C, url: "https://example.com/", name: "__test_rbb" }));
  R("browser_cookies_get(验证写入)", cg2 && cg2.value === "ok123", `value=${cg2 && cg2.value}`);

  const cr = jp(await call("browser_cookies_remove", { ...C, url: "https://example.com/", name: "__test_rbb" }));
  R("browser_cookies_remove", !!(cr && (cr.name === "__test_rbb" || cr === null)), JSON.stringify(cr).slice(0, 60));

  // 12 script_execute
  const ex = jp(await call("browser_script_execute", { ...C, tabId: newTabId, code: "({ t: document.title })" }));
  R("browser_script_execute", ex && ex.result && ex.result.t === "Example Domain", `title=${ex && ex.result && ex.result.t}`);

  // 13 screenshot（Chrome example.com）
  const sc = await call("browser_screenshot", { ...C, tabId: newTabId });
  R("browser_screenshot", sc.startsWith("data:image/png;base64,"), `PNG 长度=${sc.length}`);

  // 14 downloads_download（example.com 小文件）
  const dd = jp(await call("browser_downloads_download", { ...C, url: "https://example.com/", filename: "rbb-test.html" }));
  R("browser_downloads_download", dd && typeof dd.downloadId === "number", `downloadId=${dd && dd.downloadId}`);
  await new Promise((r) => setTimeout(r, 2000));

  // 15 downloads_search
  const ds = jp(await call("browser_downloads_search", { ...C, limit: 3 }));
  R("browser_downloads_search", Array.isArray(ds), `${ds.length} 条记录`);

  // 16 proxy_get
  const pg = jp(await call("browser_proxy_get", E));
  R("browser_proxy_get", pg && pg.value && pg.value.mode, `mode=${pg && pg.value && pg.value.mode}`);

  // 17 proxy_set（Chrome：设 direct → 验证 → 恢复 system）
  const ps = jp(await call("browser_proxy_set", { ...C, value: { mode: "direct" } }));
  R("browser_proxy_set", ps && ps.ok === true, "已设 direct");
  const pg2 = jp(await call("browser_proxy_get", C));
  const restored = await call("browser_proxy_set", { ...C, value: { mode: "system" } });
  R("browser_proxy_set(验证+恢复)", pg2 && pg2.value && pg2.value.mode === "direct", `验证 direct ✓ 已恢复 system`);

  // 18 browsingdata_remove（Chrome：仅 cache，不影响 cookie）
  const bd = jp(await call("browser_browsingdata_remove", { ...C, dataTypes: { cache: true } }));
  R("browser_browsingdata_remove", bd && bd.ok === true, "仅清理 cache");

  // 19 management_list
  const ml = jp(await call("browser_management_list", E));
  R("browser_management_list", Array.isArray(ml) && ml.some((e) => String(e.name).includes("Reasonix")), `${ml.length} 个扩展`);

  // 20 history_search
  const hs = jp(await call("browser_history_search", { ...E, text: "", maxResults: 3 }));
  R("browser_history_search", Array.isArray(hs) && hs.length > 0, `${hs.length} 条历史`);

  // 21 bookmarks_list
  const bm = jp(await call("browser_bookmarks_list", E));
  R("browser_bookmarks_list", Array.isArray(bm), `书签树根节点 ${bm.length} 个`);

  // 22 notify
  const nt = jp(await call("browser_notify", { ...E, title: "Test", message: "Reasonix Bridge test" }));
  R("browser_notify", nt && nt.ok === true, "已发送");

  // 23 webnav_frames（Chrome example.com）
  const wf = jp(await call("browser_webnav_frames", { ...C, tabId: newTabId }));
  R("browser_webnav_frames", Array.isArray(wf) && wf.length > 0, `${wf.length} 帧`);

  // 24 storage_get
  const sg = jp(await call("browser_storage_get", E));
  R("browser_storage_get", typeof sg === "object" && sg !== null, "可读");

  // 25 storage_set（写测试键后清理）
  const ss = jp(await call("browser_storage_set", { ...E, data: { __test_key: "v" } }));
  const ss2 = jp(await call("browser_storage_get", { ...E, keys: ["__test_key"] }));
  const ss3 = jp(await call("browser_storage_set", { ...E, data: { __test_key: null } }));
  R("browser_storage_set", ss && ss.ok === true && ss2 && ss2.__test_key === "v", "写读 ✓ 已清理");

  // 26 tabs_close（末尾统一清理测试 tab）
  const cl = await call("browser_tabs_close", { ...C, tabIds: [newTabId] });
  R("browser_tabs_close", /已关闭/.test(cl), cl);
} catch (e) {
  console.log("❌ 测试中断:", e.message);
  results.push({ name: "(中断)", ok: false, detail: e.message });
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== 测试汇总: ${pass}/${results.length} 通过 =====`);
process.exit(pass === results.length ? 0 : 1);
