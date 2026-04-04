/**
 * Televet Health — Message Notification System
 *
 * Context-aware unread message indicators with priority-based display:
 *   1. Active conversation thread (highest) — real-time messages, no indicators
 *   2. Conversation list — unread dot/bold on individual items
 *   3. Sidebar badge (lowest) — cumulative unread count on Messages link (1–9, then "9+")
 *
 * Only one notification level is visible per message at a time.
 * On the messages page the sidebar dot is suppressed (conversation-list
 * indicators are handled by messages-page-core.js instead).
 */
import { db } from '../firebase/firebase-config.js';
import { timestampToMs } from '../app/utils.js';
import {
    collection, query, where, orderBy, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

let _unsubscribe = null;
let _lastOpts = null;

function isOnMessagesPage() {
    return (window.location.pathname.split('/').pop() || '') === 'messages.html';
}

/** @param {number} total - raw cumulative unread count */
function setSidebarUnreadBadge(total) {
    var n = typeof total === 'number' && total > 0 ? Math.floor(total) : 0;
    var label = n === 0 ? '' : (n > 9 ? '9+' : String(n));
    var visible = n > 0;
    document.querySelectorAll('.nav-unread-dot, .bottom-nav-unread-dot').forEach(function (el) {
        el.classList.toggle('is-visible', visible);
        el.textContent = label;
        if (visible) {
            el.setAttribute('aria-label', n + ' unread message' + (n === 1 ? '' : 's'));
            el.removeAttribute('aria-hidden');
        } else {
            el.removeAttribute('aria-label');
            el.setAttribute('aria-hidden', 'true');
        }
    });
}

function unreadCountForConversation(data, readField, unreadCountField) {
    var c = data[unreadCountField];
    if (typeof c === 'number' && !Number.isNaN(c)) {
        if (c > 0) return Math.floor(c);
        /* Explicit zero from Firestore: trust it. Timestamp fallback fights counter updates
           and causes sidebar badge flicker during deployment / multi-field writes. */
        return 0;
    }
    if (timestampToMs(data.lastMessageAt) > timestampToMs(data[readField])) return 1;
    return 0;
}

/**
 * Start listening for unread conversations and toggle the sidebar red dot.
 * Skips the Firestore subscription on the messages page (the messaging
 * module already owns the conversation query there).
 *
 * @param {{ role: 'petowner'|'vet', uid: string }} opts
 */
export function initMessageNotifications({ role, uid }) {
    _lastOpts = { role: role, uid: uid };
    _applyNotifications();
}

function _applyNotifications() {
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }

    if (!_lastOpts) return;
    var role = _lastOpts.role;
    var uid  = _lastOpts.uid;

    if (isOnMessagesPage()) {
        setSidebarUnreadBadge(0);
        return;
    }

    var roleField = role === 'vet' ? 'vetId' : 'ownerId';
    var readField = role === 'vet' ? 'lastReadAt_vetId' : 'lastReadAt_ownerId';
    var unreadCountField = role === 'vet' ? 'unreadCount_vet' : 'unreadCount_owner';

    _unsubscribe = onSnapshot(
        query(
            collection(db, 'conversations'),
            where(roleField, '==', uid),
            orderBy('lastMessageAt', 'desc')
        ),
        function (snap) {
            var total = 0;
            snap.docs.forEach(function (d) {
                total += unreadCountForConversation(d.data(), readField, unreadCountField);
            });
            setSidebarUnreadBadge(total);
        },
        function (err) { console.warn('[MessageNotifications]', err); }
    );
}

export function destroyMessageNotifications() {
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    _lastOpts = null;
    setSidebarUnreadBadge(0);
}

window.addEventListener('spa:afternavigate', function () {
    _applyNotifications();
});
