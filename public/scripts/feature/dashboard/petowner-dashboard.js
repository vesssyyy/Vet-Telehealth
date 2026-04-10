import { auth, db } from '../../core/firebase/firebase-config.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    formatAppointmentDate,
    extractTimeRangeFromDisplay,
    getAppointmentTimeDisplay,
    isUpcoming,
} from '../appointment/shared/time.js';
import { getAppointmentSlotEndDate,
    getJoinAvailableLabel,
    isConsultationPdfAvailable,
    canRejoinVideoConsultation,
    isVideoJoinClosed,
} from '../video-consultation/utils/appointment-time.js';
import { downloadConsultationReportForAppointment } from '../consultation/consultation-pdf-download.js';
import { loadPets, loadVetProfile } from '../appointment/petowner/services.js';
import { escapeHtml, formatDisplayName } from '../../core/app/utils.js';
import { getAppointmentSharedMediaKind } from '../../core/app/appointment-media-kind.js';
import {
    buildDetailsAttachedSkinAnalysisHtml,
    wireDetailsAttachedSkinThumbnails,
} from '../appointment/shared/details-attached-skin-html.js';
import { enrichAppointmentAttachedSkinFromHistory } from '../skin-disease/skin-analysis-repository.js';

const dateEl = document.getElementById('dashboard-date');
if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

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

