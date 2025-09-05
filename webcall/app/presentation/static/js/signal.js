// signal.js — signaling helpers

function isWsOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function _safeSend(ws, obj) {
  if (!isWsOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("WS send failed:", e);
    return false;
  }
}

/**
 * Отправка сигнального сообщения
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

/**
 * Чат
 * @param {WebSocket} ws
 * @param {string} content
 * @param {string} fromUserId
 */
export function sendChat(ws, content, fromUserId) {
  _safeSend(ws, { type: "chat", content, fromUserId });
}

export { isWsOpen };
