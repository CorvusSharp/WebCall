import { changePassword } from './api.js';

function setMsg(el, text, cls){
  el.textContent = text || '';
  el.className = 'inline-msg ' + (cls||'');
}

async function init(){
  const form = document.getElementById('formPassword');
  const msg = document.getElementById('pwdMsg');
  const oldEl = document.getElementById('old_password');
  const newEl = document.getElementById('new_password');
  const new2El = document.getElementById('new_password2');

  form.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    setMsg(msg, 'Обновление...', '');
    const oldPwd = oldEl.value.trim();
    const newPwd = newEl.value.trim();
    const new2Pwd = new2El.value.trim();

    if (!oldPwd || !newPwd || !new2Pwd){
      setMsg(msg, 'Заполните все поля', 'error');
      return;
    }
    if (newPwd !== new2Pwd){
      setMsg(msg, 'Новые пароли не совпадают', 'error');
      return;
    }
    if (newPwd.length < 6){
      setMsg(msg, 'Минимум 6 символов', 'error');
      return;
    }
    try {
      await changePassword(oldPwd, newPwd);
      setMsg(msg, 'Пароль изменён', 'success');
      oldEl.value=''; newEl.value=''; new2El.value='';
    } catch(e){
      let m = String(e);
      if (m.includes('400')) m = 'Старый пароль неверен или новый некорректен';
      else if (m.startsWith('Error:')) m = m.slice(6);
      setMsg(msg, m, 'error');
    }
  });
}

init();
