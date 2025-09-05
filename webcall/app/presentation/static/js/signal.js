// signal.js — WebSocket helpers
function isWsOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function _safeSend(ws, obj, maxRetries = 3) {
  if (!isWsOpen(ws)) {
    if (maxRetries > 0) setTimeout(() => _safeSend(ws, obj, maxRetries - 1), 300);
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn("WS send failed:", e);
    if (maxRetries > 0) setTimeout(() => _safeSend(ws, obj, maxRetries - 1), 300);
    return false;
  }
}

/**
 * @param {WebSocket} ws
 * @param {"offer"|"answer"|"ice-candidate"} type
 * @param {object} payload - { sdp } или { candidate }
 * @param {string} fromUserId
 * @param {string=} targetUserId
 */
export function sendSignal(ws, type, payload, fromUserId, targetUserId) {
  const body = { type: "signal", signalType: type, fromUserId, ...payload };
  if (targetUserId) body.targetUserId = targetUserId;
  _safeSend(ws, body);
}

export function sendChat(ws, content, fromUserId) {
  _safeSend(ws, { type: "chat", content, fromUserId });
}

export { isWsOpen };
