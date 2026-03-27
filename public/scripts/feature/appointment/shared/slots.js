import { DEFAULT_MIN_ADVANCE_MINUTES } from './constants.js';
import { getTodayDateString } from './time.js';

export function computeExpiryTimeMs(dateStr, slotStart, minAdvanceMinutes) {
    const [h, m] = (slotStart || '').split(':').map(Number);
    const slotMins = (h || 0) * 60 + (m || 0);
    const d = new Date(dateStr + 'T00:00:00');
    d.setMinutes(d.getMinutes() + slotMins - (minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES));
    return d.getTime();
}

export function isSlotExpired(slot, nowMs) {
    const status = slot.status || 'available';
    if (status === 'booked') return false;
    if (status === 'expired') return true;
    const expiry = slot.expiryTime != null ? Number(slot.expiryTime) : null;
    if (expiry == null) return false;
    return nowMs >= expiry;
}

export function isSlotPastCutoff(dateStr, slotStart, minAdvanceMinutes) {
    const today = getTodayDateString();
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    const now = new Date();
    const [h, m] = (slotStart || '').split(':').map(Number);
    const slotMins = (h || 0) * 60 + (m || 0);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const diffMinutes = slotMins - nowMins;
    return diffMinutes < (minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES);
}

export function ensureSlotExpiry(slot, dateStr, minAdvanceMinutes) {
    const mins = minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
    if (slot.expiryTime != null) return slot;
    return { ...slot, expiryTime: computeExpiryTimeMs(dateStr, slot.start, mins) };
}

/** Returns true if two time ranges on the same date overlap (start1 < end2 && start2 < end1). Times in "HH:mm". */
export function slotsOverlapSameDate(start1, end1, start2, end2) {
    if (!start1 || !end1 || !start2 || !end2) return false;
    return start1 < end2 && start2 < end1;
}
