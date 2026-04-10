import { formatTime12h } from '../../../core/app/utils.js';
import { formatFirestoreDateTime } from './time.js';

const DEFAULT_SLOT_DURATION_MINUTES = 30;
const ENDING_GRACE_MINUTES = 10;

function addMinutesToTime(timeStr, durationMinutes) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
    const h = parseInt(hStr, 10);
    if (isNaN(h)) return null;
    let total = h * 60 + parseInt(mStr, 10) + (durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES);
    total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function parseLocalDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const t = String(timeStr).trim();
    const m = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(t);
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2] ?? '0', 10);
    const ss = parseInt(m[3] ?? '0', 10);
    if ([hh, mm, ss].some((n) => Number.isNaN(n))) return null;

    const dStr = String(dateStr).trim();
    // Fast path for ISO-like `YYYY-MM-DD`.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
        const dt = new Date(`${dStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
        return Number.isNaN(dt.getTime()) ? null : dt;
    }

    // Fallback: let JS parse the date part, then set local time components.
    const base = new Date(dStr);
    if (Number.isNaN(base.getTime())) return null;
    base.setHours(hh, mm, ss, 0);
    return Number.isNaN(base.getTime()) ? null : base;
}

export function formatAppointmentStartLabel(appointment) {
    const dateStr = appointment?.dateStr || appointment?.date || '';
    const timeStr = appointment?.slotStart || appointment?.timeStart || '';
    if (!dateStr || !timeStr) return '—';
    const dt = parseLocalDateTime(dateStr, timeStr);
    return formatFirestoreDateTime(dt || new Date(`${dateStr}T${timeStr}`));
}

export function isWithinAppointmentTime(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return false;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
    if (!slotEnd) return false;
    const start = parseLocalDateTime(dateStr, slotStart);
    const end = parseLocalDateTime(dateStr, slotEnd);
    const now = new Date();
    if (!start || !end) return false;
    return now >= start && now < end;
}

export function getAppointmentSlotEndDate(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return null;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
    if (!slotEnd) return null;
    return parseLocalDateTime(dateStr, slotEnd);
}

export function getAppointmentGraceEndDate(apt, graceMinutes = ENDING_GRACE_MINUTES) {
    const end = getAppointmentSlotEndDate(apt);
    if (!end) return null;
    const mins = Number(graceMinutes);
    const ms = Number.isFinite(mins) ? Math.max(0, mins * 60 * 1000) : ENDING_GRACE_MINUTES * 60 * 1000;
    return new Date(end.getTime() + ms);
}

function getVideoRoomParticipantsCount(videoCall) {
    const p = videoCall?.participants;
    if (!p || typeof p !== 'object') return 0;
    return Object.keys(p).filter((k) => !!p[k]).length;
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
    const start = parseLocalDateTime(dateStr, slotStart);
    if (!start) return false;
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
    const slotEndAt = getAppointmentSlotEndDate(apt);
    const graceEndAt = getAppointmentGraceEndDate(apt);
    const nowMs = Date.now();
    if (graceEndAt && nowMs >= graceEndAt.getTime()) return false;
    if (slotEndAt && nowMs >= slotEndAt.getTime()) {
        const count = getVideoRoomParticipantsCount(videoCall);
        if (count <= 0) return false;
    }
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
    const graceEndAt = getAppointmentGraceEndDate(apt);
    if (graceEndAt && Date.now() >= graceEndAt.getTime()) return 'Session Ended';
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    const slotEnd = apt?.slotEnd || apt?.timeEnd || (slotStart ? addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES) : null);
    if (!dateStr || !slotStart) return 'Join Video Call';
    const start = parseLocalDateTime(dateStr, slotStart);
    const now = new Date();
    if (!start) return 'Join Video Call';
    const timePart = formatTime12h(slotStart).replace(/\s/g, '');
    const today = getTodayDateString();
    const tomorrow = getTomorrowDateString();
    if (now < start) {
        if (dateStr === today) return `Join-${timePart}`;
        if (dateStr === tomorrow) return `Tom-${timePart}`;
        return `${formatDateForLabel(dateStr)}-${timePart}`;
    }
    const end = slotEnd ? parseLocalDateTime(dateStr, slotEnd) : null;
    if (end && now >= end) return 'Rejoin Video Call';
    if (dateStr === today) return `Join-${timePart}`;
    return 'Join Video Call';
}

