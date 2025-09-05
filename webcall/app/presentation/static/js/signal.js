// signal.js - signaling helpers
export function sendSignal(ws, type, payload, fromUserId, targetUserId) {
  const body = { type: 'signal', signalType: type, fromUserId, ...payload };
  if (targetUserId) body.targetUserId = targetUserId;
  ws?.send(JSON.stringify(body));
}

export function sendChat(ws, content, fromUserId) {
  ws?.send(JSON.stringify({ type: 'chat', content, fromUserId }));
}
