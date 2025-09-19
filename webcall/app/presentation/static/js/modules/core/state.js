// @ts-check
// core/state.js
// Глобальное состояние приложения (раньше было в main.js). Никакой DOM-логики.

/** @typedef {Object} SpecialInviteState
 *  @property {HTMLAudioElement|null} ringtone
 *  @property {number|null} timer
 *  @property {boolean} active
 *  @property {boolean} playing
 *  @property {Promise<any>|null} readyPromise
 *  @property {number} session
 */

/** @typedef {Object} ActiveCallState
 *  @property {string} roomId
 *  @property {string} withUserId
 *  @property {string=} username
 *  @property {'incoming'|'outgoing'} direction
 *  @property {'invited'|'accepted'|'declined'} status
 */

/** @typedef {Object} AppState
 *  @property {string|null} token
 *  @property {WebSocket|null} ws
 *  @property {import('../../webrtc.js').WebRTCManager|null} rtc
 *  @property {string|null} userId
 *  @property {string|null} accountId
 *  @property {number|null} reconnectTimeout
 *  @property {boolean} isManuallyDisconnected
 *  @property {number|null} pingTimer
 *  @property {boolean} isReconnecting
 *  @property {{ mic: string|null, cam: string|null, spk: string|null }} selected
 *  @property {boolean} audioUnlocked
 *  @property {AudioContext|null} globalAudioCtx
 *  @property {boolean} audioGestureAllowed
 *  @property {Record<string,string>} latestUserNames
 *  @property {WebSocket|null} friendsWs
 *  @property {boolean} friendsWsConnecting
 *  @property {number} wsReconnectAttempts
 *  @property {string|null} currentDirectFriend
 *  @property {Map<string,number>} recentOffer
 *  @property {number|null} peerCleanupIntervalId
 *  @property {Map<string,number>} directSeenByFriend
 *  @property {Map<string,number>} directUnread
 *  @property {SpecialInviteState} special
 *  @property {boolean} userGestureHappened
 *  @property {Array<Function>} pendingAutoplayTasks
 *  @property {ActiveCallState|null} activeCall
 *  @property {Map<string, any>} pendingIncomingInvites
 */

/** @type {AppState} */
export const appState = {
  token: null,
  ws: null,
  // Добавлены JSDoc типы для облегчения навигации/перехода на TS.

  rtc: null,
  userId: null,          // stable connId (session scope)
  accountId: null,       // account (JWT sub)
  reconnectTimeout: null,
  isManuallyDisconnected: false,
  pingTimer: null,
  isReconnecting: false,
  selected: { mic: null, cam: null, spk: null },
  audioUnlocked: false,
  globalAudioCtx: null,
  audioGestureAllowed: false,
  latestUserNames: {},
  friendsWs: null,
  friendsWsConnecting: false,
  wsReconnectAttempts: 0,
  currentDirectFriend: null,
  recentOffer: new Map(),
  peerCleanupIntervalId: null,
  directSeenByFriend: new Map(),
  directUnread: new Map(),
  // Ringtone / special invite state
  special: {
    ringtone: null,
    timer: null,
    active: false,
    playing: false,
    readyPromise: null,
    session: 0,
  },
  userGestureHappened: false,
  pendingAutoplayTasks: [],
  // Call state
  activeCall: null, // { roomId, withUserId, direction, status }
  pendingIncomingInvites: new Map(),
};

export function resetTransient(){
  appState.recentOffer.clear();
  appState.pendingIncomingInvites.clear();
}
