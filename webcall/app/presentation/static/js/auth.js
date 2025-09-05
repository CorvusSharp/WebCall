// auth.js — регистрация/вход
import { login, register } from './api.js';

const els = {
  tabLogin: document.getElementById('tabLogin'),
  tabRegister: document.getElementById('tabRegister'),
  formLogin: document.getElementById('formLogin'),
  formRegister: document.getElementById('formRegister'),
  loginEmail: document.getElementById('loginEmail'),
  loginPassword: document.getElementById('loginPassword'),
  regEmail: document.getElementById('regEmail'),
  regUsername: document.getElementById('regUsername'),
  regPassword: document.getElementById('regPassword'),
  regSecret: document.getElementById('regSecret'),
  btnDoLogin: document.getElementById('btnDoLogin'),
  btnDoRegister: document.getElementById('btnDoRegister'),
  log: document.getElementById('authLog'),
};

function log(msg){
  const tpl = document.getElementById('tpl-log-line');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.time').textContent = new Date().toLocaleTimeString() + ' ';
  node.querySelector('.msg').textContent = msg;
  els.log.appendChild(node);
  els.log.scrollTop = els.log.scrollHeight;
}

function setTab(isLogin){
  els.tabLogin.classList.toggle('active', isLogin);
  els.tabRegister.classList.toggle('active', !isLogin);
  els.formLogin.style.display = isLogin ? '' : 'none';
  els.formRegister.style.display = isLogin ? 'none' : '';
}

function getRedirect(){
  const url = new URL(location.href);
  return url.searchParams.get('redirect') || '/call';
}

function applyPostLogin(token){
  localStorage.setItem('wc_token', token);
  localStorage.setItem('wc_seen', '1');
  try{ const payload = JSON.parse(atob(token.split('.')[1])); localStorage.setItem('wc_user', payload.sub || ''); }catch{}
  const url = new URL(location.href);
  const redirect = getRedirect();
  const room = url.searchParams.get('room');
  if (room) {
    // поддержим /call/{room}
    if (redirect.startsWith('/call')) {
      location.href = `/call/${encodeURIComponent(room)}`;
      return;
    }
  }
  location.href = redirect;
}

async function doLogin(){
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  try{
    const data = await login(email, password);
    applyPostLogin(data.access_token);
  }catch(e){ log(String(e)); }
}

async function doRegister(){
  const email = els.regEmail.value.trim();
  const username = els.regUsername.value.trim();
  const password = els.regPassword.value;
  const secret = (els.regSecret?.value || '').trim();
  try{
    await register(email, username, password, secret || undefined);
  try { localStorage.setItem('wc_username', username); } catch {}
    log('Регистрация успешна. Выполняем вход...');
    const data = await login(email, password);
    applyPostLogin(data.access_token);
  }catch(e){
    if (String(e).includes('invalid registration secret')) {
      log('Неверный секретный код.');
    } else {
      log(String(e));
    }
  }
}

// Инициализация
(function init(){
  const seen = localStorage.getItem('wc_seen') === '1';
  setTab(seen); // если уже были — показываем логин

  els.tabLogin.addEventListener('click', ()=> setTab(true));
  els.tabRegister.addEventListener('click', ()=> setTab(false));
  els.btnDoLogin.addEventListener('click', doLogin);
  els.btnDoRegister.addEventListener('click', doRegister);
})();
