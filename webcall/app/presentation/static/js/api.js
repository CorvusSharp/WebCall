// api.js - REST helpers
const base = '';

export async function getIceServers() {
  const res = await fetch(`${base}/api/v1/webrtc/ice-servers`);
  if (!res.ok) throw new Error('Failed to fetch ICE servers');
  return res.json();
}

export async function login(email, password) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`Login failed: ${res.status} ${text}`);
  }
  return res.json(); // { access_token }
}

export async function register(email, username, password) {
  const res = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`Register failed: ${res.status} ${text}`);
  }
  return res.json(); // { id, email, username }
}

export function buildWs(roomId, token) {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qp = token ? `?token=${encodeURIComponent(token)}` : '';
  return new WebSocket(`${wsProto}://${location.host}/ws/rooms/${encodeURIComponent(roomId)}${qp}`);
}
