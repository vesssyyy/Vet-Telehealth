import { auth, db } from '../firebase/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    query,
    serverTimestamp,
    updateDoc,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/** @see firestore.rules — vet booking alert lives on the appointment doc. */
const APPOINTMENTS_COLLECTION = 'appointments';

function safeInt(n, fallback = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.floor(x) : fallback;
}

function formatBadgeCount(n) {
    const x = safeInt(n, 0);
    if (x <= 0) return '';
    return x > 9 ? '9+' : String(x);
}

function emitUnreadCount(unreadCount) {
    try {
        const raw = safeInt(unreadCount, 0);
        window.localStorage?.setItem('televet_appointments_unread', String(raw));
    } catch (_) {}
    try {
        window.dispatchEvent(new CustomEvent('telehealth:appointments:unread', {
            detail: { unreadCount: safeInt(unreadCount, 0) },
        }));
    } catch (_) {}
}

function appointmentDocsToUnreadState(docs) {
    const byAppointmentId = new Map();
    let unreadCount = 0;
    for (const d of docs) {
        const data = d?.data ? d.data() : (d || {});
        const appointmentId = d?.id ? String(d.id).trim() : '';
        if (!appointmentId) continue;
        if (data.vetBookingAlertUnread !== true) continue;
        unreadCount++;
        byAppointmentId.set(appointmentId, (byAppointmentId.get(appointmentId) || 0) + 1);
    }
    return {
        unreadCount,
        byAppointmentId,
    };
}

/**
 * Subscribe to unread vet booking alerts (stored on appointment documents).
 * Emits window event `telehealth:appointments:unread` and stores local cache in localStorage.
 *
 * @param {(state: { unreadCount: number, byAppointmentId: Map<string, number> }) => void} [onChange]
 * @returns {() => void}
 */
export function subscribeVetAppointmentNotifications(onChange) {
    let unsub = null;
    let active = true;

    const stop = () => {
        active = false;
        if (typeof unsub === 'function') {
            unsub();
            unsub = null;
        }
    };

    const startForUser = (user) => {
        if (!user?.uid) {
            emitUnreadCount(0);
            onChange?.({ unreadCount: 0, byAppointmentId: new Map() });
            return;
        }
        if (typeof unsub === 'function') unsub();
        // Single-field query (no composite index); derive unread via vetBookingAlertUnread on each doc.
        const q = query(collection(db, APPOINTMENTS_COLLECTION), where('vetId', '==', user.uid));
        unsub = onSnapshot(q, (snap) => {
            if (!active) return;
            const state = appointmentDocsToUnreadState(snap.docs || []);
            emitUnreadCount(state.unreadCount);
            onChange?.(state);
        }, () => {
            if (!active) return;
            emitUnreadCount(0);
            onChange?.({ unreadCount: 0, byAppointmentId: new Map() });
        });
    };

    const authUnsub = onAuthStateChanged(auth, (user) => startForUser(user));
    return () => {
        stop();
        authUnsub?.();
    };
}

/**
 * Mark the vet booking alert as seen for this appointment (current vet only).
 * @param {string} appointmentId
 */
export async function markAppointmentNotificationsSeen(appointmentId) {
    const user = auth.currentUser;
    const aptId = String(appointmentId || '').trim();
    if (!user?.uid || !aptId) return;

    const aptRef = doc(db, APPOINTMENTS_COLLECTION, aptId);
    const snap = await getDoc(aptRef);
    if (!snap.exists()) return;
    const data = snap.data();
    if (String(data?.vetId || '') !== user.uid) return;
    if (data?.vetBookingAlertUnread !== true) return;

    await updateDoc(aptRef, {
        vetBookingAlertUnread: false,
        vetBookingAlertSeenAt: serverTimestamp(),
        vetBookingAlertSeenBy: user.uid,
        updatedAt: serverTimestamp(),
    });
}

export { formatBadgeCount };
