// api.js — API glue (исправлено: верный путь ICE, верный путь WS)
const base = "";

/** Получаем ICE (STUN/TURN) с вашего API */
export async function getIceServers(){
  // ваш сервер, судя по логам, обслуживает ICE тут:
  // GET /api/v1/webrtc/ice-servers  -> { iceServers:[...] }
  const r = await fetch(`${base}/api/v1/webrtc/ice-servers`, { credentials: 'include' });
  if (!r.ok) throw new Error(`ICE ${r.status}`);
  const json = await r.json();
  // Небольшой sanity-check
  if (!json || !Array.isArray(json.iceServers)) {
    throw new Error("Invalid ICE response");
  }
  return json;
}

/**
 * Открываем WS на корректный серверный путь
 * Сервер логировал: "WebSocket /ws/rooms/{room}?token=..."
 */
export function buildWs(roomId, token){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Основной путь — /ws/rooms/{room}
  const url1 = new URL(`${proto}://${location.host}/ws/rooms/${encodeURIComponent(roomId)}`);
  if (token) url1.searchParams.set('token', token);

  const ws = new WebSocket(url1.toString());
  // Для удобной диагностики
  try { ws.__debug_url = url1.toString(); } catch {}
  return ws;
}

// (опционально) login/register, если используются страницы аутентификации
export async function login(email, password){
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ email, password })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
export async function register(email, username, password){
  const r = await fetch(`${base}/api/register`, {
    method: 'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ email, username, password })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
