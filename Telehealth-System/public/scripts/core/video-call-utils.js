/**
 * Televet Health — Video call time window helpers
 * Used by pet owner and vet to enable/disable Join button based on appointment slot.
 */
import { formatTime12h } from './utils.js';

const DEFAULT_SLOT_DURATION_MINUTES = 30;

/** Given "HH:mm" start, return "HH:mm" start + duration minutes. */
function addMinutesToTime(timeStr, durationMinutes) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
    const h = parseInt(hStr, 10);
    if (isNaN(h)) return null;
    let total = h * 60 + parseInt(mStr, 10) + (durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES);
    total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Returns true if current local time is within the appointment slot (start <= now < end).
 * @param {Object} apt - Appointment-like object with date/dateStr, slotStart, slotEnd (optional)
 */
export function isWithinAppointmentTime(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return false;

    const slotEnd = apt?.slotEnd || apt?.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
    if (!slotEnd) return false;

    const start = new Date(`${dateStr}T${slotStart}`);
    const end = new Date(`${dateStr}T${slotEnd}`);
    const now = new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;
    return now >= start && now < end;
}

function getDateString(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const getTodayDateString    = () => getDateString(0);
const getTomorrowDateString = () => getDateString(1);

function formatDateForLabel(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

/**
 * Returns label/title for the Join button based on current time vs appointment slot.
 * Before start: "Join available at 2:00 PM" (today), "Join available tomorrow at 2:00 PM", or "Join available on Mar 8, 2026 at 2:00 PM".
 * @param {Object} apt - Appointment-like object
 * @param {{ status?: string }} [videoCall] - If videoCall.status === 'ended', returns 'Session Ended'
 */
export function getJoinAvailableLabel(apt, videoCall) {
    if (videoCall?.status === 'ended') return 'Session Ended';

    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || (slotStart ? addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES) : null);

    if (!dateStr || !slotStart) return 'Join Video Call';

    const start = new Date(`${dateStr}T${slotStart}`);
    const now = new Date();

    if (isNaN(start.getTime())) return 'Join Video Call';
    if (now < start) {
        const today = getTodayDateString();
        const tomorrow = getTomorrowDateString();
        const timePart = formatTime12h(slotStart);
        if (dateStr === today) return `Join available at ${timePart}`;
        if (dateStr === tomorrow) return `Join available tomorrow at ${timePart}`;
        return `Join available on ${formatDateForLabel(dateStr)} at ${timePart}`;
    }
    if (slotEnd && now >= new Date(`${dateStr}T${slotEnd}`)) return 'Call has ended';
    return 'Join Video Call';
}
