/**
 * Debug Panel для мониторинга Friends WebSocket и звонков
 */

class DebugPanel {
  constructor() {
    this.isVisible = false;
    this.friendsMessages = [];
    this.callLogs = [];
    this.maxMessages = 20;
    this.maxCallLogs = 50;
    this.updateInterval = null;
    
    this.initUI();
    this.startPeriodicUpdate();
  }

  initUI() {
    // Кнопки управления
    const btnToggleDebug = document.getElementById('btnToggleDebug');
    const btnClearDebugLogs = document.getElementById('btnClearDebugLogs');
    const btnTestFriendsWS = document.getElementById('btnTestFriendsWS');
    const btnGetCallState = document.getElementById('btnGetCallState');

    if (btnToggleDebug) {
      btnToggleDebug.addEventListener('click', () => this.toggleDebugPanel());
    }

    if (btnClearDebugLogs) {
      btnClearDebugLogs.addEventListener('click', () => this.clearLogs());
    }

    if (btnTestFriendsWS) {
      btnTestFriendsWS.addEventListener('click', () => this.testFriendsWS());
    }

    if (btnGetCallState) {
      btnGetCallState.addEventListener('click', () => this.logCallState());
    }

    // Показать панель дебага только если в звонке
    this.updateDebugPanelVisibility();
  }

  toggleDebugPanel() {
    this.isVisible = !this.isVisible;
    const debugContent = document.getElementById('debugContent');
    const btnToggleDebug = document.getElementById('btnToggleDebug');
    
    if (debugContent && btnToggleDebug) {
      debugContent.style.display = this.isVisible ? 'block' : 'none';
      btnToggleDebug.textContent = this.isVisible ? 'Скрыть Debug' : 'Показать Debug';
    }
  }

  updateDebugPanelVisibility() {
    const debugPanel = document.getElementById('debugPanel');
    const inCallSection = document.getElementById('inCallSection');
    
    if (debugPanel && inCallSection) {
      // Показываем панель дебага только в звонке
      const isInCall = inCallSection.style.display !== 'none';
      debugPanel.style.display = isInCall ? 'block' : 'none';
    }
  }

  // Логирование Friends WebSocket сообщений
  logFriendsMessage(type, data, direction = 'incoming') {
    const timestamp = new Date().toLocaleTimeString();
    const message = {
      timestamp,
      type,
      data,
      direction,
      raw: JSON.stringify(data, null, 2)
    };

    this.friendsMessages.unshift(message);
    if (this.friendsMessages.length > this.maxMessages) {
      this.friendsMessages = this.friendsMessages.slice(0, this.maxMessages);
    }

    this.updateFriendsMessagesUI();
  }

  // Логирование событий звонков
  logCallEvent(event, details) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = {
      timestamp,
      event,
      details,
      raw: typeof details === 'object' ? JSON.stringify(details, null, 2) : details
    };

    this.callLogs.unshift(logEntry);
    if (this.callLogs.length > this.maxCallLogs) {
      this.callLogs = this.callLogs.slice(0, this.maxCallLogs);
    }

