// Browser MCP Bridge - 全站标记注入（document_start，所有帧）
(() => {
  try {
    Object.defineProperty(window, "__BROWSER_MCP_BRIDGE__", { value: true, configurable: false });
  } catch (_) {}
})();
