/**
 * Televet Health — Shared video call helpers.
 * Pure utilities used by the video call page and appointment actions.
 */
import { escapeHtml, formatTime12h } from './utils.js';

export const NOTES_DASH = '– ';
export const CONSULTATION_NOTES_FIELDS = [
    { id: 'notes-observation', key: 'observation', label: 'Observation', maxLength: 1500 },
    { id: 'notes-assessment', key: 'assessment', label: 'Assessment', maxLength: 800 },
    { id: 'notes-prescription', key: 'prescription', label: 'Prescription', maxLength: 1500 },
    { id: 'notes-care-instruction', key: 'careInstruction', label: 'Care instruction', maxLength: 1000 },
    { id: 'notes-follow-up', key: 'followUp', label: 'Follow up', maxLength: 800 },
];

function getLineAtCursor(value, cursorIndex) {
    const lines = value.split('\n');
    let lineStart = 0;
    let lineIndex = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const lineEnd = lineStart + lines[i].length;
        if (cursorIndex <= lineEnd) {
            lineIndex = i;
            break;
        }
        lineStart = lineEnd + 1;
    }
    return {
        lines,
        lineIndex,
        lineStart,
        line: lines[lineIndex] || '',
        isFirstLine: lineIndex === 0,
    };
}

function removeCurrentLine(value, lineIndex) {
    const lines = value.split('\n');
    const nextLines = lines.slice(0, lineIndex).concat(lines.slice(lineIndex + 1));
    return nextLines.join('\n');
}

export function attachNotesDashTextarea(textarea, { onFocusExtra } = {}) {
    if (!textarea) return;

    let justAddedLine = false;

    textarea.addEventListener('keydown', (event) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const { line, lineIndex, lineStart, isFirstLine } = getLineAtCursor(value, start);

        if (event.key === 'Enter') {
            event.preventDefault();
            justAddedLine = true;
            const nextValue = `${value.slice(0, start)}\n${NOTES_DASH}${value.slice(end)}`;
            const cursorPos = start + 1 + NOTES_DASH.length;
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        if (isFirstLine && line.startsWith(NOTES_DASH)) {
            if (event.key === 'Backspace' && start <= NOTES_DASH.length) {
                event.preventDefault();
                return;
            }
            if (event.key === 'Delete' && start < NOTES_DASH.length) {
                event.preventDefault();
                return;
            }
        }

        const isPlaceholderLine = line === NOTES_DASH.trim() || line === NOTES_DASH || line === '';
        if (!isFirstLine && isPlaceholderLine && event.key === 'Backspace') {
            event.preventDefault();
            const nextValue = removeCurrentLine(value, lineIndex);
            const cursorPos = Math.max(0, lineStart - 1);
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    textarea.addEventListener('focus', () => {
        if (!textarea.value.trim()) {
            textarea.value = NOTES_DASH;
            textarea.setSelectionRange(NOTES_DASH.length, NOTES_DASH.length);
        }
        onFocusExtra?.();
    });

    textarea.addEventListener('input', () => {
        if (justAddedLine) {
            justAddedLine = false;
            return;
        }

        const start = textarea.selectionStart;
        const value = textarea.value;
        const { line, lineIndex, lineStart } = getLineAtCursor(value, start);
        const isPlaceholderLine = line === NOTES_DASH || line === NOTES_DASH.trim() || line === '';
        if (lineIndex > 0 && isPlaceholderLine) {
            const nextValue = removeCurrentLine(value, lineIndex);
            const cursorPos = Math.max(0, lineStart - 1);
            textarea.value = nextValue;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

export function getMappedFieldValues(fields, getElement = (id) => document.getElementById(id)) {
    return fields.reduce((values, field) => {
        values[field.key] = (getElement(field.id)?.value || '').trim();
        return values;
    }, {});
}

export function setMappedFieldValues(fields, values, getElement = (id) => document.getElementById(id)) {
    if (!values || typeof values !== 'object') return;
    fields.forEach(({ id, key }) => {
        const element = getElement(id);
        if (element && values[key] != null) {
            element.value = String(values[key]);
        }
    });
}

export function buildSharedMediaMarkup(mediaUrls = []) {
    return mediaUrls.map((url, index) => {
        const ext = (url || '').split('.').pop()?.toLowerCase();
        const isImage = /^(jpg|jpeg|png|gif|webp|bmp)$/.test(ext || '');
        if (isImage) {
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-thumb"><img src="${escapeHtml(url)}" alt="Shared image ${index + 1}" loading="lazy"></a>`;
        }
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-file"><i class="fa fa-file-o"></i> File ${index + 1}</a>`;
    }).join('');
}

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

export function formatAppointmentStartLabel(appointment) {
    const dateStr = appointment?.dateStr || appointment?.date || '';
    const timeStr = appointment?.slotStart || appointment?.timeStart || '';
    if (!dateStr || !timeStr) return '—';
    return formatFirestoreDateTime(new Date(`${dateStr}T${timeStr}`));
}

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

/**
 * End instant of the booked slot (local date + slotEnd time). Null if date/start missing or invalid.
 * @param {Object} apt - Appointment-like object
 * @returns {Date|null}
 */
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

/** True when local time is still before the appointment slot start (same date/slot fields as Join). */
export function isAppointmentSlotNotYetStarted(apt) {
    const dateStr = apt?.date || apt?.dateStr;
    const slotStart = apt?.slotStart || apt?.timeStart;
    if (!dateStr || !slotStart) return false;
    const start = new Date(`${dateStr}T${slotStart}`);
    if (isNaN(start.getTime())) return false;
    return new Date() < start;
}

/**
 * True when the video consultation is fully over for join-button purposes (room ended, session timestamp, or appointment completed).
 * Past slot time alone does not close rejoin while the booking is still active.
 */
export function isVideoJoinClosed(apt, videoCall) {
    if (videoCall && String(videoCall.status || '').toLowerCase() === 'ended') return true;
    if (isVideoSessionEnded(apt)) return true;
    if (String(apt?.status || '').toLowerCase() === 'completed') return true;
    return false;
}

/** True when the user may open the video call link (after slot start, before consultation is fully finished). */
export function canRejoinVideoConsultation(apt, videoCall) {
    if (isVideoJoinClosed(apt, videoCall)) return false;
    if (isAppointmentSlotNotYetStarted(apt)) return false;
    return true;
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
    if (isAppointmentSlotNotYetStarted(apt)) return false;
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
    // Past slot window but consultation not finished — allow rejoin (other party may still be in or slot ended without completion).
    if (slotEnd && now >= new Date(`${dateStr}T${slotEnd}`)) return 'Rejoin Video Call';
    if (dateStr === today) return `Join-${timePart}`;
    return 'Join Video Call';
}
