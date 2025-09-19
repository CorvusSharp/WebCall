// modules/e2ee.js
// Изоляция клиентского E2EE слоя (ECDH P-256 + AES-GCM)
// Публичные функции: ensureE2EEKeys, encryptForFriend, decryptFromFriend, tryDecryptVisibleMessages

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let _keypair = null;          // CryptoKeyPair
let _exportedPub = null;      // base64 raw public key
let _ensuring = null;         // concurrency guard

// --- IndexedDB helpers ---
function idbPut(dbName, storeName, key, value){
  return new Promise((resolve,reject)=>{
    try{
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = ()=>{ req.result.createObjectStore(storeName); };
      req.onsuccess = ()=>{
        const db = req.result;
        const tx = db.transaction(storeName, 'readwrite');
        const os = tx.objectStore(storeName);
        os.put(value, key);
        tx.oncomplete = ()=>{ db.close(); resolve(); };
        tx.onerror = (e)=>{ db.close(); reject(e); };
      };
      req.onerror = (e)=> reject(e);
    }catch(e){ reject(e); }
  });
}
function idbGet(dbName, storeName, key){
  return new Promise((resolve,reject)=>{
    try{
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = ()=>{ req.result.createObjectStore(storeName); };
      req.onsuccess = ()=>{
        const db = req.result;
        const tx = db.transaction(storeName, 'readonly');
        const os = tx.objectStore(storeName);
        const g = os.get(key);
        g.onsuccess = ()=>{ db.close(); resolve(g.result); };
        g.onerror = ()=>{ db.close(); resolve(null); };
      };
      req.onerror = (e)=> reject(e);
    }catch(e){ reject(e); }
  });
}
async function saveKeypair(privatePk8B64, publicRawB64){
  try{ await idbPut('wc_keys', 'keys', 'e2ee', { priv: privatePk8B64, pub: publicRawB64 }); return; }catch{}
  try{ localStorage.setItem('wc_e2ee_priv', privatePk8B64); localStorage.setItem('wc_e2ee_pub', publicRawB64); }catch{}
}
async function loadKeypair(){
  try{ const v = await idbGet('wc_keys','keys','e2ee'); if (v) return v; }catch{}
  try{
    const priv = localStorage.getItem('wc_e2ee_priv');
    const pub  = localStorage.getItem('wc_e2ee_pub');
    if (priv && pub) return { priv, pub };
  }catch{}
  return null;
}

export async function ensureE2EEKeys(){
  if (_keypair) return _keypair;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    try {
      const stored = await loadKeypair();
      if (stored && stored.priv && stored.pub){
        try {
          const rawPub = Uint8Array.from(atob(stored.pub), c=>c.charCodeAt(0)).buffer;
          const priv = Uint8Array.from(atob(stored.priv), c=>c.charCodeAt(0)).buffer;
          const publicKey = await crypto.subtle.importKey('raw', rawPub, { name:'ECDH', namedCurve:'P-256' }, true, []);
          const privateKey = await crypto.subtle.importKey('pkcs8', priv, { name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey']);
          _keypair = { publicKey, privateKey }; _exportedPub = stored.pub;
          publishMyPublicKey(_exportedPub).catch(()=>{});
          return _keypair;
        }catch{ /* regenerate */ }
      }
      _keypair = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey']);
      const raw = await crypto.subtle.exportKey('raw', _keypair.publicKey);
      _exportedPub = btoa(String.fromCharCode(...new Uint8Array(raw)));
      try {
        const pkcs8 = await crypto.subtle.exportKey('pkcs8', _keypair.privateKey);
        const pkcs8b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
        await saveKeypair(pkcs8b64, _exportedPub);
      }catch{}
      try { await publishMyPublicKey(_exportedPub); } catch {}
      return _keypair;
    } finally { _ensuring = null; }
  })();
  return _ensuring;
}

async function publishMyPublicKey(base64){
  try {
    const mod = await import('../api.js');
    if (mod && typeof mod.setMyPublicKey === 'function') {
      await mod.setMyPublicKey(base64);
    }
  } catch {}
}

async function importPeerPublicKey(base64){
  try {
    const raw = Uint8Array.from(atob(base64), c=>c.charCodeAt(0)).buffer;
    return await crypto.subtle.importKey('raw', raw, { name:'ECDH', namedCurve:'P-256' }, true, []);
  } catch { return null; }
}
async function deriveSharedKey(peerPubKey){
  try {
    return await crypto.subtle.deriveKey({ name:'ECDH', public: peerPubKey }, _keypair.privateKey, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
  } catch { return null; }
}
async function aesGcmEncrypt(key, plaintext){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, textEncoder.encode(plaintext));
  const buf = new Uint8Array(iv.byteLength + ct.byteLength);
  buf.set(iv,0); buf.set(new Uint8Array(ct), iv.byteLength);
  return btoa(String.fromCharCode(...buf));
}
async function aesGcmDecrypt(key, b64){
  try {
    const raw = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    const iv = raw.slice(0,12);
    const ct = raw.slice(12).buffer;
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
    return textDecoder.decode(plain);
  } catch { return null; }
}

async function fetchPeerPublic(friendId){
  const mod = await import('../api.js');
  if (mod && typeof mod.getUserPublicKey === 'function') {
    return await mod.getUserPublicKey(friendId);
  }
  return null;
}

export async function encryptForFriend(friendId, plaintext){
  try {
    await ensureE2EEKeys();
    const pkResp = await fetchPeerPublic(friendId);
    const pub = pkResp && pkResp.public_key;
    if (!pub) throw new Error('no peer pk');
    const peerKey = await importPeerPublicKey(pub); if (!peerKey) throw new Error('bad pk');
    const shared = await deriveSharedKey(peerKey); if (!shared) throw new Error('derive failed');
    return await aesGcmEncrypt(shared, plaintext);
  } catch (e){ console.error('encryptForFriend failed', e); return null; }
}

export async function decryptFromFriend(friendId, b64cipher){
  try {
    await ensureE2EEKeys();
    const pkResp = await fetchPeerPublic(friendId);
    const pub = pkResp && pkResp.public_key; if (!pub) return null;
    const peerKey = await importPeerPublicKey(pub); if (!peerKey) return null;
    const shared = await deriveSharedKey(peerKey); if (!shared) return null;
    return await aesGcmDecrypt(shared, b64cipher);
  } catch (e){ console.error('decryptFromFriend failed', e); return null; }
}

export async function tryDecryptVisibleMessages(friendId, container){
  if (!friendId || !container) return;
  try {
    const lines = Array.from(container.querySelectorAll('.chat-line'));
    for (const line of lines){
      try {
        const msgEl = line.querySelector('.msg'); if (!msgEl) continue;
        const currentText = msgEl.textContent || '';
        if (/^[A-Za-z0-9+/=\-_.]+$/.test(currentText) && currentText.length > 16){
          const dec = await decryptFromFriend(friendId, currentText);
            if (dec) msgEl.textContent = dec;
        }
      } catch {}
    }
  } catch {}
}

// Автоматически генерируем ключи (best effort)
ensureE2EEKeys().catch(()=>{});
