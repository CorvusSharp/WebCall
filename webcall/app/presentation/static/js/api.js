// api.js — API glue
const base = "";

export async function getIceServers(){
  const r = await fetch(`${base}/api/ice`, { credentials: 'include' });
  if (!r.ok) throw new Error(`ICE ${r.status}`);
  return await r.json(); // { iceServers: [...] }
}

export function buildWs(roomId, token){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${proto}://${location.host}/ws`);
  url.searchParams.set('room', roomId);
  if (token) url.searchParams.set('token', token);
  return new WebSocket(url.toString());
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
