// api.js - REST helpers
const base = '';

let iceServersCache = null;
let lastIceFetchTime = 0;
const ICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export async function getIceServers() {
  // Return cached version if available and not expired
  if (iceServersCache && Date.now() - lastIceFetchTime < ICE_CACHE_DURATION) {
    return iceServersCache;
  }
  
  try {
    const res = await fetch(`${base}/api/v1/webrtc/ice-servers`);
    if (!res.ok) throw new Error('Failed to fetch ICE servers');
    iceServersCache = await res.json();
    lastIceFetchTime = Date.now();
    return iceServersCache;
  } catch (e) {
    console.warn('Using fallback ICE servers');
    // Fallback to reliable STUN servers
    return {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" }
      ]
    };
  }
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