    this.updateCallLogUI();
  }

  updateFriendsMessagesUI() {
    const container = document.getElementById('debugFriendsMessages');
    if (!container) return;

    container.innerHTML = '';
    
    this.friendsMessages.forEach(msg => {
      const div = document.createElement('div');
      div.className = `debug-msg ${msg.direction}`;
      
      const typeDisplay = msg.type || 'unknown';
      const preview = this.getMessagePreview(msg.data);
      
      div.innerHTML = `
        <span class="debug-timestamp">${msg.timestamp}</span>
        <strong>${msg.direction.toUpperCase()}</strong> ${typeDisplay}: ${preview}
      `;
      
      // Добавляем детали при клике
      div.addEventListener('click', () => {
        const details = div.querySelector('.debug-details');
        if (details) {
          details.remove();
        } else {
          const detailsDiv = document.createElement('div');
          detailsDiv.className = 'debug-details';
          detailsDiv.style.cssText = 'margin-top:4px; padding:4px; background:rgba(0,0,0,0.3); border-radius:3px; font-size:11px; word-break:break-all;';
          detailsDiv.textContent = msg.raw;
          div.appendChild(detailsDiv);
        }
      });
      
      container.appendChild(div);
    });

    container.scrollTop = 0;
  }

  updateCallLogUI() {
    const container = document.getElementById('debugCallLog');
    if (!container) return;

    container.innerHTML = '';
    
    this.callLogs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'debug-msg call-event';
      
      const detailsDisplay = typeof log.details === 'object' 
        ? JSON.stringify(log.details) 
        : String(log.details);
      
      div.innerHTML = `
        <span class="debug-timestamp">${log.timestamp}</span>
        <strong>${log.event}</strong>: ${detailsDisplay}
      `;
      
      container.appendChild(div);
    });

    container.scrollTop = 0;
  }

  getMessagePreview(data) {
    if (!data) return 'null';
    
    if (typeof data === 'string') {
      return data.length > 50 ? data.substring(0, 50) + '...' : data;
    }
    
    if (typeof data === 'object') {
      // Для call_invite показываем основные поля
      if (data.type === 'call_invite') {
        return `from=${data.from_user_id}, room=${data.room_id}`;
      }
      
      // Для других объектов - краткое описание
      const keys = Object.keys(data);
      if (keys.length === 0) return '{}';
      if (keys.length <= 3) {
        return keys.map(k => `${k}=${data[k]}`).join(', ');
      }
      return `{${keys.length} keys: ${keys.slice(0, 2).join(', ')}...}`;
    }
    
    return String(data);
  }

  // Обновление статистики
  startPeriodicUpdate() {
    this.updateInterval = setInterval(() => {
      this.updateStatusInfo();
      this.updateDebugPanelVisibility();
    }, 1000);
  }

  updateStatusInfo() {
    // Обновляем информацию о Friends WebSocket
    if (window.appState && window.appState.friendsWs) {
      const ws = window.appState.friendsWs;
      const state = ws.readyState;
      const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      
      this.updateElement('friendsWsState', stateNames[state] || 'UNKNOWN');
      this.updateElement('friendsWsMessageCount', window.appState.friendsWsMessageCount || '0');
      this.updateElement('friendsWsReconnects', window.appState.wsReconnectAttempts || '0');
      
      if (window.appState.lastFriendsMessage) {
        const lastMsg = window.appState.lastFriendsMessage;
        const preview = typeof lastMsg === 'object' ? JSON.stringify(lastMsg).substring(0, 30) + '...' : String(lastMsg);
        this.updateElement('friendsWsLastMessage', preview);
      }
    }

    // Обновляем информацию о звонке
    if (window.appState) {
      this.updateElement('callPhase', window.appState.callPhase || '-');
      this.updateElement('callType', window.appState.callType || '-');
      this.updateElement('callFriendId', window.appState.callFriendId || '-');
      this.updateElement('callRoomId', window.appState.callRoomId || '-');
    }
  }

  updateElement(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }

  clearLogs() {
    this.friendsMessages = [];
    this.callLogs = [];
    this.updateFriendsMessagesUI();
    this.updateCallLogUI();
    this.logCallEvent('DEBUG', 'Логи очищены');
  }

  testFriendsWS() {
    if (window.testFriendsWS) {
      window.testFriendsWS();
      this.logCallEvent('DEBUG', 'Тест Friends WebSocket отправлен');
    } else {
      this.logCallEvent('DEBUG', 'Функция testFriendsWS не доступна');
    }
  }

  logCallState() {
    if (window.getCallState) {
      const state = window.getCallState();
      this.logCallEvent('CALL_STATE', state);
    } else {
      this.logCallEvent('DEBUG', 'Функция getCallState не доступна');
    }
  }

  destroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
  }
}

// Экспорт для использования в других модулях
window.DebugPanel = DebugPanel;

// Глобальная переменная для доступа к панели дебага
window.debugPanel = null;

// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
  window.debugPanel = new DebugPanel();
});