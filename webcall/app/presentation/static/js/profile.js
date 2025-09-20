// Импорт API методов (исправлено: убран лишний сегмент js/ в пути)
import { getMe, updateProfile } from './api.js';

function setMsg(el, text, cls){
  el.textContent = text || '';
  el.className = 'inline-msg ' + (cls||'');
}

async function init(){
  const emailEl = document.getElementById('email');
  const usernameEl = document.getElementById('username');
  const profileMsg = document.getElementById('profileMsg');
  const formProfile = document.getElementById('formProfile');

  // Prefill
  try {
    const me = await getMe();
    emailEl.value = me.email || '';
    usernameEl.value = me.username || '';
  } catch (e){
    setMsg(profileMsg, 'Не удалось загрузить профиль', 'error');
  }

  formProfile.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    setMsg(profileMsg, 'Сохранение...', '');
    const email = emailEl.value.trim();
    const username = usernameEl.value.trim();
    if (!email && !username){
      setMsg(profileMsg, 'Укажите email и/или имя', 'error');
      return;
    }
    try {
      const updated = await updateProfile({ email, username });
      try {
        localStorage.setItem('wc_email', updated.email);
        localStorage.setItem('wc_username', updated.username);
      } catch {}
      setMsg(profileMsg, 'Сохранено', 'success');
    } catch (e){
      let msg = String(e);
      if (msg.includes('409')) msg = 'Email или имя уже занято';
      else if (msg.includes('400')) msg = 'Некорректные данные';
      else if (msg.startsWith('Error:')) msg = msg.slice(6);
      else if (msg.includes('401')) msg = 'Нужна авторизация';
      setMsg(profileMsg, msg, 'error');
    }
  });

}

init();
