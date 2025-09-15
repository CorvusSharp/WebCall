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
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ email, password })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
export async function register(email, username, password, secret){
  const payload = { email, username, password, secret };
  const r = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

function authHeaders(){
  const t = localStorage.getItem('wc_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Friends
export async function listFriends(){
  const r = await fetch(`${base}/api/v1/friends/`, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function listFriendRequests(){
  const r = await fetch(`${base}/api/v1/friends/requests`, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function sendFriendRequest(userId){
  const r = await fetch(`${base}/api/v1/friends/request`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ user_id: userId })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function acceptFriend(userId){
  const r = await fetch(`${base}/api/v1/friends/${encodeURIComponent(userId)}/accept`, {
    method: 'POST', headers: { ...authHeaders() }
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

// Push
export async function subscribePush(subscription){
  const r = await fetch(`${base}/api/v1/push/subscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(subscription)
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function notifyCall(toUserId, roomId){
  const r = await fetch(`${base}/api/v1/push/notify-call`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ to_user_id: toUserId, room_id: roomId })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function acceptCall(otherUserId, roomId){
  const r = await fetch(`${base}/api/v1/push/call/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ other_user_id: otherUserId, room_id: roomId })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function declineCall(otherUserId, roomId){
  const r = await fetch(`${base}/api/v1/push/call/decline`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ other_user_id: otherUserId, room_id: roomId })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function findUsers(q){
  const r = await fetch(`${base}/api/v1/users/find?` + new URLSearchParams({ q }), { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

// Auth: текущий пользователь
export async function getMe(){
  const r = await fetch(`${base}/api/v1/auth/me`, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
