// ui.js - UI helpers
export function bind(el, event, fn){ el?.addEventListener(event, fn); }
export function setText(el, text){ if (el) el.textContent = text; }
export function setEnabled(el, enabled){ if (el) el.disabled = !enabled; }

export function appendLog(container, msg){
  const tpl = document.getElementById('tpl-log-line');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.time').textContent = new Date().toLocaleTimeString() + ' ';
  node.querySelector('.msg').textContent = msg;
  container.appendChild(node);
  container.scrollTop = container.scrollHeight;
}

export function appendChat(container, who, text){
  const line = document.createElement('div');
  line.innerHTML = `<strong>${who}:</strong> ${escapeHtml(text)}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}
