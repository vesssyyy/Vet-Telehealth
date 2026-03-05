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
    if (typeof ts?.toDate === 'function') {
        d = ts.toDate();
    } else if (typeof ts === 'number' && !Number.isNaN(ts)) {
        d = new Date(ts);
    } else if (ts instanceof Date && !Number.isNaN(ts.getTime())) {
        d = ts;
    } else if (ts && typeof ts === 'object') {
        const ms = ts.seconds != null ? ts.seconds * 1000 : ts._seconds != null ? ts._seconds * 1000 : null;
        d = ms != null ? new Date(ms) : new Date(ts);
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
 * Prefix a vet's display name with "Dr." if not already present.
 * @param {string} name
 */
export function withDr(name) {
    const n = (name || '').trim();
    if (!n) return 'Dr. Veterinarian';
    return /^dr\.?\s/i.test(n) ? n : `Dr. ${n}`;
}
