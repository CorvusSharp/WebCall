// core/message_contracts.js
// Типовые структуры сообщений WebSocket (JSDoc) для документации и навигации.

/**
 * @typedef {Object} WsChatMessage
 * @property {'chat'} type
 * @property {string} content
 * @property {string} [fromUserId]
 * @property {string} [authorId]
 * @property {string} [authorName]
 */

/**
 * @typedef {Object} WsPresenceMessage
 * @property {'presence'} type
 * @property {string[]} users
 * @property {Record<string,string>} userNames
 */

/**
 * @typedef {Object} WsSignalEnvelope
 * @property {'signal'} type
 * @property {string} fromUserId
 * @property {string} targetUserId
 * @property {'offer'|'answer'|'ice-candidate'|'ice_candidate'} signalType
 * @property {string} [sdp]
 * @property {RTCIceCandidateInit} [candidate]
 */

/**
 * @typedef {Object} FriendDirectMessage
 * @property {'direct_message'} type
 * @property {string} id
 * @property {string} fromUserId
 * @property {string} toUserId
 * @property {string} [fromUsername]
 * @property {string} [toUsername]
 * @property {string} ciphertext
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} FriendCallInvite
 * @property {'call_invite'} type
 * @property {string} roomId
 * @property {string} fromUserId
 * @property {string} toUserId
 * @property {string} [fromUsername]
 * @property {string} [toUsername]
 */

/**
 * @typedef {Object} FriendCallAccept
 * @property {'call_accept'} type
 * @property {string} roomId
 */

/**
 * @typedef {Object} FriendCallDecline
 * @property {'call_decline'|'call_cancel'} type
 * @property {string} roomId
 */

/**
 * @typedef {(
 *  WsChatMessage | WsPresenceMessage | WsSignalEnvelope |
 *  FriendDirectMessage | FriendCallInvite | FriendCallAccept | FriendCallDecline
 * )} AnyInboundMessage
 */

export {}; // только типы
