import { formatTime12h } from '../../../core/app/utils.js';
import { getAppointmentSlotEndDate } from '../../video-consultation/utils/appointment-time.js';
import { CLINIC_HOURS_PLACEHOLDER, DEFAULT_SLOT_DURATION_MINUTES } from './constants.js';

export function getTodayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Given "HH:mm" start, return "HH:mm" start + duration minutes. */
export function addMinutesToTime(timeStr, durationMinutes) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
    const h = parseInt(hStr, 10);
    if (isNaN(h)) return null;
    let total = h * 60 + parseInt(mStr, 10) + (durationMinutes || DEFAULT_SLOT_DURATION_MINUTES);
    total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatAppointmentDate(dateStr) {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

/** Extract time range from timeDisplay string (e.g. "Feb 25, 2026 at 8:15 AM" → "8:15 AM", "Feb 25, 2026 at 8:15 AM – 9:15 AM" → "8:15 AM - 9:15 AM"). */
export function extractTimeRangeFromDisplay(timeDisplay) {
    if (!timeDisplay || typeof timeDisplay !== 'string') return null;
    const s = timeDisplay.trim();
    const atIdx = s.lastIndexOf(' at ');
    if (atIdx === -1) return s;
    const timePart = s.slice(atIdx + 4).trim();
    if (!timePart) return null;
    return timePart.replace(/\s*[–—]\s*/g, ' - ');
}

/** Build time range only for card display (e.g. "8:00 AM - 9:00 AM"). Uses slotEnd or default duration when start is known. */
export function getAppointmentTimeDisplay(apt) {
    const slotStart = apt.slotStart;
    const slotEnd = apt.slotEnd || (slotStart ? addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES) : null);
    if (slotStart) {
        const endPart = slotEnd ? ` - ${formatTime12h(slotEnd)}` : '';
        return `${formatTime12h(slotStart)}${endPart}`;
    }
    const parsed = extractTimeRangeFromDisplay(apt.timeDisplay);
    return parsed || apt.timeDisplay || CLINIC_HOURS_PLACEHOLDER;
}

export function isUpcoming(appointment) {
    const status = (appointment.status || 'booked').toLowerCase();
    if (status === 'cancelled' || status === 'completed') return false;
    const dateStr = appointment.date || appointment.dateStr || '';
    const today = getTodayDateString();
    if (!dateStr) return true;
    if (dateStr < today) return false;
    if (dateStr > today) return true;
    const endAt = getAppointmentSlotEndDate(appointment);
    if (endAt && Date.now() >= endAt.getTime()) return false;
    return true;
}
