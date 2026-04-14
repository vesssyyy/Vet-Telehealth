import { auth, db } from '../firebase/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    addDoc,
    collection,
    doc,
    getDocs,
    onSnapshot,
    query,
    serverTimestamp,
    updateDoc,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const NOTIFICATIONS_COLLECTION = 'appointmentNotifications';

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

function docsToState(docs) {
    const byAppointmentId = new Map();
    let unreadCount = 0;
    for (const d of docs) {
        const data = d?.data ? d.data() : (d || {});
        const appointmentId = String(data.appointmentId || '').trim();
        if (!appointmentId) continue;
        // Treat missing `seenAt` as unread for backward compatibility.
        const isUnread = (data.seenAt == null);
        if (!isUnread) continue;
        unreadCount++;
        byAppointmentId.set(appointmentId, (byAppointmentId.get(appointmentId) || 0) + 1);
    }
    return {
        unreadCount,
        byAppointmentId,
    };
}

/**
 * Subscribe to unread appointment notifications for the signed-in vet.
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
        // IMPORTANT: avoid composite index requirements by only filtering by vetId in Firestore,
        // then deriving unread state client-side via `seenAt == null`.
        const q = query(collection(db, NOTIFICATIONS_COLLECTION), where('vetId', '==', user.uid));
        unsub = onSnapshot(q, (snap) => {
            if (!active) return;
            const state = docsToState(snap.docs || []);
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
 * Mark all unread notifications for an appointment as seen for current vet.
 * @param {string} appointmentId
 */
export async function markAppointmentNotificationsSeen(appointmentId) {
    const user = auth.currentUser;
    const aptId = String(appointmentId || '').trim();
    if (!user?.uid || !aptId) return;

    // Avoid composite indexes: read all notifications for this appointment + vet, then filter locally.
    const q = query(
        collection(db, NOTIFICATIONS_COLLECTION),
        where('vetId', '==', user.uid),
        where('appointmentId', '==', aptId),
    );

    const snap = await getDocs(q);
    if (snap.empty) return;

    await Promise.all(
        snap.docs
            .filter((d) => (d.data()?.seenAt == null))
            .map((d) => updateDoc(doc(db, NOTIFICATIONS_COLLECTION, d.id), {
                seenAt: serverTimestamp(),
                seenBy: user.uid,
                updatedAt: serverTimestamp(),
            })),
    );
}

/**
 * Create an appointment notification (typically called after creating the appointment doc).
 * This is kept here for reuse, but the booking flow currently calls it from appointment services.
 */
export async function createAppointmentNotification(payload) {
    const user = auth.currentUser;
    if (!user?.uid) throw new Error('Not signed in.');
    const p = payload || {};
    const appointmentId = String(p.appointmentId || '').trim();
    const vetId = String(p.vetId || '').trim();
    const ownerId = String(p.ownerId || '').trim();
    if (!appointmentId || !vetId || !ownerId) throw new Error('Missing notification fields.');
    await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
        type: 'appointment_booked',
        appointmentId,
        vetId,
        ownerId,
        dateStr: String(p.dateStr || '').trim() || null,
        slotStart: String(p.slotStart || '').trim() || null,
        slotEnd: String(p.slotEnd || '').trim() || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        seenAt: null,
        seenBy: null,
    });
}

export { formatBadgeCount };

