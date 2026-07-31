// Browser MCP Bridge - popup
chrome.runtime.sendMessage({ type: "get-state" }, (res) => {
  if (chrome.runtime.lastError || !res || !res.result) { setUnknown(); return; }
  const s = res.result;
  document.getElementById("ver").textContent = s.version || "-";
  const dot = document.getElementById("dot");
  const bridge = document.getElementById("bridge");
  if (s.connected) {
    dot.className = "dot ok";
    bridge.textContent = "已连接 MCP server";
  } else {
    dot.className = "dot warn";
    bridge.textContent = "未连接（等待 MCP server 启动）";
  }
  if (s.heartbeat) {
    const minAgo = Math.round((Date.now() - s.heartbeat.ts) / 60000);
    document.getElementById("hb").textContent = minAgo <= 15 ? "正常（" + minAgo + " 分钟前）" : "延迟（" + minAgo + " 分钟前）";
  } else {
    document.getElementById("hb").textContent = "-";
  }
});

function setUnknown() {
  document.getElementById("dot").className = "dot warn";
  document.getElementById("bridge").textContent = "后台未响应";
}
