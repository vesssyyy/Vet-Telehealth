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
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

/**
 * True when the consultation video session was fully ended (vet terminate).
 * Set on the appointment as `videoSessionEndedAt`; legacy data may only have videoCall/room.status.
 * @param {Object} [apt] - Appointment document data
 */
export function isVideoSessionEnded(apt) {
    return !!(apt && apt.videoSessionEndedAt != null);
}

/**
 * True when the teleconsultation has finished (vet ended session / room closed / appointment completed).
 * Used to show "Download consultation PDF" only after a real session, not for future or in-progress bookings.
 * @param {Object} [apt] - Appointment document data
 * @param {{ status?: string }} [videoCall] - `appointments/{id}/videoCall/room` doc when available
 */
export function isConsultationPdfAvailable(apt, videoCall) {
    if (!apt) return false;
    if (videoCall && videoCall.status === 'ended') return true;
    if (isVideoSessionEnded(apt)) return true;
    const st = String(apt.status || '').toLowerCase();
    if (st === 'completed') return true;
    return false;
}

/**
 * Returns label/title for the Join button based on current time vs appointment slot.
 * Short format: today "Join at (time)", tomorrow "Tom at (time)", other "(date) at (time)".
 * @param {Object} apt - Appointment-like object
 * @param {{ status?: string }} [videoCall] - If videoCall.status === 'ended', returns 'Session Ended'
 */
export function getJoinAvailableLabel(apt, videoCall) {
    if (videoCall?.status === 'ended' || isVideoSessionEnded(apt)) return 'Session Ended';

    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || (slotStart ? addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES) : null);

    if (!dateStr || !slotStart) return 'Join Video Call';

    const start = new Date(`${dateStr}T${slotStart}`);
    const now = new Date();

    if (isNaN(start.getTime())) return 'Join Video Call';
    const timePart = formatTime12h(slotStart).replace(/\s/g, '');
    const today = getTodayDateString();
    const tomorrow = getTomorrowDateString();
    if (now < start) {
        if (dateStr === today) return `Join-${timePart}`;
        if (dateStr === tomorrow) return `Tom-${timePart}`;
        return `${formatDateForLabel(dateStr)}-${timePart}`;
    }
    if (slotEnd && now >= new Date(`${dateStr}T${slotEnd}`)) return 'Call has ended';
    if (dateStr === today) return `Join-${timePart}`;
    return 'Join Video Call';
}
