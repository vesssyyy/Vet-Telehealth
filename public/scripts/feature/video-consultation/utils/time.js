export function formatFirestoreDateTime(value) {
    if (!value) return '—';
    try {
        const date = typeof value.toDate === 'function'
            ? value.toDate()
            : typeof value.toMillis === 'function'
                ? new Date(value.toMillis())
                : new Date(value);
        return isNaN(date.getTime())
            ? '—'
            : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) {
        return '—';
    }
}

export function normalizeTimeString(value) {
    if (!value || typeof value !== 'string') return '';
    const [hoursText, minutesText] = value.trim().split(':');
    const hours = parseInt(hoursText, 10);
    const minutes = minutesText != null ? parseInt(minutesText, 10) : 0;
    if (isNaN(hours)) return '';
    return `${String(hours).padStart(2, '0')}:${String(isNaN(minutes) ? 0 : minutes).padStart(2, '0')}`;
}

