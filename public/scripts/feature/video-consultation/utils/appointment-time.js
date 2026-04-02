import { formatTime12h } from '../../../core/app/utils.js';
import { formatFirestoreDateTime } from './time.js';

const DEFAULT_SLOT_DURATION_MINUTES = 30;

function addMinutesToTime(timeStr, durationMinutes) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
    const h = parseInt(hStr, 10);
    if (isNaN(h)) return null;
    let total = h * 60 + parseInt(mStr, 10) + (durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES);
    total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatAppointmentStartLabel(appointment) {
    const dateStr = appointment?.dateStr || appointment?.date || '';
    const timeStr = appointment?.slotStart || appointment?.timeStart || '';
    if (!dateStr || !timeStr) return '—';
    return formatFirestoreDateTime(new Date(`${dateStr}T${timeStr}`));
}

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

export function getAppointmentSlotEndDate(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return null;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
    if (!slotEnd) return null;
    const end = new Date(`${dateStr}T${slotEnd}`);
    return isNaN(end.getTime()) ? null : end;
}

function getDateString(offsetDays = 0) {
    const d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const getTodayDateString = () => getDateString(0);
const getTomorrowDateString = () => getDateString(1);

function formatDateForLabel(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(`${dateStr}T12:00:00`);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

export function isVideoSessionEnded(apt) {
    return !!(apt && apt.videoSessionEndedAt != null);
}

export function isAppointmentSlotNotYetStarted(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return false;
    const start = new Date(`${dateStr}T${slotStart}`);
    if (isNaN(start.getTime())) return false;
    return new Date() < start;
}

export function isVideoJoinClosed(apt, videoCall) {
    if (videoCall && String(videoCall.status || '').toLowerCase() === 'ended') return true;
    if (isVideoSessionEnded(apt)) return true;
    if (String(apt?.status || '').toLowerCase() === 'completed') return true;
    return false;
}

export function canRejoinVideoConsultation(apt, videoCall) {
    if (isVideoJoinClosed(apt, videoCall)) return false;
    if (isAppointmentSlotNotYetStarted(apt)) return false;
    return true;
}

export function isConsultationPdfAvailable(apt, videoCall) {
    if (!apt) return false;
    if (videoCall && videoCall.status === 'ended') return true;
    if (isVideoSessionEnded(apt)) return true;
    if (isAppointmentSlotNotYetStarted(apt)) return false;
    const st = String(apt.status || '').toLowerCase();
    if (st === 'completed') return true;
    return false;
}

export function getJoinAvailableLabel(apt, videoCall) {
    if (isVideoJoinClosed(apt, videoCall)) return 'Session Ended';
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
    if (slotEnd && now >= new Date(`${dateStr}T${slotEnd}`)) return 'Rejoin Video Call';
    if (dateStr === today) return `Join-${timePart}`;
    return 'Join Video Call';
}

