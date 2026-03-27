/**
 * Televet Health — Shared utilities
 * Import these instead of redefining them in each file.
 */

/** Safely escape a string for HTML insertion. */
export function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/**
 * Convert "HH:mm" to 12-hour format: "8:30 AM".
 * Returns the original value when it cannot be parsed.
 */
export function formatTime12h(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return timeStr || '—';
    const parts = String(timeStr).trim().split(':');
    const h = parseInt(parts[0], 10);
    const m = parts[1] != null ? parseInt(parts[1], 10) : 0;
    if (isNaN(h)) return timeStr;
    const hour = h % 12 || 12;
    const min = isNaN(m) ? '00' : String(m).padStart(2, '0');
    return `${hour}:${min} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Format a Firestore Timestamp (or Date/ms or serialized { seconds }) as a short date string.
 * Returns "—" when the value is missing or invalid.
 */
export function formatDate(ts) {
    if (ts == null) return '—';
    let d;
    if (typeof ts?.toDate === 'function') d = ts.toDate();
    else if (typeof ts === 'number' && !Number.isNaN(ts)) d = new Date(ts);
    else if (ts instanceof Date) d = ts;
    else if (ts && typeof ts === 'object') {
        const secs = ts.seconds ?? ts._seconds;
        d = secs != null ? new Date(secs * 1000) : new Date(ts);
    } else {
        d = new Date(ts);
    }
    return d instanceof Date && !Number.isNaN(d.getTime())
        ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '—';
}

/**
 * Format a Firestore Timestamp for a conversation list preview:
 * "Just now", "HH:MM", "Yesterday", "Mon", or "Jan 5".
 */
export function formatConversationMeta(ts) {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const diff = Date.now() - d;
    if (diff < 6e4) return 'Just now';
    if (diff < 864e5) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (diff < 1728e5) return 'Yesterday';
    if (diff < 6048e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format a Firestore Timestamp as a short time string: "08:30 AM".
 */
export function formatMessageTime(ts) {
    return ts?.toDate
        ? ts.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : '';
}

/**
 * Format a message timestamp for display on click: today = time only,
 * yesterday = "Yesterday 2:30 PM", else = date + time.
 */
export function formatMessageTimeWithDate(ts) {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (msgDay.getTime() === today.getTime()) return timeStr;
    if (msgDay.getTime() === yesterday.getTime()) return `Yesterday ${timeStr}`;
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    return `${dateStr} ${timeStr}`;
}

/**
 * Return up to two initials from a display name.
 * @param {string} name
 * @param {string} [fallback='?']
 */
export function getInitials(name, fallback = '?') {
    if (!name) return fallback;
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : (name[0] || fallback).toUpperCase();
}

/**
 * Convert Firestore Timestamp or { seconds } to milliseconds for comparison.
 * @param {import('firebase/firestore').Timestamp|{seconds?: number}|null} ts
 * @returns {number}
 */
export function timestampToMs(ts) {
    if (ts == null) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return 0;
}

/**
 * Get consultation start time in ms for an appointment (dateStr + slotStart).
 * Used to place appointment dividers in message timelines.
 * @param {{ dateStr?: string, date?: string, slotStart?: string, timeStart?: string }} apt
 * @returns {number|null}
 */
export function getConsultationStartMs(apt) {
    const dateStr = apt?.dateStr || apt?.date || '';
    const slotStart = apt?.slotStart || apt?.timeStart || '';
    if (!dateStr || !slotStart) return null;
    const d = new Date(`${dateStr}T${slotStart}`);
    return isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Format appointment date and time (start only) for divider line 1: "Mar 8, 2026 at 4:40 PM".
 * @param {string} dateStr - e.g. "2026-03-08"
 * @param {string} slotStart - e.g. "16:40"
 */
export function formatAppointmentDividerDateTime(dateStr, slotStart) {
    if (!dateStr || !slotStart) return '—';
    const d = new Date(`${dateStr}T${slotStart}`);
    if (isNaN(d.getTime())) return '—';
    const datePart = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const timePart = formatTime12h(slotStart);
    return `${datePart} at ${timePart}`;
}

/**
 * Prefix a vet's display name with "Dr." if not already present.
 * Handles "Doctor", "DR", existing "Dr.", and avoids double titles after normalize.
 * @param {string} name
 */
export function withDr(name) {
    let n = String(name ?? '').trim();
    if (!n) return 'Dr. Veterinarian';
    n = n.replace(/^doctor\.?\s+/i, '').trim();
    if (!n) return 'Dr. Veterinarian';
    if (/^dr\.?\s/i.test(n)) return n;
    return `Dr. ${n}`;
}
