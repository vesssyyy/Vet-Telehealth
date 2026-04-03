/** Televet Health — Vet Dashboard */
import { auth, db } from '../../core/firebase/firebase-config.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    buildScheduleDonutConicGradient,
    fetchVetScheduleSlotCounts,
} from '../appointment/vet/schedule-slot-counts.js';
import { escapeHtml, formatTime12h } from '../../core/app/utils.js';
import {
    extractTimeRangeFromDisplay,
    formatAppointmentDateNoWeekday,
    getAppointmentTimeDisplay,
    isUpcoming,
} from '../appointment/shared/time.js';
import {
    getAppointmentSlotEndDate,
    getJoinAvailableLabel,
    isConsultationPdfAvailable,
    canRejoinVideoConsultation,
    isVideoJoinClosed,
} from '../video-consultation/utils/appointment-time.js';
import { createDetailsApi, registerModalEvents } from '../appointment/vet/modals.js';
import { downloadConsultationReportForAppointment } from '../consultation/consultation-pdf-download.js';
import { createBookingRateChart } from './booking-rate-chart.js';

function getAppointmentCreatedAtDate(data) {
    const c = data?.createdAt;
    if (c != null) {
        if (typeof c.toDate === 'function') return c.toDate();
        if (typeof c.toMillis === 'function') return new Date(c.toMillis());
        if (c instanceof Date) return c;
        if (typeof c.seconds === 'number') return new Date(c.seconds * 1000);
        if (typeof c._seconds === 'number') return new Date(c._seconds * 1000);
        if (typeof c === 'number' && Number.isFinite(c)) return new Date(c);
    }
    const dateStr = data?.dateStr || data?.date;
    const slotStart = data?.slotStart;
    if (dateStr && slotStart) {
        const t = new Date(`${dateStr}T${slotStart}`).getTime();
        if (Number.isFinite(t)) return new Date(t);
    }
    return null;
}

/** Timestamp (ms) for when a consultation completed, or scheduled start as fallback (for older docs). */
function getAppointmentCompletedAtMs(data) {
    const c = data?.completedAt;
    if (c && typeof c.toDate === 'function') {
        const t = c.toDate().getTime();
        if (Number.isFinite(t)) return t;
    }
    if (c instanceof Date && Number.isFinite(c.getTime())) return c.getTime();
    if (c && typeof c.seconds === 'number') {
        const t = c.seconds * 1000;
        if (Number.isFinite(t)) return t;
    }
    const dateStr = data?.dateStr || data?.date;
    const slotStart = data?.slotStart;
    if (dateStr && slotStart) {
        const t = new Date(`${dateStr}T${slotStart}`).getTime();
        if (Number.isFinite(t)) return t;
    }
    const booked = getAppointmentCreatedAtDate(data);
    return booked ? booked.getTime() : 0;
}

/** Same local calendar day as `ref` (browser timezone), independent of appointment schedule date. */
function isSameLocalCalendarDay(date, ref) {
    return (
        date.getFullYear() === ref.getFullYear() &&
        date.getMonth() === ref.getMonth() &&
        date.getDate() === ref.getDate()
    );
}

function getAppointmentStartMs(apt) {
    const dateStr = apt?.dateStr || apt?.date;
    const slotStart = apt?.slotStart;
    if (!dateStr || !slotStart) return Infinity;
    const t = new Date(`${dateStr}T${slotStart}`).getTime();
    return Number.isNaN(t) ? Infinity : t;
}

function pickNextUpcomingAppointment(snap) {
    const now = Date.now();
    const candidates = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((apt) => {
            const st = String(apt.status || '').toLowerCase();
            if (st === 'completed' || st === 'cancelled') return false;
            if (!isUpcoming(apt)) return false;
            if (getAppointmentStartMs(apt) === Infinity) return false;
            const end = getAppointmentSlotEndDate(apt);
            if (end && end.getTime() <= now) return false;
            return true;
        })
        .sort((a, b) => getAppointmentStartMs(a) - getAppointmentStartMs(b));
    return candidates[0] || null;
}

/** @type {Array<{ ownerName: string, petName: string, title: string, dateStr: string, timeDisplay: string, createdMs: number }>} */
let todaysNewBookingsCache = [];

/** @type {Array<{ ownerName: string, dateStr: string, timeDisplay: string, title: string, costCentavos: number, createdMs: number }>} */
let transactionsCache = [];

/** @type {Array<{ ownerName: string, petName: string, title: string, dateStr: string, timeDisplay: string, completedMs: number }>} */
let completedConsultationsCache = [];

/** Created-at timestamps (ms) for all appointments — booking rate chart */
let bookingRateCreatedMsCache = [];

/** @type {'count' | 'percent'} */
let bookingRateYMode = 'count';

/** @type {ReturnType<typeof createBookingRateChart> | null} */
let bookingRateChartApi = null;

function refreshBookingRateChart() {
    bookingRateChartApi?.update(
        bookingRateCreatedMsCache,
        transactionPeriod,
        transactionCustomFromMs,
        transactionCustomToMs,
    );
}

const DAY_MS = 86400000;

/** @type {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} */
let transactionPeriod = 'today';

/** Inclusive custom range (local date boundaries), ms since epoch */
let transactionCustomFromMs = 0;
let transactionCustomToMs = 0;

