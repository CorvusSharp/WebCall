// Global test setup for Vitest
// Provide minimal DOM elements & stubs that modules expect.

function ensure(id){
  if (!document.getElementById(id)){
    const el = document.createElement(id === 'directMessages' ? 'div':'div');
    el.id = id;
    document.body.appendChild(el);
  }
}

[
  'permBanner','visitedRooms','directMessages','directChatTitle','directChatCard','directInput','btnDirectSend',
  'friendsList','friendRequests','friendSearchResults','friendSearch','btnFriendSearch','callContext','roomId','logs','peersGrid','stats'
].forEach(ensure);

// Basic stubs for browser APIs not present in jsdom or needing control
if (!globalThis.Notification){
  class FakeNotification { static permission = 'granted'; }
  // @ts-ignore
  globalThis.Notification = FakeNotification;
}

if (!navigator.mediaDevices){
  // @ts-ignore
  navigator.mediaDevices = { getUserMedia: async ()=>({}) };
}

if (!navigator.permissions){
  // @ts-ignore
  navigator.permissions = { query: async ()=>({ state:'granted' }) };
}

// Переопределяем fetch всегда, чтобы обрабатывать относительные URL без ошибки URL parsing в Node
// @ts-ignore
globalThis.fetch = async (url, opts)=>{
  // эмулируем минимальный Response
  return {
    ok: true,
    status: 200,
    url: typeof url === 'string' ? url : String(url),
    json: async ()=> ({ key: null }),
    text: async ()=> '',
  };
};

if (!globalThis.indexedDB){
  // Provide minimal fake indexedDB so e2ee module does not crash.
  const store = new Map();
  // @ts-ignore
  globalThis.indexedDB = {
    open(name){
      const req = { result: null, onsuccess:null, onerror:null, onupgradeneeded:null };
      setTimeout(()=>{
        const db = {
          createObjectStore(){ return {}; },
          transaction(){ return { objectStore(){ return { get(key){ const r={}; setTimeout(()=>{ r.result = store.get(key); r.onsuccess && r.onsuccess(); },0); return r; }, put(val,key){ store.set(key,val); }, }; }, oncomplete:null, onerror:null }; }, close(){} };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      },0);
      return req;
    }
  };
}

// Crypto subtle already exists in Node 18+, ensure getRandomValues
if (!globalThis.crypto?.getRandomValues){
  // @ts-ignore
  globalThis.crypto.getRandomValues = (arr)=>{
    for (let i=0;i<arr.length;i++) arr[i] = Math.floor(Math.random()*256);
    return arr;
  };
}

// localStorage polyfill for tests
if (!globalThis.localStorage){
  const mem = new Map();
  // @ts-ignore
  globalThis.localStorage = {
    getItem:k=> mem.has(k)? mem.get(k):null,
    setItem:(k,v)=>{ mem.set(k,String(v)); },
    removeItem:k=>{ mem.delete(k); },
    clear:()=> mem.clear(),
  };
}

// Stub for serviceWorker & Push related API
if (!navigator.serviceWorker){
  // @ts-ignore
  navigator.serviceWorker = {
    async getRegistration(){ return null; },
    async register(){ return { pushManager: { getSubscription: async ()=>null, subscribe: async ()=>({ endpoint:'https://x', toJSON:()=>({ keys:{ p256dh:'k', auth:'a'} }) }) } }; }
  };
}

if (!('PushManager' in globalThis)){
  // @ts-ignore
  globalThis.PushManager = function(){};
}

// Minimal stub for Audio for ringtone logic (prevent real playback attempts)
if (!globalThis.Audio){
  // @ts-ignore
  globalThis.Audio = class FakeAudio {
    constructor(src){ this.src=src; this.loop=false; this.readyState=1; this.currentTime=0; }
    load(){}
    play(){ return Promise.resolve(); }
    pause(){}
    addEventListener(ev, fn, opts){ if (ev==='loadedmetadata') setTimeout(fn,0); }
    removeEventListener(){}
    setAttribute(){}
    removeAttribute(){}
  };
}

// Expose helper to flush pending microtasks if needed
export async function tick(){ return Promise.resolve(); }
