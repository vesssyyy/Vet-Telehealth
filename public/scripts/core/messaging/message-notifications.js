// Unread messaging indicators: sidebar badge off messages.html; list/thread handled elsewhere.
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

// Show 1–9 or 9+ on nav Messages links from cumulative unread count.
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
        // Trust numeric zero from Firestore; timestamp heuristics caused badge flicker on multi-field updates.
        return 0;
    }
    if (timestampToMs(data.lastMessageAt) > timestampToMs(data[readField])) return 1;
    return 0;
}

// Subscribe to conversations for this user and drive the sidebar unread badge (no-op on messages.html).
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
