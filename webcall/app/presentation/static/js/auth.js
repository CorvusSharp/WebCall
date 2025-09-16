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

function clearFieldErrors(){
  [els.regEmail, els.regUsername, els.regPassword, els.regSecret, els.loginEmail, els.loginPassword].forEach(i=>{
    if (!i) return;
    i.classList.remove('input-error');
  });
}

function fieldError(el, msg){
  if (el) el.classList.add('input-error');
  log(msg);
}

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
  // Email может понадобиться для спец-логики в UI
  try { const email = (document.getElementById('loginEmail')?.value || '').trim(); if (email) localStorage.setItem('wc_email', email); } catch {}
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
  clearFieldErrors();
  const email = (els.loginEmail.value || '').trim();
  const password = els.loginPassword.value || '';
  if (!email) return fieldError(els.loginEmail, 'Укажите email.');
  if (!password) return fieldError(els.loginPassword, 'Введите пароль.');

  // Disable buttons while request is running
  els.btnDoLogin.disabled = true;
  try{
    const data = await login(email, password);
    applyPostLogin(data.access_token);
  }catch(e){
    // e may be an Error with message body or a thrown object; normalize to string
    let raw = '';
    try { raw = typeof e === 'string' ? e : (e?.message || JSON.stringify(e)); } catch { raw = String(e); }
    // Try parse JSON body
    try{
      if (raw && raw.trim().startsWith('{')){
        const j = JSON.parse(raw);
        if (j.detail && typeof j.detail === 'string') raw = j.detail;
      }
    }catch{}

    // Map known server messages to field-level errors
    if (/Неверный email или пароль/i.test(raw) || /invalid credentials/i.test(raw)){
      fieldError(els.loginEmail, 'Неверный email или пароль.');
      fieldError(els.loginPassword, 'Неверный email или пароль.');
    } else {
      // Fallback: show raw message in log for debugging
      log(raw || 'Ошибка при входе');
    }
  }finally{
    els.btnDoLogin.disabled = false;
  }
}

async function doRegister(){
  clearFieldErrors();
  const email = els.regEmail.value.trim();
  const username = els.regUsername.value.trim();
  const password = els.regPassword.value;
  const secret = (els.regSecret?.value || '').trim();

  // Клиентская валидация
  if (!email) return fieldError(els.regEmail, 'Укажите email.');
  // Простая email-проверка
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fieldError(els.regEmail, 'Некорректный email.');
  if (!username) return fieldError(els.regUsername, 'Укажите имя пользователя.');
  if (username.length < 3) return fieldError(els.regUsername, 'Имя пользователя слишком короткое (мин 3).');
  if (!password) return fieldError(els.regPassword, 'Введите пароль.');
  if (password.length < 6) return fieldError(els.regPassword, 'Пароль слишком короткий (мин 6).');
  if (!secret) return fieldError(els.regSecret, 'Введите секретный код.');

  log('Отправка запроса регистрации...');
  try{
    await register(email, username, password, secret);
  try { localStorage.setItem('wc_username', username); } catch {}
  try { localStorage.setItem('wc_email', email); } catch {}
    log('Регистрация успешна. Выполняем вход...');
    const data = await login(email, password);
    applyPostLogin(data.access_token);
  }catch(e){
    // Парсим возможный JSON от сервера
    let raw = String(e);
    try {
      if (raw.startsWith('{')) {
        const j = JSON.parse(raw);
        if (j.detail) {
          if (Array.isArray(j.detail)) {
            j.detail.forEach(d => log(`Ошибка: ${d.loc?.slice(-1)[0]||''} - ${d.msg}`));
            return;
          } else if (typeof j.detail === 'string') {
            raw = j.detail;
          }
        }
      }
    } catch {}
    if (/invalid registration secret/i.test(raw)) {
      fieldError(els.regSecret, 'Неверный секретный код.');
    } else if (/username/i.test(raw) && /exists|already/i.test(raw)) {
      fieldError(els.regUsername, 'Имя уже занято.');
    } else if (/email/i.test(raw) && /exists|already/i.test(raw)) {
      fieldError(els.regEmail, 'Email уже зарегистрирован.');
    } else {
      log(raw);
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