function formatListDateNoWeekday(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T12:00:00');
    if (!Number.isFinite(d.getTime())) return String(dateStr);
    return d.toLocaleDateString(undefined, {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
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

function toDateMaybe(ts) {
    if (!ts) return null;
    if (ts instanceof Date) return ts;
    if (typeof ts?.toDate === 'function') return ts.toDate();
    if (typeof ts?.toMillis === 'function') return new Date(ts.toMillis());
    if (typeof ts?.seconds === 'number') return new Date(ts.seconds * 1000);
    if (typeof ts?._seconds === 'number') return new Date(ts._seconds * 1000);
    if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts);
    return null;
}

function formatDateTimeLabel(ts) {
    const d = toDateMaybe(ts);
    if (!d || !Number.isFinite(d.getTime())) return '—';
    const datePart = d.toLocaleDateString(undefined, {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
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

function getAppointmentStartMs(apt) {
    const dateStr = apt?.dateStr || apt?.date;
    const slotStart = apt?.slotStart;
    if (!dateStr || !slotStart) return Infinity;
    const t = new Date(`${dateStr}T${slotStart}`).getTime();
    return Number.isNaN(t) ? Infinity : t;
}

function pickNextUpcomingForPet(allApts, petId) {
    const now = Date.now();
    const candidates = allApts
        .filter((apt) => {
            if (petId && String(apt.petId ?? apt.petID ?? '') !== String(petId)) return false;
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

/** @type {{ id: string } & Record<string, unknown> | null} */
let nextDashboardAppointment = null;

let allAppointmentsCache = [];
let activePetId = null;
/** @type {Map<string, any>} */
const vetProfileCache = new Map();

const SELECTED_PET_STORAGE_KEY = 'telehealthSelectedPetId';

function initActivePetIdFromStorage(uid) {
    if (!uid || activePetId) return;
    try {
        const saved = localStorage.getItem(`${SELECTED_PET_STORAGE_KEY}:${uid}`);
        if (saved) activePetId = saved;
    } catch (_) {}
}

const nextDateEl = document.getElementById('dashboard-next-appointment-date');
const nextTimeEl = document.getElementById('dashboard-next-appointment-time');
const nextViewBtn = document.getElementById('dashboard-next-appointment-view');

const pastRowsEl = document.getElementById('petowner-past-consultations-rows');
const pastEmptyEl = document.getElementById('petowner-past-consultations-empty');

/** @type {Array<{ vetName: string, dateStr: string, timeDisplay: string, costCentavos: number, createdMs: number, petId: string }>} */
let transactionsCache = [];

const transactionsTrigger = document.getElementById('toggle-transactions');
const transactionsOverlay = document.getElementById('transactions-modal-overlay');
const transactionsBody = document.getElementById('transactions-modal-body');
const transactionsCloseBtn = document.getElementById('transactions-modal-close');

function updateNextAppointmentCard(apt) {
    nextDashboardAppointment = apt;
    if (!nextDateEl || !nextTimeEl || !nextViewBtn) return;
    if (!apt) {
        nextDateEl.textContent = '—';
        nextTimeEl.textContent = '—';
        nextViewBtn.disabled = true;
        nextViewBtn.setAttribute('aria-disabled', 'true');
        return;
    }

    const dateStr = apt.dateStr || apt.date || '';
    let dateVal = '—';
    if (dateStr) {
        dateVal = new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }
    nextDateEl.textContent = dateVal;
    nextTimeEl.textContent = getAppointmentTimeDisplay(apt);

    nextViewBtn.disabled = false;
    nextViewBtn.setAttribute('aria-disabled', 'false');
}

function refreshNextAppointmentForActivePet() {
    const next = pickNextUpcomingForPet(allAppointmentsCache, activePetId);
    updateNextAppointmentCard(next);
}

function getInitials(name) {
    const s = String(name || '').trim();
    if (!s) return '—';
    const parts = s.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || '' : (parts[0]?.[1] || '');
    const out = (a + b).toUpperCase().replace(/[^A-Z]/g, '');
    return out || '—';
}

function getUpcomingAppointmentsForActivePet(maxItems = 5) {
    const now = Date.now();
    const rows = allAppointmentsCache
        .filter((apt) => {
            if (activePetId && String(apt.petId ?? apt.petID ?? '') !== String(activePetId)) return false;
            const st = String(apt.status || '').toLowerCase();
            if (st === 'completed' || st === 'cancelled') return false;
            if (!isUpcoming(apt)) return false;
            if (getAppointmentStartMs(apt) === Infinity) return false;
            const end = getAppointmentSlotEndDate(apt);
            if (end && end.getTime() <= now) return false;
            return true;
        })
        .sort((a, b) => getAppointmentStartMs(a) - getAppointmentStartMs(b));
    return rows.slice(0, Math.max(0, maxItems));
}

function isPastAppointment(apt) {
    const now = Date.now();
    const st = String(apt?.status || '').toLowerCase();
    if (st === 'cancelled') return false;
    if (st === 'completed') return true;
    const end = getAppointmentSlotEndDate(apt);
    if (end && Number.isFinite(end.getTime()) && end.getTime() <= now) return true;
    return !isUpcoming(apt);
}

function getPastAppointmentsForActivePet(maxItems = 5) {
    const rows = allAppointmentsCache
        .filter((apt) => {
            if (activePetId && String(apt.petId ?? apt.petID ?? '') !== String(activePetId)) return false;
            if (getAppointmentStartMs(apt) === Infinity) return false;
            return isPastAppointment(apt);
        })
        .sort((a, b) => getAppointmentStartMs(b) - getAppointmentStartMs(a));
    return rows.slice(0, Math.max(0, maxItems));
}

function hydrateVetAvatar(vetId, imgEl, initialsEl, vetName) {
    if (!vetId || !imgEl || !initialsEl) return;
    const key = String(vetId);
    const cached = vetProfileCache.get(key);
    const apply = (vet) => {
        const url = vet?.photoURL || '';
        if (!url) return;
        imgEl.style.opacity = '0';
        imgEl.style.transition = 'opacity 0.35s ease';
        imgEl.onload = () => {
            requestAnimationFrame(() => { imgEl.style.opacity = '1'; });
        };
        imgEl.onerror = () => {
            imgEl.style.display = 'none';
            imgEl.style.opacity = '';
            initialsEl.style.display = '';
            imgEl.onerror = null;
        };
        imgEl.src = url;
        imgEl.style.display = '';
        initialsEl.style.display = 'none';
    };
    if (cached) {
        Promise.resolve(cached).then(apply).catch(() => {});
        return;
    }
    const p = loadVetProfile(key).catch(() => null);
    vetProfileCache.set(key, p);
    p.then(apply).catch(() => {});
}

function renderPastConsultations() {
    if (!pastRowsEl) return;

    const past = getPastAppointmentsForActivePet(5);
    if (!past.length) {
        pastRowsEl.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'dashboard-appt-partition-empty';
        p.textContent = 'No past consultations yet.';
        pastRowsEl.appendChild(p);
        return;
    }

    if (pastEmptyEl) pastEmptyEl.remove();
    pastRowsEl.innerHTML = '';

    past.forEach((apt) => {
        const vetName = apt.vetName ? formatDisplayName(apt.vetName) : '—';
        const apptTitle = (apt.title && String(apt.title).trim()) || '—';
        const timeLabel = getAppointmentTimeDisplay(apt);

        const scheduledDateLabel = formatListDateNoWeekday(apt.date || apt.dateStr);
        const scheduledAtLabel = `${scheduledDateLabel}${timeLabel ? ` • ${timeLabel}` : ''}`;
        const endedAtLocal = apt.videoSessionEndedAt || apt.completedAt || null;
        let endedAtLabelInitial = endedAtLocal ? formatDateTimeLabel(endedAtLocal) : '—';
        // Fallback for past-by-time rows where VC endedAt wasn't recorded.
        if (endedAtLabelInitial === '—') {
            const end = getAppointmentSlotEndDate(apt);
            const label = end ? formatDateTimeLabel(end) : '—';
            if (label !== '—') endedAtLabelInitial = label;
        }

        const row = document.createElement('article');
        row.className = 'dashboard-appointment-row';
        row.setAttribute('role', 'row');

        row.innerHTML = `
            <div class="dashboard-appointment-cell dashboard-appointment-client" role="cell">
                <div class="dashboard-appt-avatar" aria-hidden="true">
                    <img class="dashboard-appt-avatar-img dashboard-appt-avatar-img--vet" alt="" style="display:none">
                    <span class="dashboard-appt-avatar-initials">${escapeHtml(getInitials(vetName))}</span>
                </div>
                <span class="dashboard-appt-client-name">${escapeHtml(vetName)}</span>
            </div>
            <div class="dashboard-appointment-cell dashboard-appointment-title" role="cell">
                <span class="dashboard-appt-mobile-label">Title:</span>
                <span class="dashboard-appt-title" title="${escapeHtml(apptTitle)}">${escapeHtml(apptTitle)}</span>
            </div>
            <div class="dashboard-appointment-cell dashboard-appointment-when" role="cell">
                <span class="dashboard-appt-mobile-label">Sched at:</span>
                <span class="dashboard-appt-when-value">${escapeHtml(scheduledAtLabel || '—')}</span>
            </div>
            <div class="dashboard-appointment-cell dashboard-appointment-ended" role="cell">
                <span class="dashboard-appt-mobile-label">Ended at:</span>
                <span class="dashboard-appt-ended-at">${escapeHtml(endedAtLabelInitial)}</span>
            </div>
            <div class="dashboard-appointment-cell dashboard-appointment-actions" role="cell">
                <button type="button" class="btn-dashboard-appt-view" title="View appointment">
                    <i class="fa fa-eye" aria-hidden="true"></i>
                    View
                    <i class="fa fa-chevron-right btn-dashboard-appt-chevron" aria-hidden="true"></i>
                </button>
            </div>
        `;

        row.querySelector('.btn-dashboard-appt-view')?.addEventListener('click', () => openDetailsModal(apt));
        pastRowsEl.appendChild(row);

        const vetImgEl = row.querySelector('.dashboard-appt-avatar-img--vet');
        const vetInitialsEl = row.querySelector('.dashboard-appointment-client .dashboard-appt-avatar-initials');
        if (vetImgEl && vetInitialsEl && apt.vetId) {
            hydrateVetAvatar(String(apt.vetId), vetImgEl, vetInitialsEl, vetName);
        }

        // Ended At comes from VC termination: prefer appointment.videoSessionEndedAt, else read room.endedAt
        const endedAtEl = row.querySelector('.dashboard-appt-ended-at');
        const endedAtMissing = endedAtLabelInitial === '—';
        if (endedAtEl && endedAtMissing && apt?.id) {
            getDoc(doc(db, 'appointments', apt.id, 'videoCall', 'room'))
                .then((snap) => {
                    if (!snap.exists()) return;
                    const endedAt = snap.data()?.endedAt;
                    const label = formatDateTimeLabel(endedAt);
                    if (label !== '—') endedAtEl.textContent = label;
                })
                .catch(() => {});
        }
    });
}

function filterTransactionsForActivePet(rows) {
    if (!activePetId) return rows;
    return rows.filter((t) => String(t.petId || '') === String(activePetId));
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
            const timeRaw = t.timeDisplay || '—';
            const timePart = extractTimeRangeFromDisplay(timeRaw) ?? timeRaw;
            const scheduledAt = `${escapeHtml(dateFormatted)} <span class="dashboard-new-bookings-sep" aria-hidden="true">·</span> ${escapeHtml(timePart)}`;
            const paidAt = escapeHtml(formatCompactDateTime(t.createdMs));
            return `<tr>
                <td>${escapeHtml(t.vetName ? formatDisplayName(t.vetName) : '—')}</td>
                <td>${paidAt}</td>
                <td>${scheduledAt}</td>
                <td>${escapeHtml(formatPhpCentavos(t.costCentavos))}</td>
            </tr>`;
        })
        .join('');

    bodyEl.innerHTML = `<div class="dashboard-new-bookings-table-wrap"><table class="dashboard-new-bookings-table">
<thead><tr>
<th scope="col">Vet name</th>
<th scope="col">Paid at</th>
<th scope="col">Scheduled at</th>
<th scope="col">Cost</th>
</tr></thead>
<tbody>${trs}</tbody>
</table></div>`;
}

function refreshTransactionDisplay() {
    const transactionCountEl = document.getElementById('transaction-count');
    const filtered = filterTransactionsForActivePet(transactionsCache);
    if (transactionCountEl) transactionCountEl.textContent = String(filtered.length);
    if (
        transactionsOverlay &&
        transactionsBody &&
        !transactionsOverlay.classList.contains('is-hidden')
    ) {
        renderTransactionsModalBody(transactionsBody, filtered);
    }
}

function loadOwnerAppointments(uid) {
    if (!uid) return;
    getDocs(query(collection(db, 'appointments'), where('ownerId', '==', uid)))
        .then((snap) => {
            allAppointmentsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            refreshNextAppointmentForActivePet();
            renderPastConsultations();

            const paidDocs = snap.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .filter((apt) => apt?.paid === true);
            transactionsCache = paidDocs
                .map((apt) => {
                    const created = getAppointmentCreatedAtDate(apt);
                    return {
                        vetName: apt.vetName || '—',
                        dateStr: apt.dateStr || apt.date || '',
                        timeDisplay: apt.timeDisplay || getAppointmentTimeDisplay(apt) || '—',
                        costCentavos: pickAppointmentCostCentavos(apt),
                        createdMs: created?.getTime?.() ?? 0,
                        petId: String(apt.petId ?? apt.petID ?? ''),
                    };
                })
                .sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
            refreshTransactionDisplay();
        })
        .catch((err) => {
            console.error('Pet owner appointment metrics:', err);
            allAppointmentsCache = [];
            updateNextAppointmentCard(null);
            transactionsCache = [];
            const transactionCountEl = document.getElementById('transaction-count');
            if (transactionCountEl) transactionCountEl.textContent = '—';
            renderPastConsultations();
        });
}

window.addEventListener('petChanged', (e) => {
    activePetId = e.detail?.petId || null;
    refreshNextAppointmentForActivePet();
    refreshTransactionDisplay();
    renderPastConsultations();
});

// If Pet Manager selected a pet before this script attached listeners, recover it from storage.
window.addEventListener('petsReady', () => {
    const uid = auth.currentUser?.uid || null;
    if (!uid) return;
    const before = activePetId;
    initActivePetIdFromStorage(uid);
    if (activePetId !== before) {
        refreshNextAppointmentForActivePet();
        refreshTransactionDisplay();
        renderPastConsultations();
    }
});

function openTransactionsModal() {
    if (!transactionsOverlay || !transactionsBody) return;
    renderTransactionsModalBody(transactionsBody, filterTransactionsForActivePet(transactionsCache));
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

// Appointment details modal (read-only list + media).
const $ = (id) => document.getElementById(id);
const detailsOverlay = $('details-modal-overlay');
const detailsModalEl = $('details-modal');
const detailsClose = $('details-modal-close');
const detailsDownloadPdfBtn = $('details-download-pdf-btn');
const detailsMessageBtn = $('details-message-btn');
const detailsJoinBtn = $('details-join-btn');
let currentDetailsApt = null;
let detailsJoinCheckTimer = null;

function formatPetAge(age) {
    if (age == null || age === '') return '-';
    const n = Number(age);
    return isNaN(n) ? String(age) : n === 1 ? '1 Year' : n + ' Years';
}
function formatPetWeight(weight) {
    if (weight == null || weight === '') return '-';
    const n = Number(weight);
    return isNaN(n) ? String(weight) : n + ' kg';
}

function updateDetailsJoinButton(apt, videoCall) {
    if (detailsDownloadPdfBtn && apt) {
        const showPdf = isConsultationPdfAvailable(apt, videoCall);
        detailsDownloadPdfBtn.classList.toggle('is-hidden', !showPdf);
        detailsDownloadPdfBtn.toggleAttribute('hidden', !showPdf);
    }
    if (!detailsJoinBtn || !apt) return;
    const closed = isVideoJoinClosed(apt, videoCall);
    const canJoin = canRejoinVideoConsultation(apt, videoCall);
    detailsJoinBtn.disabled = !canJoin;
    detailsJoinBtn.setAttribute('aria-disabled', detailsJoinBtn.disabled ? 'true' : 'false');
    const label = getJoinAvailableLabel(apt, videoCall);
    detailsJoinBtn.title = label;
    detailsJoinBtn.innerHTML = `<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">${label}</span>`;
    detailsJoinBtn.classList.toggle('is-past', closed);
    detailsJoinBtn.classList.toggle('is-session-ended', closed);
}

function closeDetailsModal() {
    if (detailsJoinCheckTimer) { clearInterval(detailsJoinCheckTimer); detailsJoinCheckTimer = null; }
    if (detailsOverlay) {
        detailsOverlay.classList.remove('is-open');
        detailsOverlay.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
}

async function openDetailsModal(apt) {
    if (!apt || !detailsOverlay || !detailsModalEl) return;

    let aptUi = apt;
    try {
        aptUi = await enrichAppointmentAttachedSkinFromHistory(apt);
    } catch (_) {
        aptUi = apt;
    }

    const detailsTitleEl = $('details-title');
    if (detailsTitleEl) {
        const t = aptUi.title?.trim();
        detailsTitleEl.textContent = t || '-';
        detailsTitleEl.classList.toggle('is-empty', !t);
    }
    $('details-vet-name').textContent = aptUi.vetName ? formatDisplayName(aptUi.vetName) : '-';
    $('details-date').textContent = formatAppointmentDate(aptUi.date || aptUi.dateStr);
    $('details-time').textContent = getAppointmentTimeDisplay(aptUi);
    const payRow = $('details-payment');
    if (payRow) payRow.textContent = aptUi.paid === true ? 'Paid' : '-';
    $('details-concern').textContent = aptUi.reason?.trim() || '-';
    $('details-appointment-id').textContent = aptUi.id || '-';

    const skinWrap = $('details-attached-skin');
    const skinInner = $('details-attached-skin-inner');
    if (skinWrap && skinInner) {
        const s = aptUi.attachedSkinAnalysis;
        if (s && s.imageUrl) {
            skinWrap.classList.remove('is-hidden');
            skinInner.innerHTML = buildDetailsAttachedSkinAnalysisHtml(s);
            wireDetailsAttachedSkinThumbnails(skinInner);
        } else {
            skinWrap.classList.add('is-hidden');
            skinInner.innerHTML = '';
        }
    }

    const mediaUrls = Array.isArray(aptUi.mediaUrls) ? aptUi.mediaUrls : [];
    const placeholderEl = $('details-shared-images-placeholder');
    const listEl = $('details-shared-images-list');
    if (placeholderEl) placeholderEl.classList.toggle('is-hidden', mediaUrls.length > 0);
    if (listEl) {
        listEl.classList.toggle('is-hidden', mediaUrls.length === 0);
        listEl.innerHTML = '';
        mediaUrls.forEach((url, idx) => {
            const kind = getAppointmentSharedMediaKind(url);
            const item = document.createElement('div');
            item.className = 'details-shared-image-item';
            if (kind === 'pdf') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'details-shared-file-link';
                btn.dataset.url = url;
                btn.dataset.mediaKind = 'pdf';
                btn.dataset.isImage = 'false';
                btn.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> View document ' + (idx + 1);
                item.appendChild(btn);
            } else if (kind === 'video') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'details-shared-video-link';
                btn.dataset.url = url;
                btn.dataset.mediaKind = 'video';
                const vid = document.createElement('video');
                vid.className = 'details-shared-video-thumb';
                vid.muted = true;
                vid.playsInline = true;
                vid.setAttribute('playsinline', '');
                vid.preload = 'metadata';
                vid.autoplay = false;
                vid.setAttribute('aria-label', `Shared video ${idx + 1}`);
                vid.src = url;
                const onThumbReady = () => {
                    vid.pause();
                    try { vid.currentTime = 0; } catch (_) {}
                    vid.classList.add('is-loaded');
                };
                vid.addEventListener('loadeddata', onThumbReady, { once: true });
                const badge = document.createElement('span');
                badge.className = 'details-shared-video-play-badge';
                badge.setAttribute('aria-hidden', 'true');
                badge.innerHTML = '<i class="fa fa-play-circle"></i>';
                btn.appendChild(vid);
                btn.appendChild(badge);
                item.appendChild(btn);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'details-shared-image-link';
                btn.dataset.url = url;
                btn.dataset.mediaKind = 'image';
                btn.dataset.isImage = 'true';
                const img = document.createElement('img');
                img.alt = `Shared image ${idx + 1}`;
                img.className = 'details-shared-image-thumb';
                img.loading = 'lazy';
                img.onload = () => img.classList.add('is-loaded');
                img.src = url;
                btn.appendChild(img);
                item.appendChild(btn);
            }
            listEl.appendChild(item);
        });
    }

    const vetImg = $('details-vet-img');
    const vetFallback = $('details-vet-avatar-fallback');
    if (vetImg) { vetImg.style.display = 'none'; vetImg.src = ''; vetImg.style.opacity = ''; }
    if (vetFallback) vetFallback.classList.add('visible');
    loadVetProfile(aptUi.vetId).then((vet) => {
        if (vet?.photoURL && vetImg) {
            vetImg.style.opacity = '0';
            vetImg.style.transition = 'opacity 0.35s ease';
            vetImg.onload = () => {
                requestAnimationFrame(() => { vetImg.style.opacity = '1'; });
                if (vetFallback) vetFallback.classList.remove('visible');
            };
            vetImg.src = vet.photoURL;
            vetImg.style.display = '';
        }
    });

    const petImg = $('details-pet-img');
    const petFallback = $('details-pet-avatar-fallback');
    const petAvatarWrap = $('details-pet-avatar-wrap');
    if (petImg) { petImg.style.display = 'none'; petImg.src = ''; petImg.style.opacity = ''; }
    if (petFallback) {
        petFallback.classList.add('visible');
        petFallback.innerHTML = (aptUi.petSpecies || '').toLowerCase() === 'cat'
            ? '<i class="fa-solid fa-cat" aria-hidden="true"></i>'
            : '<i class="fa fa-paw" aria-hidden="true"></i>';
    }
    if (petAvatarWrap) petAvatarWrap.classList.toggle('details-pet-avatar-wrap--cat', (aptUi.petSpecies || '').toLowerCase() === 'cat');
    $('details-pet-name').textContent = aptUi.petName ? formatDisplayName(aptUi.petName) : '-';
    $('details-pet-age').textContent = '-';
    $('details-pet-weight').textContent = '-';
    const initSp = (aptUi.petSpecies || '').trim();
    $('details-pet-species').textContent = initSp ? initSp.charAt(0).toUpperCase() + initSp.slice(1).toLowerCase() : '-';
    if (auth.currentUser) {
        loadPets(auth.currentUser.uid).then((pets) => {
            const pet = pets.find((p) => p.id === aptUi.petId);
            if (!pet) return;
            $('details-pet-age').textContent = formatPetAge(pet.age);
            $('details-pet-weight').textContent = formatPetWeight(pet.weight);
            const sp = (pet.species || aptUi.petSpecies || '').trim();
            $('details-pet-species').textContent = sp ? sp.charAt(0).toUpperCase() + sp.slice(1).toLowerCase() : '-';
            if (pet.imageUrl && petImg) {
                petImg.style.opacity = '0';
                petImg.style.transition = 'opacity 0.35s ease';
                petImg.onload = () => {
                    requestAnimationFrame(() => { petImg.style.opacity = '1'; });
                    if (petFallback) petFallback.classList.remove('visible');
                };
                petImg.src = pet.imageUrl;
                petImg.style.display = '';
            }
        });
    }

    currentDetailsApt = aptUi;

    if (detailsDownloadPdfBtn) { detailsDownloadPdfBtn.classList.add('is-hidden'); detailsDownloadPdfBtn.setAttribute('hidden', ''); }
    if (detailsJoinBtn) {
        detailsJoinBtn.classList.add('is-loading-video-status');
        detailsJoinBtn.disabled = true;
        detailsJoinBtn.setAttribute('aria-disabled', 'true');
        detailsJoinBtn.title = 'Checking call status...';
        detailsJoinBtn.innerHTML = '<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">Loading...</span>';
        detailsJoinBtn.classList.add('is-past');
    }
    getDoc(doc(db, 'appointments', aptUi.id, 'videoCall', 'room')).then((videoSnap) => {
        const videoCall = videoSnap.exists() ? videoSnap.data() : null;
        detailsJoinBtn?.classList.remove('is-loading-video-status');
        updateDetailsJoinButton(aptUi, videoCall);
    }).catch(() => {
        detailsJoinBtn?.classList.remove('is-loading-video-status');
        updateDetailsJoinButton(aptUi, null);
    });

    if (detailsJoinCheckTimer) clearInterval(detailsJoinCheckTimer);
    detailsJoinCheckTimer = setInterval(() => {
        if (currentDetailsApt && detailsOverlay?.classList.contains('is-open')) {
            getDoc(doc(db, 'appointments', currentDetailsApt.id, 'videoCall', 'room')).then((videoSnap) => {
                updateDetailsJoinButton(currentDetailsApt, videoSnap.exists() ? videoSnap.data() : null);
            }).catch(() => updateDetailsJoinButton(currentDetailsApt, null));
        }
    }, 30000);

    detailsOverlay.classList.add('is-open');
    detailsOverlay.setAttribute('aria-hidden', 'false');
    detailsModalEl.focus();
    document.body.style.overflow = 'hidden';
}

detailsClose?.addEventListener('click', closeDetailsModal);
detailsOverlay?.addEventListener('click', (e) => { if (e.target === detailsOverlay) closeDetailsModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailsOverlay?.classList.contains('is-open')) closeDetailsModal();
});
detailsDownloadPdfBtn?.addEventListener('click', () => {
    if (!currentDetailsApt?.id) return;
    downloadConsultationReportForAppointment(currentDetailsApt.id, detailsDownloadPdfBtn);
});
detailsMessageBtn?.addEventListener('click', () => {
    const vetId = currentDetailsApt?.vetId || '';
    const petId = currentDetailsApt?.petId || '';
    if (!vetId || !petId) return;
    closeDetailsModal();
    const params = new URLSearchParams({ vetId, petId });
    if (currentDetailsApt?.id) params.set('appointmentId', currentDetailsApt.id);
    if (currentDetailsApt.petName) params.set('petName', currentDetailsApt.petName);
    if (currentDetailsApt.vetName) params.set('vetName', currentDetailsApt.vetName);
    const messagesUrl = `messages.html?${params.toString()}`;
    if (!window.__spaNavigate || !window.__spaNavigate(messagesUrl)) window.location.href = messagesUrl;
});
detailsJoinBtn?.addEventListener('click', () => {
    if (!currentDetailsApt || detailsJoinBtn.disabled) return;
    window.location.href = `video-call.html?appointmentId=${currentDetailsApt.id}`;
});

// Lightbox
(function initLightbox() {
    const lb = $('details-media-lightbox');
    const lbImg = lb?.querySelector('.details-media-lightbox-img');
    const lbVideo = lb?.querySelector('.details-media-lightbox-video');
    const lbIframe = lb?.querySelector('.details-media-lightbox-iframe');
    const closeBtn = lb?.querySelector('.details-media-lightbox-close');
    const backdrop = lb?.querySelector('.details-media-lightbox-backdrop');
    const imgList = $('details-shared-images-list');
    const closeLB = () => {
        if (!lb) return;
        if (lbVideo) {
            lbVideo.pause();
            lbVideo.removeAttribute('src');
            lbVideo.load?.();
        }
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = detailsOverlay?.classList.contains('is-open') ? 'hidden' : '';
        setTimeout(() => {
            if (lbImg) { lbImg.src = ''; lbImg.classList.remove('is-hidden'); }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
            if (lbVideo) { lbVideo.classList.add('is-hidden'); }
        }, 280);
    };
    const openLB = (url, kind) => {
        if (!lb) return;
        if (lbVideo) {
            lbVideo.pause();
            lbVideo.removeAttribute('src');
        }
        if (kind === 'image') {
            if (lbImg) {
                lbImg.style.opacity = '0';
                lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
                lbImg.src = url;
                lbImg.classList.remove('is-hidden');
            }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
            if (lbVideo) { lbVideo.classList.add('is-hidden'); }
        } else if (kind === 'video') {
            if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
            if (lbVideo) {
                lbVideo.autoplay = false;
                lbVideo.removeAttribute('autoplay');
                lbVideo.src = url;
                lbVideo.classList.remove('is-hidden');
                try { lbVideo.load(); } catch (_) {}
                lbVideo.pause();
                lbVideo.addEventListener('loadedmetadata', () => {
                    lbVideo.pause();
                    try { lbVideo.currentTime = 0; } catch (_) {}
                }, { once: true });
            }
        } else {
            if (lbIframe) { lbIframe.src = url; lbIframe.classList.remove('is-hidden'); }
            if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
            if (lbVideo) { lbVideo.classList.add('is-hidden'); }
        }
        lb.classList.remove('is-hidden');
        lb.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    };
    closeBtn?.addEventListener('click', closeLB);
    backdrop?.addEventListener('click', closeLB);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) { closeLB(); e.preventDefault(); e.stopPropagation(); }
    }, true);
    imgList?.addEventListener('click', (e) => {
        const btn = e.target.closest('.details-shared-image-link, .details-shared-file-link, .details-shared-video-link');
        if (!btn?.dataset?.url) return;
        e.preventDefault();
        const kind = btn.dataset.mediaKind || (btn.dataset.isImage === 'true' ? 'image' : 'pdf');
        openLB(btn.dataset.url, kind);
    });
    const skinInnerEl = $('details-attached-skin-inner');
    skinInnerEl?.addEventListener('click', (e) => {
        const thumbBtn = e.target.closest('.details-attached-skin-img-btn');
        const url = thumbBtn?.dataset?.skinFullImageUrl || thumbBtn?.querySelector('.details-attached-skin-thumb')?.src;
        if (!url) return;
        e.preventDefault();
        openLB(url, 'image');
    });
})();

// Row "View" opens the details modal for that booking.
if (nextViewBtn) {
    nextViewBtn.addEventListener('click', () => {
        if (!nextDashboardAppointment?.id) return;
        openDetailsModal(nextDashboardAppointment);
    });
}

const u = auth.currentUser;
if (u) {
    initActivePetIdFromStorage(u.uid);
    loadOwnerAppointments(u.uid);
} else {
    const unsub = auth.onAuthStateChanged((user) => {
        if (user) {
            unsub();
            initActivePetIdFromStorage(user.uid);
            loadOwnerAppointments(user.uid);
        }
    });
}