function toLocalDateInputValue(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseDateInputStartMs(iso) {
    if (!iso || typeof iso !== 'string') return NaN;
    const d = new Date(`${iso}T00:00:00`);
    const x = d.getTime();
    return Number.isFinite(x) ? x : NaN;
}

function parseDateInputEndMs(iso) {
    if (!iso || typeof iso !== 'string') return NaN;
    const d = new Date(`${iso}T23:59:59.999`);
    const x = d.getTime();
    return Number.isFinite(x) ? x : NaN;
}

/**
 * @param {number} createdMs
 * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
 */
function isTransactionCreatedInPeriod(createdMs, period, now = new Date()) {
    const t = Number(createdMs);
    if (!Number.isFinite(t) || t <= 0) return false;
    const d = new Date(t);
    const nowMs = now.getTime();
    if (period === 'today') return isSameLocalCalendarDay(d, now);
    if (period === '3d') {
        return t >= nowMs - 3 * DAY_MS && t <= nowMs;
    }
    if (period === '7d') {
        return t >= nowMs - 7 * DAY_MS && t <= nowMs;
    }
    if (period === '30d') {
        return t >= nowMs - 30 * DAY_MS && t <= nowMs;
    }
    if (period === 'month') {
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    if (period === 'custom') {
        if (!Number.isFinite(transactionCustomFromMs) || !Number.isFinite(transactionCustomToMs)) return false;
        if (transactionCustomFromMs <= 0 || transactionCustomToMs <= 0) return false;
        return t >= transactionCustomFromMs && t <= transactionCustomToMs;
    }
    return false;
}

/**
 * @param {typeof transactionsCache} rows
 * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
 */
function filterTransactionsForPeriod(rows, period) {
    return rows.filter((r) => isTransactionCreatedInPeriod(r.createdMs, period));
}

function refreshPeriodShowingLabel() {
    const rangeEl = document.getElementById('dashboard-period-showing-range');
    if (rangeEl) {
        rangeEl.textContent = formatTransactionPeriodRangeLabel(transactionPeriod);
    }
}

/**
 * Display label for the transaction period filter (matches booked-at windows in `isTransactionCreatedInPeriod`).
 * @param {'today' | '3d' | '7d' | '30d' | 'month' | 'custom'} period
 */
function formatTransactionPeriodRangeLabel(period, now = new Date()) {
    const fmtShort = (d) =>
        d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (period === 'today') {
        return fmtShort(now);
    }
    if (period === '3d') {
        const start = new Date(now.getTime() - 3 * DAY_MS);
        return `${fmtShort(start)} – ${fmtShort(now)}`;
    }
    if (period === '7d') {
        const start = new Date(now.getTime() - 7 * DAY_MS);
        return `${fmtShort(start)} – ${fmtShort(now)}`;
    }
    if (period === '30d') {
        const start = new Date(now.getTime() - 30 * DAY_MS);
        return `${fmtShort(start)} – ${fmtShort(now)}`;
    }
    if (period === 'month') {
        return now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    if (period === 'custom') {
        if (
            Number.isFinite(transactionCustomFromMs) &&
            Number.isFinite(transactionCustomToMs) &&
            transactionCustomFromMs > 0 &&
            transactionCustomToMs > 0
        ) {
            const a = new Date(transactionCustomFromMs);
            const b = new Date(transactionCustomToMs);
            if (fmtShort(a) === fmtShort(b)) return fmtShort(a);
            return `${fmtShort(a)} – ${fmtShort(b)}`;
        }
        return 'Custom range';
    }
    return '—';
}

/** @type {{ id: string } & Record<string, unknown> | null} */
let nextDashboardAppointment = null;

/** @type {Array<{ id: string, ownerName: string, petName: string, dateStr: string, timeDisplay: string, startMs: number, status: string, title: string, reason: string }>} */
let upcomingAppointmentsCache = [];

function idFromFirestoreField(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
    return String(value).trim();
}

function initialsFromName(name) {
    const parts = String(name || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return '?';
    const a = parts[0]?.[0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || '' : '';
    return (a + b).toUpperCase() || '?';
}

/** @type {(() => void) | null} */
let scheduleDonutUnsubscribe = null;

/** Latest counts for donut hover tooltips */
let scheduleDonutCountsCache = {
    avail: 0,
    booked: 0,
    completed: 0,
    expired: 0,
    total: 0,
};

let scheduleDonutHoverInitialized = false;

function formatScheduleDonutPercent(count, total) {
    if (total <= 0) return '0%';
    const p = (count / total) * 100;
    if (p > 0 && p < 0.1) return '<0.1%';
    if (p >= 10) return `${Math.round(p)}%`;
    return `${p.toFixed(1)}%`;
}

function positionScheduleDonutTooltip(el, clientX, clientY) {
    const pad = 12;
    let x = clientX + pad;
    let y = clientY + pad;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    if (x + tw > window.innerWidth - 8) x = clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = clientY - th - pad;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
}

function hideScheduleDonutTooltip() {
    const tooltip = document.getElementById('dashboard-schedule-donut-tooltip');
    if (!tooltip) return;
    tooltip.classList.remove('is-visible');
    tooltip.textContent = '';
    tooltip.setAttribute('aria-hidden', 'true');
}

function showScheduleDonutTooltipLabel(text, clientX, clientY) {
    const tooltip = document.getElementById('dashboard-schedule-donut-tooltip');
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    positionScheduleDonutTooltip(tooltip, clientX, clientY);
}

function initScheduleDonutHoverOnce() {
    if (scheduleDonutHoverInitialized) return;
    const tooltip = document.getElementById('dashboard-schedule-donut-tooltip');
    const legend = document.querySelector('.dashboard-consultations-legend');
    if (!tooltip || !legend) return;
    scheduleDonutHoverInitialized = true;

    const legendLabelByKey = {
        avail: 'Avail',
        booked: 'Booked',
        completed: 'Completed',
        expired: 'Expired',
    };
    legend.addEventListener('mousemove', (e) => {
        const row = e.target.closest('[data-schedule-donut-segment]');
        if (!row) {
            hideScheduleDonutTooltip();
            return;
        }
        const key = row.getAttribute('data-schedule-donut-segment');
        const counts = scheduleDonutCountsCache;
        if (!key || counts.total <= 0) {
            hideScheduleDonutTooltip();
            return;
        }
        const n = counts[key];
        if (typeof n !== 'number') {
            hideScheduleDonutTooltip();
            return;
        }
        const label = legendLabelByKey[key] || key;
        const pct = formatScheduleDonutPercent(n, counts.total);
        showScheduleDonutTooltipLabel(`${label}: ${pct}`, e.clientX, e.clientY);
    });
    legend.addEventListener('mouseleave', hideScheduleDonutTooltip);
}

function teardownScheduleDonutListener() {
    if (scheduleDonutUnsubscribe) {
        scheduleDonutUnsubscribe();
        scheduleDonutUnsubscribe = null;
    }
}

/**
 * @param {{ avail: number, booked: number, completed: number, expired: number, total: number }} counts
 * @param {{ error?: boolean }} [opts]
 */
function renderScheduleDonut(counts, opts = {}) {
    const ring = document.getElementById('dashboard-schedule-donut-ring');
    const totalEl = document.getElementById('dashboard-schedule-donut-total');
    const descEl = document.getElementById('consultations-donut-desc');
    const valAvail = document.getElementById('schedule-donut-val-avail');
    const valBooked = document.getElementById('schedule-donut-val-booked');
    const valCompleted = document.getElementById('schedule-donut-val-completed');
    const valExpired = document.getElementById('schedule-donut-val-expired');
    if (!ring || !totalEl) return;

    if (opts.error) {
        scheduleDonutCountsCache = {
            avail: 0,
            booked: 0,
            completed: 0,
            expired: 0,
            total: 0,
        };
        ring.style.background = buildScheduleDonutConicGradient({
            avail: 0,
            booked: 0,
            completed: 0,
            expired: 0,
            total: 0,
        });
        totalEl.textContent = '—';
        const dash = '—';
        if (valAvail) valAvail.textContent = dash;
        if (valBooked) valBooked.textContent = dash;
        if (valCompleted) valCompleted.textContent = dash;
        if (valExpired) valExpired.textContent = dash;
        if (descEl) descEl.textContent = 'Could not load schedule slot counts.';
        hideScheduleDonutTooltip();
        return;
    }

    scheduleDonutCountsCache = {
        avail: counts.avail,
        booked: counts.booked,
        completed: counts.completed,
        expired: counts.expired,
        total: counts.total,
    };

    ring.style.background = buildScheduleDonutConicGradient(counts);
    totalEl.textContent = String(counts.total);
    if (valAvail) valAvail.textContent = String(counts.avail);
    if (valBooked) valBooked.textContent = String(counts.booked);
    if (valCompleted) valCompleted.textContent = String(counts.completed);
    if (valExpired) valExpired.textContent = String(counts.expired);
    if (descEl) {
        descEl.textContent = `Avail ${counts.avail}, Booked ${counts.booked}, Completed ${counts.completed}, Expired ${counts.expired}, total ${counts.total}.`;
    }
}

function startScheduleDonutForVet(uid) {
    teardownScheduleDonutListener();
    const ring = document.getElementById('dashboard-schedule-donut-ring');
    if (!ring || !uid) return;

    const refresh = () => {
        fetchVetScheduleSlotCounts(uid)
            .then((counts) => renderScheduleDonut(counts))
            .catch((err) => {
                console.error('Schedule donut:', err);
                renderScheduleDonut(
                    { avail: 0, booked: 0, completed: 0, expired: 0, total: 0 },
                    { error: true },
                );
            });
    };

    refresh();
    try {
        scheduleDonutUnsubscribe = onSnapshot(
            collection(db, 'users', uid, 'schedules'),
            () => refresh(),
            (err) => console.error('Schedule donut listener:', err),
        );
    } catch (e) {
        console.error('Schedule donut listener:', e);
    }
}

function normalizeStatusLabel(status) {
    const raw = String(status || '').trim();
    if (!raw) return 'Upcoming';
    const lower = raw.toLowerCase();
    if (lower === 'booked') return 'Booked';
    if (lower === 'upcoming') return 'Upcoming';
    if (lower === 'completed') return 'Completed';
    if (lower === 'expired') return 'Expired';
    if (lower === 'cancelled' || lower === 'canceled') return 'Cancelled';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function buildUpcomingAppointmentRowsMarkup(rows) {
    return rows
        .map((apt, idx) => {
            const isNext = idx === 0;
            const ownerName = apt.ownerName || '—';
            const petName = apt.petName || '—';
            const apptTitle = (apt.title && String(apt.title).trim()) || '—';
            const initials = initialsFromName(ownerName);
            const ownerPhotoUrl = (apt.ownerPhotoUrl && String(apt.ownerPhotoUrl).trim()) || '';
            const petPhotoUrl = (apt.petPhotoUrl && String(apt.petPhotoUrl).trim()) || '';
            const datePart = formatAppointmentDateNoWeekday(apt.dateStr || apt.date || '') || '—';
            const timeDisplay = apt.timeDisplay || getAppointmentTimeDisplay(apt) || '—';
            const timePart = extractTimeRangeFromDisplay(timeDisplay) ?? timeDisplay;
            const metaTitle = [apt.title, apt.reason].filter(Boolean).join(' — ').trim();

            return `<article class="dashboard-appointment-row${isNext ? ' is-next' : ''}" role="row" data-appointment-id="${escapeHtml(
                apt.id,
            )}">
                <div class="dashboard-appointment-cell dashboard-appointment-client" role="cell">
                    <div class="dashboard-appt-avatar" aria-hidden="true">
                        ${
                            ownerPhotoUrl
                                ? `<img class="dashboard-appt-avatar-img" src="${escapeHtml(
                                      ownerPhotoUrl,
                                  )}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                                : ''
                        }
                        <span class="dashboard-appt-avatar-initials"${
                            ownerPhotoUrl ? ' style="display:none"' : ''
                        }>${escapeHtml(initials)}</span>
                    </div>
                    <span class="dashboard-appt-client-name" title="${escapeHtml(ownerName)}">${escapeHtml(
                ownerName,
            )}</span>
                </div>
                <div class="dashboard-appointment-cell dashboard-appointment-pet" role="cell">
                    <div class="dashboard-appt-pet">
                        <div class="dashboard-appt-pet-avatar" aria-hidden="true">
                            ${
                                petPhotoUrl
                                    ? `<img class="dashboard-appt-pet-avatar-img" src="${escapeHtml(
                                          petPhotoUrl,
                                      )}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">`
                                    : ''
                            }
                            <span class="dashboard-appt-pet-avatar-fallback"${
                                petPhotoUrl ? ' style="display:none"' : ''
                            }><i class="fa fa-paw" aria-hidden="true"></i></span>
                        </div>
                        <span class="dashboard-appt-pet-name" title="${escapeHtml(petName)}">${escapeHtml(
                petName,
            )}</span>
                    </div>
                </div>
                <div class="dashboard-appointment-cell dashboard-appointment-title" role="cell">
                    <span class="dashboard-appt-title" title="${escapeHtml(apptTitle)}">${escapeHtml(apptTitle)}</span>
                </div>
                <div class="dashboard-appointment-cell dashboard-appointment-when" role="cell" title="${escapeHtml(
                    metaTitle,
                )}">
                    ${escapeHtml(datePart)} <span class="dashboard-appt-sep" aria-hidden="true">•</span> ${escapeHtml(
                timePart || '—',
            )}
                </div>
                <div class="dashboard-appointment-cell dashboard-appointment-actions" role="cell">
                    <button type="button" class="btn btn-dashboard-appt-view" data-action="view-appointment" title="View appointment">
                        <i class="fa fa-eye" aria-hidden="true"></i>
                        View
                        <i class="fa fa-chevron-right btn-dashboard-appt-chevron" aria-hidden="true"></i>
                    </button>
                </div>
            </article>`;
        })
        .join('');
}

function renderUpcomingAppointmentsPanel(rowsEl, rows) {
    if (!rowsEl) return;
    if (!rows.length) {
        rowsEl.innerHTML = `<div class="vet-empty-state" role="status" aria-live="polite">
            <div class="vet-empty-icon" aria-hidden="true"><i class="fa fa-calendar-check-o"></i></div>
            <h3 class="vet-empty-title">No upcoming consultations</h3>
            <p class="vet-empty-desc">When clients book consultations, they’ll show up here.</p>
        </div>`;
        return;
    }
    const [next, ...rest] = rows;
    const nextHtml = buildUpcomingAppointmentRowsMarkup([next]);
    const restHtml = rest.length ? buildUpcomingAppointmentRowsMarkup(rest) : '';

    rowsEl.innerHTML = `
        <div class="dashboard-appt-partition" role="group" aria-label="Upcoming consultation">
            ${nextHtml}
        </div>
        <div class="dashboard-appt-partition dashboard-appt-partition--queue" role="group" aria-label="Queue">
            <div class="dashboard-appt-partition-header">
                <span class="dashboard-appt-queue-label">
                    <i class="fa fa-list-ol" aria-hidden="true"></i>
                    <span>Queue</span>
                </span>
            </div>
            ${
                rest.length
                    ? restHtml
                    : `<p class="dashboard-appt-partition-empty" role="status" aria-live="polite">No queued consultations.</p>`
            }
        </div>
    `.trim();
}

async function hydrateAvatarsForUpcomingRows(rows) {
    const uniqueOwnerIds = Array.from(
        new Set(
            rows
                .map((r) => idFromFirestoreField(r.ownerId))
                .map((v) => String(v || '').trim())
                .filter(Boolean),
        ),
    );

    const uniquePetKeys = Array.from(
        new Set(
            rows
                .map((r) => {
                    const ownerId = idFromFirestoreField(r.ownerId);
                    const petId = idFromFirestoreField(r.petId);
                    if (!ownerId || !petId) return '';
                    return `${ownerId}::${petId}`;
                })
                .filter(Boolean),
        ),
    );

    const ownerPairs = await Promise.all(
        uniqueOwnerIds.map(async (ownerId) => {
            try {
                const snap = await getDoc(doc(db, 'users', ownerId));
                const data = snap.exists() ? snap.data() : {};
                const url = (data?.photoURL || data?.photoUrl || '').toString().trim();
                return [ownerId, url];
            } catch (e) {
                console.warn('Could not load owner photo', ownerId, e);
                return [ownerId, ''];
            }
        }),
    );
    const ownerMap = new Map(ownerPairs);

    const petPairs = await Promise.all(
        uniquePetKeys.map(async (key) => {
            const [ownerId, petId] = key.split('::');
            try {
                const snap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
                const data = snap.exists() ? snap.data() : {};
                const url = (data?.imageUrl || data?.photoURL || data?.photoUrl || '').toString().trim();
                return [key, url];
            } catch (e) {
                console.warn('Could not load pet photo', key, e);
                return [key, ''];
            }
        }),
    );
    const petMap = new Map(petPairs);

    return rows.map((r) => {
        const ownerId = idFromFirestoreField(r.ownerId);
        const petId = idFromFirestoreField(r.petId);
        const ownerPhotoUrl = ownerMap.get(ownerId) || '';
        const petPhotoUrl = ownerId && petId ? petMap.get(`${ownerId}::${petId}`) || '' : '';
        return { ...r, ownerPhotoUrl, petPhotoUrl };
    });
}

function renderCompletedConsultationsModalBody(listEl, rows) {
    if (!listEl) return;
    if (!rows.length) {
        listEl.innerHTML =
            '<p class="dashboard-new-bookings-empty">No completed consultations for this period.</p>';
        return;
    }
    const trs = rows
        .map((r) => {
            const title = (r.title && String(r.title).trim()) || '—';
            const dateFormatted = formatCompactDateNoWeekday(r.dateStr);
            const timePart =
                extractTimeRangeFromDisplay(r.timeDisplay) ?? (r.timeDisplay || '—');
            const scheduledAt = `${escapeHtml(dateFormatted)} <span class="dashboard-new-bookings-sep" aria-hidden="true">·</span> ${escapeHtml(timePart)}`;
            return `<tr>
                <td>${escapeHtml(r.ownerName)}</td>
                <td>${escapeHtml(r.petName)}</td>
                <td>${escapeHtml(title)}</td>
                <td>${scheduledAt}</td>
            </tr>`;
        })
        .join('');
    listEl.innerHTML = `<div class="dashboard-new-bookings-table-wrap"><table class="dashboard-new-bookings-table">
<thead><tr>
<th scope="col">Client name</th>
<th scope="col">Pet name</th>
<th scope="col">Appointment Title</th>
<th scope="col">Scheduled at</th>
</tr></thead>
<tbody>${trs}</tbody>
</table></div>`;
}

function renderTodayNewBookingsModalBody(listEl, bookings) {
    if (!bookings.length) {
        listEl.innerHTML = '<p class="dashboard-new-bookings-empty">No new bookings today.</p>';
        return;
    }
    const rows = bookings
        .map((b) => {
            const title = (b.title && String(b.title).trim()) || '—';
            const dateFormatted = formatCompactDateNoWeekday(b.dateStr);
            const timePart =
                extractTimeRangeFromDisplay(b.timeDisplay) ?? (b.timeDisplay || '—');
            return `<tr>
                <td>${escapeHtml(b.ownerName)}</td>
                <td>${escapeHtml(b.petName)}</td>
                <td>${escapeHtml(title)}</td>
                <td>${escapeHtml(dateFormatted)} <span class="dashboard-new-bookings-sep" aria-hidden="true">·</span> ${escapeHtml(timePart)}</td>
            </tr>`;
        })
        .join('');
    listEl.innerHTML = `<div class="dashboard-new-bookings-table-wrap"><table class="dashboard-new-bookings-table">
<thead><tr>
<th scope="col">Client</th>
<th scope="col">Pet</th>
<th scope="col">Title</th>
<th scope="col">Schedule At</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function formatCompactDateNoWeekday(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T12:00:00');
    if (!Number.isFinite(d.getTime())) return String(dateStr);
    return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
}

function formatCompactDateTime(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return '—';
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '—';
    const datePart = d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const timePart = d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
    });
    return `${datePart} ${timePart}`;
}

function formatPhpCentavos(centavos) {
    const n = Number(centavos);
    if (!Number.isFinite(n)) return '—';
    return `₱ ${Math.abs(n / 100).toFixed(2)}`;
}

function pickAppointmentCostCentavos(data) {
    const candidates = [
        data?.costPaidCentavos,
        data?.amountPaidCentavos,
        data?.costCentavos,
        data?.amountCentavos,
    ];
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
}

function renderTransactionsModalBody(bodyEl, rows) {
    if (!bodyEl) return;
    if (!rows.length) {
        bodyEl.innerHTML = '<p class="dashboard-new-bookings-empty">No transactions yet.</p>';
        return;
    }

    const trs = rows
        .map((t) => {
            const dateFormatted = formatCompactDateNoWeekday(t.dateStr);
            const timePart =
                extractTimeRangeFromDisplay(t.timeDisplay) ?? (t.timeDisplay || '—');
            const scheduledAt = `${escapeHtml(dateFormatted)} <span class="dashboard-new-bookings-sep" aria-hidden="true">·</span> ${escapeHtml(timePart)}`;
            const bookedAt = escapeHtml(formatCompactDateTime(t.createdMs));
            return `<tr>
                <td>${escapeHtml(t.ownerName)}</td>
                <td>${bookedAt}</td>
                <td>${scheduledAt}</td>
                <td>${escapeHtml(formatPhpCentavos(t.costCentavos))}</td>
            </tr>`;
        })
        .join('');

    bodyEl.innerHTML = `<div class="dashboard-new-bookings-table-wrap"><table class="dashboard-new-bookings-table">
<thead><tr>
<th scope="col">Client name</th>
<th scope="col">Booked at</th>
<th scope="col">Scheduled at</th>
<th scope="col">Cost</th>
</tr></thead>
<tbody>${trs}</tbody>
</table></div>`;
}

function formatDisplayDateForDetails(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
}

function initVetAppointmentDetailsModal() {
    if (!document.getElementById('details-modal-overlay')) return null;

    const $ = (id) => document.getElementById(id);
    const appointmentDoc = (appointmentId) => doc(db, 'appointments', appointmentId);
    let currentDetailsApt = null;

    const onOverlayClick = (overlayId, fn) =>
        $(overlayId)?.addEventListener('click', (e) => {
            if (e.target.id === overlayId) fn();
        });

    const noopEditDayApi = {
        closeEditDayModal: () => {},
        openEditDayModal: () => {},
        saveEditDay: () => {},
        renderEditDaySlots: () => {},
    };

    const resolveAppointmentFromSlotData = async (slotData) => {
        const dateStr = String(slotData?.dateStr || '').trim();
        const slotStart = String(slotData?.timeStart || '').trim();
        const vetId = String(slotData?.vetId || auth.currentUser?.uid || '').trim();
        if (!dateStr || !slotStart || !vetId) return null;
        try {
            const qPrimary = query(
                collection(db, 'appointments'),
                where('vetId', '==', vetId),
                where('dateStr', '==', dateStr),
                where('slotStart', '==', slotStart),
            );
            const snapPrimary = await getDocs(qPrimary);
            if (!snapPrimary.empty) {
                const first = snapPrimary.docs[0];
                return { id: first.id, ...first.data() };
            }
            const qFallback = query(
                collection(db, 'appointments'),
                where('vetId', '==', vetId),
                where('date', '==', dateStr),
                where('slotStart', '==', slotStart),
            );
            const snapFallback = await getDocs(qFallback);
            if (!snapFallback.empty) {
                const first = snapFallback.docs[0];
                return { id: first.id, ...first.data() };
            }
        } catch (err) {
            console.warn('resolveAppointmentFromSlotData:', err);
        }
        return null;
    };

    const detailsApi = createDetailsApi({
        $,
        auth,
        db,
        doc,
        getDoc,
        appointmentDoc,
        formatDisplayDate: formatDisplayDateForDetails,
        formatTime12h,
        getJoinAvailableLabel,
        isConsultationPdfAvailable,
        canRejoinVideoConsultation,
        isVideoJoinClosed,
        setCurrentDetailsApt: (v) => {
            currentDetailsApt = v;
        },
        resolveAppointmentFromSlotData,
    });

    registerModalEvents({
        $,
        onOverlayClick,
        detailsApi,
        editDayApi: noopEditDayApi,
        currentDetailsAptRef: () => currentDetailsApt,
        downloadConsultationReportForAppointment,
        editDaySlotsRef: () => [],
    });

    return detailsApi;
}

function updateNextAppointmentCard(apt, dateEl, timeEl, viewBtn) {
    nextDashboardAppointment = apt;
    if (!dateEl || !timeEl || !viewBtn) return;
    if (!apt) {
        dateEl.textContent = '—';
        timeEl.textContent = '—';
        viewBtn.disabled = true;
        viewBtn.setAttribute('aria-disabled', 'true');
        return;
    }
    const dateStr = apt.dateStr || apt.date || '';
    let dateVal = '—';
    if (dateStr) {
        dateVal = new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }
    const timeVal = getAppointmentTimeDisplay(apt);
    dateEl.textContent = dateVal;
    timeEl.textContent = timeVal;
    viewBtn.disabled = false;
    viewBtn.setAttribute('aria-disabled', 'false');
}

document.addEventListener('DOMContentLoaded', () => {
    const detailsApi = initVetAppointmentDetailsModal();

    initScheduleDonutHoverOnce();

    const bookingRateChartRoot = document.getElementById('dashboard-booking-rate-chart-inner');
    if (bookingRateChartRoot) {
        bookingRateChartApi = createBookingRateChart(bookingRateChartRoot, {
            getYMode: () => bookingRateYMode,
        });
    }

    document.querySelectorAll('[data-booking-rate-y]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const m = btn.getAttribute('data-booking-rate-y');
            if (m !== 'count' && m !== 'percent') return;
            bookingRateYMode = m;
            document.querySelectorAll('[data-booking-rate-y]').forEach((b) => {
                const on = b === btn;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-pressed', String(on));
            });
            refreshBookingRateChart();
        });
    });

    const dateEl = document.getElementById('dashboard-date');
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }

    const todayNewBookingsEl = document.getElementById('today-new-bookings');
    const completedCountEl = document.getElementById('completed-consultations-count');
    const nextDateEl = document.getElementById('dashboard-next-appointment-date');
    const nextTimeEl = document.getElementById('dashboard-next-appointment-time');
    const nextViewBtn = document.getElementById('dashboard-next-appointment-view');
    const todayBookingsTrigger = document.getElementById('today-new-bookings-trigger');
    const modalOverlay = document.getElementById('today-bookings-modal-overlay');
    const modalListEl = document.getElementById('today-bookings-modal-list');
    const modalCloseBtn = document.getElementById('today-bookings-modal-close');

    const transactionsTrigger = document.getElementById('toggle-transactions');
    const transactionsOverlay = document.getElementById('transactions-modal-overlay');
    const transactionsBody = document.getElementById('transactions-modal-body');
    const transactionsCloseBtn = document.getElementById('transactions-modal-close');
    const upcomingRowsEl = document.querySelector('.dashboard-appointments-rows');

    const completedConsultationsTrigger = document.getElementById('completed-consultations-view');
    const completedConsultationsOverlay = document.getElementById('completed-consultations-modal-overlay');
    const completedConsultationsListEl = document.getElementById('completed-consultations-modal-list');
    const completedConsultationsCloseBtn = document.getElementById('completed-consultations-modal-close');

    function refreshCompletedConsultationsDisplay() {
        if (!completedCountEl) return;
        const filtered = completedConsultationsCache.filter((row) =>
            isTransactionCreatedInPeriod(row.completedMs, transactionPeriod),
        );
        completedCountEl.textContent = String(filtered.length);
        if (
            completedConsultationsOverlay &&
            completedConsultationsListEl &&
            !completedConsultationsOverlay.classList.contains('is-hidden')
        ) {
            renderCompletedConsultationsModalBody(completedConsultationsListEl, filtered);
        }
    }

    function refreshTransactionDisplay() {
        refreshPeriodShowingLabel();
        const transactionCountEl = document.getElementById('transaction-count');
        if (transactionCountEl) {
            const filtered = filterTransactionsForPeriod(transactionsCache, transactionPeriod);
            transactionCountEl.textContent = String(filtered.length);
            if (
                transactionsOverlay &&
                transactionsBody &&
                !transactionsOverlay.classList.contains('is-hidden')
            ) {
                renderTransactionsModalBody(transactionsBody, filtered);
            }
        }
        refreshCompletedConsultationsDisplay();
    }

    const customRangeModalOverlay = document.getElementById('dashboard-custom-range-modal-overlay');
    const customRangeModalClose = document.getElementById('dashboard-custom-range-modal-close');
    const customRangeCancel = document.getElementById('dashboard-custom-cancel');
    const customRangeFrom = document.getElementById('dashboard-custom-from');
    const customRangeTo = document.getElementById('dashboard-custom-to');
    const customRangeApply = document.getElementById('dashboard-custom-apply');
    const customPeriodBtn = document.getElementById('dashboard-period-custom-btn');

    /**
     * @param {{ closeModal?: boolean }} [opts]
     */
    function applyCustomRangeFromInputs(opts = {}) {
        const closeModal = Boolean(opts.closeModal);
        if (!customRangeFrom || !customRangeTo) return false;
        let fromStr = String(customRangeFrom.value || '').trim();
        let toStr = String(customRangeTo.value || '').trim();
        if (!fromStr || !toStr) return false;
        let fromMs = parseDateInputStartMs(fromStr);
        let toMs = parseDateInputEndMs(toStr);
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
        if (fromMs > toMs) {
            const tmp = fromStr;
            fromStr = toStr;
            toStr = tmp;
            customRangeFrom.value = fromStr;
            customRangeTo.value = toStr;
            fromMs = parseDateInputStartMs(fromStr);
            toMs = parseDateInputEndMs(toStr);
        }
        transactionCustomFromMs = fromMs;
        transactionCustomToMs = toMs;
        refreshTransactionDisplay();
        refreshBookingRateChart();
        if (closeModal) closeCustomRangeModal();
        return true;
    }

    function closeCustomRangeModal() {
        if (!customRangeModalOverlay || customRangeModalOverlay.classList.contains('is-hidden')) return;
        customRangeModalOverlay.classList.add('is-hidden');
        customRangeModalOverlay.setAttribute('aria-hidden', 'true');
        customPeriodBtn?.setAttribute('aria-expanded', 'false');
        customPeriodBtn?.focus();
    }

    function openCustomRangeModal() {
        if (!customRangeModalOverlay) return;
        if (!customRangeFrom || !customRangeTo) return;
        if (transactionCustomFromMs > 0 && transactionCustomToMs > 0) {
            customRangeFrom.value = toLocalDateInputValue(new Date(transactionCustomFromMs));
            customRangeTo.value = toLocalDateInputValue(new Date(transactionCustomToMs));
        } else {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            customRangeFrom.value = toLocalDateInputValue(start);
            customRangeTo.value = toLocalDateInputValue(now);
        }
        applyCustomRangeFromInputs({ closeModal: false });
        customRangeModalOverlay.classList.remove('is-hidden');
        customRangeModalOverlay.setAttribute('aria-hidden', 'false');
        customPeriodBtn?.setAttribute('aria-expanded', 'true');
        customRangeApply?.focus();
    }

    if (nextViewBtn && detailsApi) {
        nextViewBtn.addEventListener('click', () => {
            if (!nextDashboardAppointment?.id) return;
            detailsApi.openSlotDetailsModal(nextDashboardAppointment.id, null);
        });
    }

    function loadVetAppointmentMetrics(uid) {
        if (!uid) return;
        const needToday = Boolean(todayNewBookingsEl);
        const needCompleted = Boolean(completedCountEl);
        const needNext = Boolean(nextDateEl && nextTimeEl && nextViewBtn);
        const needTransactions = Boolean(document.getElementById('transaction-count'));
        const needUpcomingPanel = Boolean(upcomingRowsEl);
        if (!needToday && !needCompleted && !needNext && !needTransactions && !needUpcomingPanel) return;

        getDocs(query(collection(db, 'appointments'), where('vetId', '==', uid)))
            .then((snap) => {
                const now = new Date();
                const transactionCountEl = document.getElementById('transaction-count');
                if (needToday) {
                    const docsToday = snap.docs.filter((d) => {
                        const t = getAppointmentCreatedAtDate(d.data());
                        return t && isSameLocalCalendarDay(t, now);
                    });
                    todaysNewBookingsCache = docsToday
                        .map((d) => {
                            const data = d.data();
                            return {
                                ownerName: data.ownerName || '—',
                                petName: data.petName || '—',
                                title: (data.title && String(data.title).trim()) || '',
                                dateStr: data.dateStr || data.date || '',
                                timeDisplay: data.timeDisplay || '—',
                                createdMs: getAppointmentCreatedAtDate(data)?.getTime() ?? 0,
                            };
                        })
                        .sort((a, b) => b.createdMs - a.createdMs);
                    todayNewBookingsEl.textContent = String(todaysNewBookingsCache.length);
                }
                if (needCompleted) {
                    completedConsultationsCache = snap.docs
                        .map((d) => d.data())
                        .filter((data) => String(data?.status || '').toLowerCase() === 'completed')
                        .map((data) => ({
                            ownerName: data.ownerName || '—',
                            petName: data.petName || '—',
                            title: (data.title && String(data.title).trim()) || '',
                            dateStr: data.dateStr || data.date || '',
                            timeDisplay: data.timeDisplay || getAppointmentTimeDisplay(data) || '—',
                            completedMs: getAppointmentCompletedAtMs(data),
                        }))
                        .sort((a, b) => b.completedMs - a.completedMs);
                    refreshCompletedConsultationsDisplay();
                }
                if (needNext) {
                    const next = pickNextUpcomingAppointment(snap);
                    updateNextAppointmentCard(next, nextDateEl, nextTimeEl, nextViewBtn);
                }
                if (needUpcomingPanel) {
                    const nowMs = Date.now();
                    upcomingAppointmentsCache = snap.docs
                        .map((d) => ({ id: d.id, ...d.data() }))
                        .filter((apt) => {
                            const st = String(apt.status || '').toLowerCase();
                            if (st === 'completed' || st === 'cancelled') return false;
                            if (!isUpcoming(apt)) return false;
                            const startMs = getAppointmentStartMs(apt);
                            if (!Number.isFinite(startMs) || startMs === Infinity) return false;
                            const end = getAppointmentSlotEndDate(apt);
                            if (end && end.getTime() <= nowMs) return false;
                            return true;
                        })
                        .map((apt) => ({
                            ...apt,
                            startMs: getAppointmentStartMs(apt),
                            dateStr: apt.dateStr || apt.date || '',
                            timeDisplay: apt.timeDisplay || getAppointmentTimeDisplay(apt) || '—',
                            ownerName: apt.ownerName || '—',
                            petName: apt.petName || '—',
                            status: apt.status || 'upcoming',
                            title: (apt.title && String(apt.title).trim()) || '',
                            reason: (apt.reason && String(apt.reason).trim()) || '',
                            ownerId: idFromFirestoreField(apt.ownerId),
                            petId: idFromFirestoreField(apt.petId),
                        }))
                        .sort((a, b) => a.startMs - b.startMs);

                    const visible = upcomingAppointmentsCache.slice(0, 11);
                    renderUpcomingAppointmentsPanel(upcomingRowsEl, visible);
                    hydrateAvatarsForUpcomingRows(visible)
                        .then((hydrated) => {
                            // Only rerender if the visible set is still the same order/ids.
                            const idsNow = visible.map((r) => r.id).join('|');
                            const idsHydrated = hydrated.map((r) => r.id).join('|');
                            if (idsNow !== idsHydrated) return;
                            renderUpcomingAppointmentsPanel(upcomingRowsEl, hydrated);
                        })
                        .catch((e) => console.warn('hydrateAvatarsForUpcomingRows:', e));
                }
                bookingRateCreatedMsCache = snap.docs
                    .map((d) => getAppointmentCreatedAtDate(d.data())?.getTime())
                    .filter((t) => Number.isFinite(t) && t > 0);
                refreshBookingRateChart();

                if (needTransactions && transactionCountEl) {
                    const paidDocs = snap.docs
                        .map((d) => ({ id: d.id, ...d.data() }))
                        .filter((apt) => apt?.paid === true);
                    transactionsCache = paidDocs
                        .map((apt) => {
                            const created = getAppointmentCreatedAtDate(apt);
                            return {
                                ownerName: apt.ownerName || '—',
                                dateStr: apt.dateStr || apt.date || '',
                                timeDisplay: apt.timeDisplay || '—',
                                title: (apt.title && String(apt.title).trim()) || '',
                                costCentavos: pickAppointmentCostCentavos(apt),
                                createdMs: created?.getTime?.() ?? 0,
                            };
                        })
                        .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
                    refreshTransactionDisplay();
                }
            })
            .catch((err) => {
                console.error('Vet appointment metrics:', err);
                const transactionCountEl = document.getElementById('transaction-count');
                if (needToday) {
                    todayNewBookingsEl.textContent = '—';
                    todaysNewBookingsCache = [];
                }
                if (needCompleted) {
                    completedConsultationsCache = [];
                    completedCountEl.textContent = '—';
                }
                if (needNext) updateNextAppointmentCard(null, nextDateEl, nextTimeEl, nextViewBtn);
                if (needUpcomingPanel) {
                    upcomingAppointmentsCache = [];
                    renderUpcomingAppointmentsPanel(upcomingRowsEl, []);
                }
                if (needTransactions && transactionCountEl) {
                    transactionsCache = [];
                    transactionCountEl.textContent = '—';
                }
                bookingRateCreatedMsCache = [];
                refreshBookingRateChart();
            });
    }

    function openTodayBookingsModal() {
        if (!modalOverlay || !modalListEl) return;
        renderTodayNewBookingsModalBody(modalListEl, todaysNewBookingsCache);
        modalOverlay.classList.remove('is-hidden');
        modalOverlay.setAttribute('aria-hidden', 'false');
        if (todayBookingsTrigger) todayBookingsTrigger.setAttribute('aria-expanded', 'true');
        modalCloseBtn?.focus();
    }

    function closeTodayBookingsModal() {
        if (!modalOverlay) return;
        modalOverlay.classList.add('is-hidden');
        modalOverlay.setAttribute('aria-hidden', 'true');
        if (todayBookingsTrigger) todayBookingsTrigger.setAttribute('aria-expanded', 'false');
        todayBookingsTrigger?.focus();
    }

    if (todayBookingsTrigger && modalOverlay && modalListEl) {
        todayBookingsTrigger.addEventListener('click', () => openTodayBookingsModal());
        modalCloseBtn?.addEventListener('click', () => closeTodayBookingsModal());
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeTodayBookingsModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (modalOverlay.classList.contains('is-hidden')) return;
            closeTodayBookingsModal();
        });
    }

    function openCompletedConsultationsModal() {
        if (!completedConsultationsOverlay || !completedConsultationsListEl) return;
        const filtered = completedConsultationsCache.filter((row) =>
            isTransactionCreatedInPeriod(row.completedMs, transactionPeriod),
        );
        renderCompletedConsultationsModalBody(completedConsultationsListEl, filtered);
        completedConsultationsOverlay.classList.remove('is-hidden');
        completedConsultationsOverlay.setAttribute('aria-hidden', 'false');
        completedConsultationsTrigger?.setAttribute('aria-expanded', 'true');
        completedConsultationsCloseBtn?.focus();
    }

    function closeCompletedConsultationsModal() {
        if (!completedConsultationsOverlay) return;
        completedConsultationsOverlay.classList.add('is-hidden');
        completedConsultationsOverlay.setAttribute('aria-hidden', 'true');
        completedConsultationsTrigger?.setAttribute('aria-expanded', 'false');
        completedConsultationsTrigger?.focus();
    }

    if (completedConsultationsTrigger && completedConsultationsOverlay && completedConsultationsListEl) {
        completedConsultationsTrigger.addEventListener('click', () => openCompletedConsultationsModal());
        completedConsultationsCloseBtn?.addEventListener('click', () => closeCompletedConsultationsModal());
        completedConsultationsOverlay.addEventListener('click', (e) => {
            if (e.target === completedConsultationsOverlay) closeCompletedConsultationsModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (completedConsultationsOverlay.classList.contains('is-hidden')) return;
            closeCompletedConsultationsModal();
        });
    }

    function openTransactionsModal() {
        if (!transactionsOverlay || !transactionsBody) return;
        const filtered = filterTransactionsForPeriod(transactionsCache, transactionPeriod);
        renderTransactionsModalBody(transactionsBody, filtered);
        transactionsOverlay.classList.remove('is-hidden');
        transactionsOverlay.setAttribute('aria-hidden', 'false');
        transactionsTrigger?.setAttribute('aria-expanded', 'true');
        transactionsCloseBtn?.focus();
    }

    function closeTransactionsModal() {
        if (!transactionsOverlay) return;
        transactionsOverlay.classList.add('is-hidden');
        transactionsOverlay.setAttribute('aria-hidden', 'true');
        transactionsTrigger?.setAttribute('aria-expanded', 'false');
        transactionsTrigger?.focus();
    }

    if (transactionsTrigger && transactionsOverlay && transactionsBody) {
        transactionsTrigger.addEventListener('click', () => openTransactionsModal());
        transactionsCloseBtn?.addEventListener('click', () => closeTransactionsModal());
        transactionsOverlay.addEventListener('click', (e) => {
            if (e.target === transactionsOverlay) closeTransactionsModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (transactionsOverlay.classList.contains('is-hidden')) return;
            closeTransactionsModal();
        });
    }

    if (upcomingRowsEl && detailsApi) {
        upcomingRowsEl.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('button[data-action="view-appointment"]');
            if (!btn) return;
            const row = btn.closest?.('[data-appointment-id]');
            const aptId = row?.getAttribute?.('data-appointment-id') || '';
            if (!aptId) return;
            detailsApi.openSlotDetailsModal(aptId, null);
        });
    }

    if (todayNewBookingsEl || completedCountEl || nextDateEl || upcomingRowsEl) {
        const u = auth.currentUser;
        if (u) {
            loadVetAppointmentMetrics(u.uid);
            startScheduleDonutForVet(u.uid);
        } else {
            const unsub = auth.onAuthStateChanged((user) => {
                if (user) {
                    unsub();
                    loadVetAppointmentMetrics(user.uid);
                    startScheduleDonutForVet(user.uid);
                }
            });
        }
    } else if (document.getElementById('dashboard-schedule-donut-ring')) {
        const u = auth.currentUser;
        if (u) startScheduleDonutForVet(u.uid);
        else {
            auth.onAuthStateChanged((user) => {
                if (user) startScheduleDonutForVet(user.uid);
            });
        }
    }

    // Legacy inline transaction details are no longer toggled; we now use a modal table.
    const detailsEl = document.getElementById('transaction-details');
    if (detailsEl) {
        detailsEl.classList.add('is-hidden');
        detailsEl.setAttribute('aria-hidden', 'true');
    }

    const periodBtns = document.querySelectorAll('.dashboard-period-btn');
    if (periodBtns.length) {
        periodBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                periodBtns.forEach((b) => {
                    const on = b === btn;
                    b.classList.toggle('is-active', on);
                    b.setAttribute('aria-pressed', String(on));
                });
                const p = btn.getAttribute('data-period');
                if (p === 'today' || p === '3d' || p === '7d' || p === '30d' || p === 'month') {
                    transactionPeriod = p;
                    closeCustomRangeModal();
                    refreshTransactionDisplay();
                    refreshBookingRateChart();
                } else if (p === 'custom') {
                    transactionPeriod = 'custom';
                    openCustomRangeModal();
                    refreshBookingRateChart();
                }
            });
        });
    }

    refreshPeriodShowingLabel();

    customRangeApply?.addEventListener('click', () => {
        applyCustomRangeFromInputs({ closeModal: true });
    });
    customRangeModalClose?.addEventListener('click', () => closeCustomRangeModal());
    customRangeCancel?.addEventListener('click', () => closeCustomRangeModal());
    customRangeModalOverlay?.addEventListener('click', (e) => {
        if (e.target === customRangeModalOverlay) closeCustomRangeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!customRangeModalOverlay || customRangeModalOverlay.classList.contains('is-hidden')) return;
        closeCustomRangeModal();
    });
});
