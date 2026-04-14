// Televet Health - Pet Owner Appointment UI (lists, modals, booking form)
import {
    loadPets,
    loadVets,
    loadVetProfile,
    loadVetSettings,
    subscribeAppointments,
    getVetOption,
    getAvailableDatesAndSlots,
    checkSlotAvailability,
    createAppointment,
} from './services.js';
import {
    formatAppointmentDate,
    getAppointmentTimeDisplay,
    getTodayDateString,
    isUpcoming,
} from '../shared/time.js';
import { CLINIC_HOURS_PLACEHOLDER } from '../shared/constants.js';
import { auth, db } from '../../../core/firebase/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { escapeHtml, formatDisplayName, formatTime12h } from '../../../core/app/utils.js';
import { getAppointmentSharedMediaKind } from '../../../core/app/appointment-media-kind.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    getJoinAvailableLabel,
    isConsultationPdfAvailable,
    canRejoinVideoConsultation,
    isVideoJoinClosed,
    getAppointmentSlotEndDate,
    getAppointmentGraceEndDate,
} from '../../video-consultation/utils/appointment-time.js';
import { downloadConsultationReportForAppointment } from '../../consultation/consultation-pdf-download.js';
import {
    listSkinAnalyses,
    skinAnalysisToShareSnapshot,
    savedAtToMs,
    enrichAppointmentAttachedSkinFromHistory,
    skinAnalysisSavedAtToMs,
    SKIN_ANALYSES_COLLECTION,
} from '../../skin-disease/skin-analysis-repository.js';
import { buildDetailsAttachedSkinAnalysisHtml, wireDetailsAttachedSkinThumbnails } from '../shared/details-attached-skin-html.js';

function speciesIcon(species, extraClass = '') {
    const isCat = (species || '').toLowerCase() === 'cat';
    const cls = extraClass ? ` ${extraClass}` : '';
    return isCat ? `<i class="fa-solid fa-cat${cls}" aria-hidden="true"></i>` : `<i class="fa fa-paw${cls}" aria-hidden="true"></i>`;
}

// Populate pet dropdown (Switch Pet style): no placeholder, only pet names with icons
export function populatePetSelect(containerEl, pets) {
    if (!containerEl) return;
    const menu = containerEl.querySelector('.booking-pet-menu, [role="menu"]');
    const trigger = containerEl.querySelector('.booking-pet-trigger, .dropdown-trigger');
    const triggerText = containerEl.querySelector('.booking-pet-trigger-text');
    const hiddenInput = document.getElementById('booking-pet');
    if (!menu || !trigger || !triggerText || !hiddenInput) return;

    const list = Array.isArray(pets) ? pets : [];
    const items = list
        .map((p) => {
            const pn = p.name ? formatDisplayName(p.name) : 'Unnamed pet';
            return `<button type="button" class="dropdown-item booking-pet-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(pn)}" data-species="${escapeHtml((p.species || '').toLowerCase())}">${speciesIcon(p.species, 'dropdown-item-icon')}<span>${escapeHtml(pn)}</span></button>`;
        })
        .join('');

    menu.innerHTML = items;

    const setOpen = (open) => {
        containerEl.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open);
    };

    const selectPet = (petId, petName, species) => {
        hiddenInput.value = petId || '';
        hiddenInput.dataset.petName = petName || '';
        hiddenInput.dataset.species = species || '';
        triggerText.textContent = petName || 'Select Pet';
        setOpen(false);
    };

    if (list.length === 1) {
        selectPet(list[0].id, list[0].name ? formatDisplayName(list[0].name) : 'Unnamed pet', (list[0].species || '').toLowerCase());
    } else if (list.length === 0) {
        triggerText.textContent = 'Select Pet';
        hiddenInput.value = '';
    } else {
        triggerText.textContent = 'Select Pet';
        hiddenInput.value = '';
    }

    trigger.onclick = (e) => {
        e.stopPropagation();
        if (list.length === 0) return;
        setOpen(!containerEl.classList.contains('is-open'));
    };
    containerEl.onclick = (e) => e.stopPropagation();
    menu.querySelectorAll('.booking-pet-item').forEach((btn) => {
        btn.onclick = () => selectPet(btn.dataset.petId, btn.dataset.petName, btn.dataset.species);
    });

    if (!window._bookingPetDropdownClickBound) {
        window._bookingPetDropdownClickBound = true;
        document.addEventListener('click', () => {
            document.querySelectorAll('.booking-pet-dropdown.is-open').forEach((d) => {
                d.classList.remove('is-open');
                d.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
            });
        });
    }
}

// Populate vet dropdown (Switch Pet style): no placeholder, only vet names with icon
export function populateVetSelect(containerEl, vets) {
    if (!containerEl) return;
    const menu = containerEl.querySelector('.booking-vet-menu, [role="menu"]');
    const trigger = containerEl.querySelector('.booking-vet-trigger, .dropdown-trigger');
    const triggerText = containerEl.querySelector('.booking-vet-trigger-text');
    const hiddenInput = document.getElementById('booking-vet');
    if (!menu || !trigger || !triggerText || !hiddenInput) return;

    const list = Array.isArray(vets) ? vets : [];

    if (list.length === 0) {
        menu.innerHTML = `<p class="dropdown-empty-msg" style="padding:12px 16px;color:#6b7280;font-size:14px;text-align:center;">No veterinarians available at the moment.</p>`;
        triggerText.textContent = 'No vets available';
        hiddenInput.value = '';
        trigger.onclick = null;
        return;
    }

    const items = list
        .map((v) => {
            const vn = formatDisplayName(v.name || '');
            return `<button type="button" class="dropdown-item booking-vet-item" role="menuitem" data-vet-id="${escapeHtml(v.id)}" data-vet-name="${escapeHtml(vn)}" data-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-stethoscope dropdown-item-icon" aria-hidden="true"></i><span>${escapeHtml(vn)}${v.clinic ? ' - ' + escapeHtml(v.clinic) : ''}</span></button>`;
        })
        .join('');

    menu.innerHTML = items;

    const setOpen = (open) => {
        containerEl.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open);
    };

    const selectVet = (vetId, vetName, clinic) => {
        hiddenInput.value = vetId || '';
        hiddenInput.dataset.vetName = vetName || '';
        hiddenInput.dataset.clinic = clinic || '';
        triggerText.textContent = vetName ? (vetName + (clinic ? ' - ' + clinic : '')) : 'Select Vet';
        setOpen(false);
        if (typeof window._onVetChange === 'function') window._onVetChange();
    };

    if (list.length === 1) {
        selectVet(list[0].id, formatDisplayName(list[0].name || ''), list[0].clinic || '');
    } else if (list.length === 0) {
        triggerText.textContent = 'Select Vet';
        hiddenInput.value = '';
    } else {
        triggerText.textContent = 'Select Vet';
        hiddenInput.value = '';
    }

    trigger.onclick = (e) => {
        e.stopPropagation();
        if (list.length === 0) return;
        setOpen(!containerEl.classList.contains('is-open'));
    };
    containerEl.onclick = (e) => e.stopPropagation();
    menu.querySelectorAll('.booking-vet-item').forEach((btn) => {
        btn.onclick = () => selectVet(btn.dataset.vetId, btn.dataset.vetName, btn.dataset.clinic);
    });

    if (!window._bookingVetDropdownClickBound) {
        window._bookingVetDropdownClickBound = true;
        document.addEventListener('click', () => {
            document.querySelectorAll('.booking-vet-dropdown.is-open').forEach((d) => {
                d.classList.remove('is-open');
                d.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
            });
        });
    }
}


function renderAppointmentCard(apt, isHistory = false) {
    const isCat = (apt.petSpecies || '').toLowerCase() === 'cat';
    const statusRaw = (apt.status === 'confirmed' ? 'completed' : (apt.status || 'completed')).toLowerCase();
    let displayStatusRaw = statusRaw;
    if (isHistory && statusRaw !== 'completed' && statusRaw !== 'cancelled') {
        const endAt = getAppointmentSlotEndDate(apt);
        const graceEndAt = getAppointmentGraceEndDate(apt);
        const nowMs = Date.now();
        if (endAt && graceEndAt && nowMs >= endAt.getTime() && nowMs < graceEndAt.getTime()) {
            displayStatusRaw = 'ending';
        } else if (graceEndAt && nowMs >= graceEndAt.getTime()) {
            // Past grace window: treat as completed for display even if the appointment doc hasn't synced status yet.
            displayStatusRaw = 'completed';
        }
    }
    const statusChip = isHistory
        ? `<span class="appointment-card-chip appointment-card-chip--${escapeHtml(displayStatusRaw)}">${escapeHtml(displayStatusRaw)}</span>`
        : '<span class="appointment-card-chip appointment-card-chip--upcoming">upcoming</span>';
    const variantClass = isHistory ? 'appointment-card--completed' : 'appointment-card--upcoming';
    const title = escapeHtml(apt.title?.trim() || 'Consultation');
    const pet = escapeHtml(apt.petName ? formatDisplayName(apt.petName) : 'Pet');
    const vetLine = [apt.vetName, apt.clinicName]
        .filter(Boolean)
        .map((s) => escapeHtml(formatDisplayName(String(s))))
        .join(' · ');
    return `
        <article class="appointment-card ${variantClass}" data-appointment-id="${escapeHtml(apt.id)}">
            <div class="appointment-card-pet">
                <div class="appointment-card-pet-img${isCat ? ' appointment-card-pet-img--cat' : ''}" aria-hidden="true">${speciesIcon(apt.petSpecies)}</div>
            </div>
            <div class="appointment-card-body">
                <div class="appointment-card-topline">
                    <h3 class="appointment-card-title">${title}</h3>
                    ${statusChip}
                </div>
                <p class="appointment-card-meta"><span class="appointment-card-pet-label">${pet}</span><span class="appointment-card-meta-sep" aria-hidden="true"></span><span class="appointment-card-vet">${vetLine || '—'}</span></p>
                <p class="appointment-card-time"><i class="fa fa-clock-o" aria-hidden="true"></i><span class="appointment-card-time-text">${escapeHtml(getAppointmentTimeDisplay(apt))}</span></p>
            </div>
            <div class="appointment-card-actions">
                <button type="button" class="appointment-view-btn" data-id="${escapeHtml(apt.id)}" aria-label="View details"><span>View</span><i class="fa fa-chevron-right" aria-hidden="true"></i></button>
            </div>
        </article>`;
}

function groupByDate(apts, dateKey) {
    const byDate = {};
    apts.forEach(apt => {
        const key = apt.date || apt.dateStr || dateKey;
        (byDate[key] ??= []).push(apt);
    });
    return byDate;
}

function getAppointmentStartSortMs(apt) {
    const dateStr = apt.date || apt.dateStr || '';
    const slot = apt.slotStart;
    if (dateStr && slot) {
        const t = new Date(`${dateStr}T${slot}`).getTime();
        if (Number.isFinite(t)) return t;
    }
    if (dateStr) {
        const t = new Date(`${dateStr}T12:00:00`).getTime();
        if (Number.isFinite(t)) return t;
    }
    return 0;
}

// Today first, then later dates ascending; “No date” / “Other” last.
function sortDateHeadingKeysUpcoming(keys) {
    const today = getTodayDateString();
    return [...keys].sort((a, b) => {
        const aUndated = a === 'No date';
        const bUndated = b === 'No date';
        if (aUndated !== bUndated) return aUndated ? 1 : -1;
        if (a === today && b !== today) return -1;
        if (b === today && a !== today) return 1;
        return String(a).localeCompare(String(b));
    });
}

// Today first, then older dates descending; fallback bucket last.
function sortDateHeadingKeysPast(keys) {
    const today = getTodayDateString();
    return [...keys].sort((a, b) => {
        const aOther = a === 'Other';
        const bOther = b === 'Other';
        if (aOther !== bOther) return aOther ? 1 : -1;
        if (a === today && b !== today) return -1;
        if (b === today && a !== today) return 1;
        return String(b).localeCompare(String(a));
    });
}

const ALL_UNDATED_KEYS = new Set(['Undated', 'No date', 'Other']);

/**
 * All tab: today + future dates ascending, then past dates descending, undated last.
 * @param {string[]} keys
 */
function sortDateHeadingKeysAll(keys) {
    const today = getTodayDateString();
    const undated = keys.filter((k) => ALL_UNDATED_KEYS.has(k));
    const dated = keys.filter((k) => !ALL_UNDATED_KEYS.has(k));
    const futureOrToday = dated.filter((k) => k >= today).sort((a, b) => a.localeCompare(b));
    const pastOnly = dated.filter((k) => k < today).sort((a, b) => b.localeCompare(a));
    return [...futureOrToday, ...pastOnly, ...undated.sort((a, b) => a.localeCompare(b))];
}

function formatAllTabDateHeading(dateStr) {
    if (ALL_UNDATED_KEYS.has(dateStr)) return 'Scheduled';
    return formatAppointmentDate(dateStr);
}

function sortAppointmentsInGroup(apts, direction) {
    return [...apts].sort((a, b) => {
        const da = getAppointmentStartSortMs(a);
        const db = getAppointmentStartSortMs(b);
        return direction === 'asc' ? da - db : db - da;
    });
}

// Render upcoming appointments into panel
export function renderUpcomingPanel(panelEl, appointments) {
    if (!panelEl) return;
    const upcoming = (appointments || []).filter(isUpcoming);
    if (upcoming.length === 0) {
        panelEl.innerHTML = `
            <div class="appointments-empty-state">
                <i class="fa fa-calendar-plus-o" aria-hidden="true"></i>
                <p>Nothing scheduled</p>
                <span class="appointments-empty-hint">Use Book consultation.</span>
            </div>`;
        return;
    }
    const byDate = groupByDate(upcoming, 'No date');
    const dateKeys = sortDateHeadingKeysUpcoming(Object.keys(byDate));
    panelEl.innerHTML = dateKeys
        .map((dateStr) => {
            const apts = sortAppointmentsInGroup(byDate[dateStr], 'asc');
            return `
        <section class="appointments-date-group">
            <h3 class="appointments-date-heading">${escapeHtml(dateStr === 'No date' ? 'Scheduled' : formatAppointmentDate(dateStr))}</h3>
            ${apts.map((apt) => renderAppointmentCard(apt, false)).join('')}
        </section>`;
        })
        .join('');
}

// Render completed / past appointments (not upcoming).
export function renderCompletedPanel(panelEl, appointments) {
    if (!panelEl) return;
    const completed = (appointments || []).filter((a) => !isUpcoming(a));
    if (completed.length === 0) {
        panelEl.innerHTML = `
            <div class="appointments-empty-state">
                <i class="fa fa-calendar-o" aria-hidden="true"></i>
                <p>No completed visits</p>
                <span class="appointments-empty-hint">Switch to Upcoming or All, or book a consultation.</span>
            </div>`;
        return;
    }
    const byDate = groupByDate(completed, 'Other');
    const dateKeys = sortDateHeadingKeysPast(Object.keys(byDate));
    panelEl.innerHTML = dateKeys
        .map((dateStr) => {
            const apts = sortAppointmentsInGroup(byDate[dateStr], 'desc');
            return `
        <section class="appointments-date-group">
            <h3 class="appointments-date-heading">${escapeHtml(formatAppointmentDate(dateStr))}</h3>
            ${apts.map((apt) => renderAppointmentCard(apt, true)).join('')}
        </section>`;
        })
        .join('');
}

/** @deprecated Use renderCompletedPanel */
export const renderHistoryPanel = renderCompletedPanel;

// Single date-grouped list for the All tab (no Upcoming / Past section labels).
export function renderAllAppointmentsPanel(panelEl, appointments) {
    if (!panelEl) return;
    const all = appointments || [];
    if (all.length === 0) {
        panelEl.innerHTML = `
            <div class="appointments-empty-state">
                <i class="fa fa-calendar" aria-hidden="true"></i>
                <p>No appointments yet</p>
                <span class="appointments-empty-hint">Use Book consultation to schedule.</span>
            </div>`;
        return;
    }
    const byDate = groupByDate(all, 'Undated');
    const dateKeys = sortDateHeadingKeysAll(Object.keys(byDate));
    panelEl.innerHTML = dateKeys
        .map((dateStr) => {
            const apts = sortAppointmentsInGroup(byDate[dateStr], 'asc');
            return `
        <section class="appointments-date-group">
            <h3 class="appointments-date-heading">${escapeHtml(formatAllTabDateHeading(dateStr))}</h3>
            ${apts.map((apt) => renderAppointmentCard(apt, !isUpcoming(apt))).join('')}
        </section>`;
        })
        .join('');
}


const $ = (id) => document.getElementById(id);
const overlay = $('booking-modal-overlay');
const modal = $('booking-modal');
const closeBtn = $('booking-modal-close');
const cancelBtn = $('booking-cancel-btn');
const form = $('booking-form');
const confirmBtn = $('booking-confirm-btn');
// TEST-ONLY (REMOVE AFTER QA): one-click booking without payment redirect
const testBookBtn = $('booking-test-book-btn');
const formError = $('booking-form-error');
const appointmentsLoading = $('appointments-loading');
const upcomingRoot = $('upcoming-appointments-root');
const completedRoot = $('completed-appointments-root');
const allAppointmentsRoot = $('all-appointments-root');
const bookingDate = $('booking-date');
const bookingTime = $('booking-time');
const bookingVet = $('booking-vet');
const bookingVetDropdown = $('booking-vet-dropdown');
const uploadZone = $('booking-upload-zone');
const fileInput = $('booking-media');
const fileListEl = $('booking-file-list');
const uploadHint = $('booking-upload-hint');

const MIN_MEDIA_FILES = 0;
// Files + optional skin analysis share one combined limit
const MAX_BOOKING_ATTACHMENTS = 3;

function bookingSkinSlotUsed() {
    return bookingAttachedSkinSnapshot ? 1 : 0;
}

function maxBookingMediaFilesAllowed() {
    return MAX_BOOKING_ATTACHMENTS - bookingSkinSlotUsed();
}

function totalBookingAttachments() {
    return bookingMediaFiles.length + bookingSkinSlotUsed();
}
// Images, PDFs, and common video formats for vet review in appointment details.
function isAllowedBookingMediaFile(f) {
    if (!f) return false;
    const t = (f.type || '').toLowerCase();
    const n = (f.name || '').toLowerCase();
    if (t.startsWith('image/')) return true;
    if (t.startsWith('video/')) return true;
    if (n.endsWith('.pdf')) return true;
    return /\.(mp4|webm|mov|m4v|ogv)$/i.test(n);
}
const BOOKING_MEDIA_DB = 'televet_booking_media';
const BOOKING_MEDIA_STORE = 'files';

let cachedAvailability = { dates: [], slotsByDate: {} };
// Persisted list so "Add more" stacks files instead of replacing.
let bookingMediaFiles = [];
let bookingAttachedSkinSnapshot = null;
let ignoreFileInputChange = false;

// TEST-ONLY (REMOVE AFTER QA): cache lists for one-click booking
let cachedPetsList = [];
let cachedVetsList = [];

function syncFileInputFromBookingMedia() {
    if (!fileInput) return;
    ignoreFileInputChange = true;
    const dt = new DataTransfer();
    bookingMediaFiles.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
    ignoreFileInputChange = false;
}

function showBookingAppToast(message) {
    const el = $('booking-app-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('is-hidden');
    el.setAttribute('aria-hidden', 'false');
    clearTimeout(showBookingAppToast._timer);
    showBookingAppToast._timer = setTimeout(() => {
        el.classList.add('is-hidden');
        el.setAttribute('aria-hidden', 'true');
    }, 3000);
}

function clearBookingSkinAttachment() {
    bookingAttachedSkinSnapshot = null;
    const prev = $('booking-skin-attach-preview');
    const txt = $('booking-skin-attach-preview-text');
    if (prev) prev.classList.add('is-hidden');
    if (txt) txt.textContent = '';
    updateFileList();
}

function renderDetailsAttachedSkin(apt) {
    const wrap = $('details-attached-skin');
    const inner = $('details-attached-skin-inner');
    if (!wrap || !inner) return;
    const s = apt.attachedSkinAnalysis;
    if (s && s.imageUrl) {
        wrap.classList.remove('is-hidden');
        inner.innerHTML = buildDetailsAttachedSkinAnalysisHtml(s);
        wireDetailsAttachedSkinThumbnails(inner);
    } else {
        wrap.classList.add('is-hidden');
        inner.innerHTML = '';
    }
}

function openModal() {
    if (!overlay || !modal) return;
    clearFieldErrors();
    showFormError('');
    bookingMediaFiles = [];
    syncFileInputFromBookingMedia();
    clearBookingSkinAttachment();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    modal.focus();
    document.body.style.overflow = 'hidden';
}
function closeModal() {
    if (overlay) {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
}
function showFormError(msg) {
    if (!formError) return;
    formError.textContent = msg || '';
    formError.classList.toggle('is-hidden', !msg);
}
function clearFieldErrors() {
    form?.querySelectorAll('.booking-form-group.has-error').forEach((g) => g.classList.remove('has-error'));
}
function setFieldError(el) {
    const group = el?.closest('.booking-form-group');
    if (group) group.classList.add('has-error');
}
function validateAndHighlightFields() {
    clearFieldErrors();
    const petInput = $('booking-pet');
    const vetInput = $('booking-vet');
    const titleInput = $('booking-title');
    const reasonInput = $('booking-reason');
    const dateEl = $('booking-date');
    const timeEl = $('booking-time');
    const petVal = petInput?.value;
    const petNameVal = petInput?.dataset?.petName;
    const vetVal = vetInput?.value;
    const vetNameVal = vetInput?.dataset?.vetName;
    const titleVal = titleInput?.value?.trim();
    const reasonVal = reasonInput?.value?.trim();
    const dateVal = dateEl?.value;
    const timeVal = timeEl?.value;
    const fileCount = fileInput?.files?.length ?? 0;
    const attachmentTotal = fileCount + bookingSkinSlotUsed();
    let hasError = false;
    if (!petVal || !petNameVal) { setFieldError($('booking-pet-dropdown')); hasError = true; }
    if (!vetVal || !vetNameVal) { setFieldError($('booking-vet-dropdown')); hasError = true; }
    if (!titleVal) { setFieldError(titleInput); hasError = true; }
    if (!reasonVal) { setFieldError(reasonInput); hasError = true; }
    if (!dateVal || !timeVal) {
        if (!dateVal) setFieldError(dateEl);
        if (!timeVal) setFieldError(timeEl);
        hasError = true;
    }
    if (attachmentTotal > MAX_BOOKING_ATTACHMENTS) {
        setFieldError(uploadZone);
        if (uploadHint) {
            uploadHint.textContent = `Maximum ${MAX_BOOKING_ATTACHMENTS} attachments (files and skin analysis combined). Remove ${attachmentTotal - MAX_BOOKING_ATTACHMENTS} attachment(s).`;
            uploadHint.classList.remove('is-hidden');
        }
        hasError = true;
    } else if (uploadHint) uploadHint.classList.add('is-hidden');
    return !hasError;
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) { return dateStr; }
}
async function onVetChange() {
    const vetId = bookingVet?.value;
    if (bookingDate) bookingDate.disabled = !vetId;
    if (bookingTime) bookingTime.disabled = true;
    if (bookingDate) bookingDate.innerHTML = '<option value="">Select a date</option>';
    if (bookingTime) bookingTime.innerHTML = '<option value="">Select a date first</option>';
    if (!vetId) return;
    if (bookingDate) bookingDate.innerHTML = '<option value="">Loading availability...</option>';
    try {
        const avail = await getAvailableDatesAndSlots(vetId);
        cachedAvailability = avail;
        if (bookingDate) bookingDate.innerHTML = '<option value="">Select a date</option>';
        if (avail.dates?.length > 0) {
            avail.dates.forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d;
                opt.textContent = formatDisplayDate(d);
                bookingDate.appendChild(opt);
            });
        } else if (bookingDate) bookingDate.innerHTML = '<option value="">No available dates</option>';
    } catch (err) {
        console.error('Load availability error:', err);
        const isPerm = err?.code === 'permission-denied' || err?.message?.includes('permission');
        if (bookingDate) bookingDate.innerHTML = '<option value="">' + (isPerm ? 'Permission denied. Add Firestore rules for vet schedules.' : 'Failed to load. Try again.') + '</option>';
        showFormError(isPerm ? 'Firestore rules needed: allow read on users/{userId}/schedules for vets. See firestore.rules.' : '');
    }
}
function onDateChange() {
    const dateStr = bookingDate?.value;
    if (bookingTime) bookingTime.disabled = !dateStr;
    if (bookingTime) bookingTime.innerHTML = '<option value="">Select a time</option>';
    if (!dateStr || !cachedAvailability.slotsByDate) return;
    const slots = cachedAvailability.slotsByDate[dateStr];
    if (slots?.length > 0) {
        slots.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.start;
            if (s.end) opt.dataset.slotEnd = s.end;
            opt.textContent = s.display;
            bookingTime.appendChild(opt);
        });
    } else if (bookingTime) bookingTime.innerHTML = '<option value="">No available times</option>';
}

function updateConfirmButtonState() {
    const petCount = window._bookingPetsCount ?? 0;
    if (confirmBtn) confirmBtn.disabled = petCount === 0 || totalBookingAttachments() > MAX_BOOKING_ATTACHMENTS;
    // TEST-ONLY (REMOVE AFTER QA)
    if (testBookBtn) testBookBtn.disabled = petCount === 0;
}

function resetBookingFormState() {
    form?.reset();
    if (bookingDate) { bookingDate.innerHTML = '<option value="">Select a vet first</option>'; bookingDate.disabled = true; }
    if (bookingTime) { bookingTime.innerHTML = '<option value="">Select a date first</option>'; bookingTime.disabled = true; }
    const petTriggerText = document.querySelector('.booking-pet-trigger-text');
    if (petTriggerText) petTriggerText.textContent = 'Select Pet';
    const vetTriggerText = document.querySelector('.booking-vet-trigger-text');
    if (vetTriggerText) vetTriggerText.textContent = 'Select Vet';
    cachedAvailability = { dates: [], slotsByDate: {} };
    bookingMediaFiles = [];
    syncFileInputFromBookingMedia();
    clearBookingSkinAttachment();
    updateConfirmButtonState();
}

function updateFileList() {
    const files = fileInput?.files ? Array.from(fileInput.files) : [];
    updateConfirmButtonState();
    if (!fileListEl) return;
    fileListEl.innerHTML = '';
    fileListEl.classList.toggle('has-files', files.length > 0);
    fileListEl.classList.toggle('is-hidden', files.length === 0);
    const maxFiles = maxBookingMediaFilesAllowed();
    if (uploadHint) {
        if (files.length > maxFiles || totalBookingAttachments() > MAX_BOOKING_ATTACHMENTS) {
            uploadHint.textContent = `Maximum ${MAX_BOOKING_ATTACHMENTS} attachments (files and skin analysis combined).`;
            uploadHint.classList.remove('is-hidden');
        } else {
            uploadHint.classList.add('is-hidden');
        }
    }
    files.forEach((file, i) => {
        const li = document.createElement('li');
        li.className = 'booking-file-item';
        const name = file.name || 'File ' + (i + 1);
        let sizeStr = '';
        if (file.size) {
            if (file.size < 1024) sizeStr = file.size + ' B';
            else if (file.size < 1024 * 1024) sizeStr = (file.size / 1024).toFixed(1) + ' KB';
            else sizeStr = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
        }
        const icon = (file.type || '').includes('image') ? 'fa-file-image-o'
            : ((file.type || '').includes('video') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name || '')) ? 'fa-file-video-o'
                : 'fa-file-pdf-o';
        li.innerHTML = '<i class="fa ' + icon + '" aria-hidden="true"></i><span class="booking-file-name" title="' + name.replace(/"/g, '&quot;') + '">' + name + '</span><span class="booking-file-size">' + sizeStr + '</span><button type="button" class="booking-file-remove" data-index="' + i + '" aria-label="Remove file"><i class="fa fa-times" aria-hidden="true"></i></button>';
        fileListEl.appendChild(li);
    });
    const addMoreWrap = $('booking-add-more-wrap');
    if (addMoreWrap) {
        addMoreWrap.classList.toggle('is-hidden', files.length === 0 || files.length >= maxFiles);
    }
    if (uploadZone) {
        uploadZone.classList.toggle('booking-upload-zone--has-files', files.length > 0);
    }
}
function removeFile(index) {
    if (index < 0 || index >= bookingMediaFiles.length) return;
    bookingMediaFiles.splice(index, 1);
    syncFileInputFromBookingMedia();
    updateFileList();
}

// Save files to IndexedDB for retrieval on payment page. Returns the storage key.
function saveBookingMediaToIndexedDB(files) {
    return new Promise((resolve, reject) => {
        if (!files?.length) { resolve(null); return; }
        const key = 'televet_media_' + Date.now();
        const request = indexedDB.open(BOOKING_MEDIA_DB, 1);
        request.onerror = () => reject(new Error('Could not save files for payment.'));
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(BOOKING_MEDIA_STORE)) {
                db.createObjectStore(BOOKING_MEDIA_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(BOOKING_MEDIA_STORE, 'readwrite');
            const store = tx.objectStore(BOOKING_MEDIA_STORE);
            store.put({ key, files: Array.from(files) });
            tx.oncomplete = () => { db.close(); resolve(key); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        };
    });
}

function formatTimeDisplay(timeVal, slotEnd, dateStr) {
    if (!timeVal) {
        if (dateStr) {
            try {
                const d = new Date(dateStr + 'T12:00:00');
                return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' (consultation)';
            } catch (_) {}
        }
        return CLINIC_HOURS_PLACEHOLDER;
    }
    const timeDisplay = formatTime12h(timeVal) + (slotEnd ? ' - ' + formatTime12h(slotEnd) : '');
    if (dateStr) {
        try {
            const d = new Date(dateStr + 'T' + timeVal);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + timeDisplay;
        } catch (_) {}
    }
    return timeDisplay;
}

// Tabs
function switchToTab(tabKey) {
    const tab = document.querySelector(`.appointments-tab[data-tab="${tabKey}"]`);
    if (!tab) return;
    document.querySelectorAll('.appointments-tab').forEach((tb) => {
        tb.classList.toggle('active', tb === tab);
        tb.setAttribute('aria-selected', tb === tab ? 'true' : 'false');
    });
    document.querySelectorAll('.appointments-tab-panel').forEach((p) => {
        const visible = p.id === `panel-${tabKey}`;
        p.classList.toggle('is-hidden', !visible);
        p.setAttribute('aria-hidden', visible ? 'false' : 'true');
        if (visible) {
            p.classList.remove('is-entering');
            void p.offsetWidth;
            p.classList.add('is-entering');
        } else {
            p.classList.remove('is-entering');
        }
    });
}

document.querySelectorAll('.appointments-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        const t = tab.getAttribute('data-tab');
        switchToTab(t);
    });
});

// Session-ended redirect uses tab=history; also accept tab=completed
const urlParams = new URLSearchParams(window.location.search);
const tabParam = urlParams.get('tab');
if (tabParam === 'history' || tabParam === 'completed') {
    switchToTab('completed');
} else if (tabParam === 'all') {
    switchToTab('all');
}

document.addEventListener('click', (e) => {
    if (e.target?.closest?.('#book-appointment-btn')) { e.preventDefault(); openModal(); }
});
closeBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay?.classList.contains('is-open')) closeModal();
});

if (bookingVetDropdown) window._onVetChange = onVetChange;
bookingDate?.addEventListener('change', onDateChange);

const onFieldInteraction = (e) => e.target?.closest('.booking-form-group')?.classList.remove('has-error');
form?.querySelectorAll('#booking-title, #booking-pet-dropdown, #booking-vet-dropdown, #booking-reason, #booking-date, #booking-time').forEach((el) => {
    if (el) {
        el.addEventListener('change', onFieldInteraction);
        el.addEventListener('input', onFieldInteraction);
        el.addEventListener('click', onFieldInteraction);
    }
});

if (uploadZone && fileInput) {
    uploadZone.addEventListener('click', (e) => {
        if (e.target.closest('.booking-file-remove')) return;
        e.preventDefault();
        fileInput.click();
    });
    uploadZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('is-dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('is-dragover');
        if (e.dataTransfer?.files?.length) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                if (isAllowedBookingMediaFile(f)) bookingMediaFiles.push(f);
            }
            bookingMediaFiles = bookingMediaFiles.slice(0, maxBookingMediaFilesAllowed());
            syncFileInputFromBookingMedia();
            updateFileList();
        }
    });
}
if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (ignoreFileInputChange) return;
        const newFiles = Array.from(fileInput.files || []).filter(isAllowedBookingMediaFile);
        bookingMediaFiles = bookingMediaFiles.concat(newFiles).slice(0, maxBookingMediaFilesAllowed());
        syncFileInputFromBookingMedia();
        updateFileList();
    });
}
fileListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.booking-file-remove');
    if (btn?.dataset.index != null) removeFile(parseInt(btn.dataset.index, 10));
});
const addMoreBtn = $('booking-add-more-btn');
if (addMoreBtn && fileInput) {
    addMoreBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
}

// Details modal
const detailsOverlay = $('details-modal-overlay');
const detailsModalEl = $('details-modal');
const detailsClose = $('details-modal-close');
const detailsDownloadPdfBtn = $('details-download-pdf-btn');
const detailsMessageBtn = $('details-message-btn');
const detailsJoinBtn = $('details-join-btn');
let currentDetailsApt = null;
let detailsJoinCheckTimer = null;

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
    if (detailsJoinCheckTimer) {
        clearInterval(detailsJoinCheckTimer);
        detailsJoinCheckTimer = null;
    }
    if (detailsOverlay && document.activeElement && detailsOverlay.contains(document.activeElement)) {
        document.activeElement.blur();
    }
    if (detailsOverlay) {
        detailsOverlay.classList.remove('is-open');
        detailsOverlay.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
}
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
document.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('.appointment-view-btn');
    if (!btn?.dataset.id) return;
    e.preventDefault();
    const aptId = btn.dataset.id;
    const appointments = window._appointmentsCache || [];
    const apt = appointments.find((a) => a.id === aptId);
    if (!apt) return;
    const aptSkin = await enrichAppointmentAttachedSkinFromHistory(apt);
    renderDetailsAttachedSkin(aptSkin);
    const titleEl = $('details-title');
    titleEl.textContent = (apt.title?.trim()) ? apt.title.trim() : '-';
    titleEl.classList.toggle('is-empty', !apt.title?.trim());
    $('details-vet-name').textContent = apt.vetName ? formatDisplayName(apt.vetName) : '-';
    $('details-date').textContent = formatAppointmentDate(apt.date || apt.dateStr);
    $('details-time').textContent = getAppointmentTimeDisplay(apt);
    const payRow = $('details-payment');
    if (payRow) payRow.textContent = apt.paid === true ? 'Paid' : '-';
    $('details-concern').textContent = (apt.reason?.trim()) ? apt.reason.trim() : '-';
    $('details-appointment-id').textContent = aptId || '-';
    const mediaUrls = apt.mediaUrls && Array.isArray(apt.mediaUrls) ? apt.mediaUrls : [];
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
                img.src = url;
                img.alt = `Shared image ${idx + 1}`;
                img.className = 'details-shared-image-thumb';
                img.loading = 'lazy';
                img.onload = () => img.classList.add('is-loaded');
                btn.appendChild(img);
                item.appendChild(btn);
            }
            listEl.appendChild(item);
        });
    }
    const vetImg = $('details-vet-img');
    const vetFallback = $('details-vet-avatar-fallback');
    if (vetImg) {
        vetImg.style.display = 'none';
        vetImg.setAttribute('aria-hidden', 'true');
        vetImg.src = '';
        vetImg.alt = apt.vetName ? formatDisplayName(apt.vetName) : 'Vet';
    }
    if (vetFallback) vetFallback.classList.add('visible');
    loadVetProfile(apt.vetId).then((vet) => {
        if (vet?.photoURL && vetImg) {
            vetImg.style.opacity = '0';
            vetImg.style.transition = 'opacity 0.35s ease';
            vetImg.onload = () => {
                requestAnimationFrame(() => { vetImg.style.opacity = '1'; });
                vetImg.setAttribute('aria-hidden', 'false');
                if (vetFallback) vetFallback.classList.remove('visible');
            };
            vetImg.onerror = () => {
                vetImg.setAttribute('aria-hidden', 'true');
                vetImg.style.display = 'none';
                if (vetFallback) vetFallback.classList.add('visible');
            };
            vetImg.src = vet.photoURL;
            vetImg.style.display = '';
        }
    });
    const petImg = $('details-pet-img');
    const petFallback = $('details-pet-avatar-fallback');
    const petAvatarWrap = $('details-pet-avatar-wrap');
    if (petImg) {
        petImg.style.display = 'none';
        petImg.setAttribute('aria-hidden', 'true');
        petImg.src = '';
        petImg.alt = apt.petName ? formatDisplayName(apt.petName) : 'Pet';
    }
    if (petFallback) {
        petFallback.classList.add('visible');
        petFallback.innerHTML = (apt.petSpecies || '').toLowerCase() === 'cat' ? '<i class="fa-solid fa-cat" aria-hidden="true"></i>' : '<i class="fa fa-paw" aria-hidden="true"></i>';
    }
    if (petAvatarWrap) petAvatarWrap.classList.toggle('details-pet-avatar-wrap--cat', (apt.petSpecies || '').toLowerCase() === 'cat');
    $('details-pet-name').textContent = apt.petName ? formatDisplayName(apt.petName) : '-';
    $('details-pet-age').textContent = '-';
    $('details-pet-weight').textContent = '-';
    const initSp = (apt.petSpecies || '').trim();
    $('details-pet-species').textContent = initSp ? initSp.charAt(0).toUpperCase() + initSp.slice(1).toLowerCase() : '-';
    if (auth.currentUser) {
        loadPets(auth.currentUser.uid).then((pets) => {
            const pet = pets.find((p) => p.id === apt.petId);
            if (pet) {
                $('details-pet-age').textContent = formatPetAge(pet.age);
                $('details-pet-weight').textContent = formatPetWeight(pet.weight);
                const sp = (pet.species || apt.petSpecies || '').trim();
                $('details-pet-species').textContent = sp ? sp.charAt(0).toUpperCase() + sp.slice(1).toLowerCase() : '-';
                if (pet.imageUrl && petImg) {
                    petImg.style.opacity = '0';
                    petImg.style.transition = 'opacity 0.35s ease';
                    petImg.onload = () => {
                        requestAnimationFrame(() => { petImg.style.opacity = '1'; });
                        petImg.setAttribute('aria-hidden', 'false');
                        if (petFallback) petFallback.classList.remove('visible');
                    };
                    petImg.onerror = () => {
                        petImg.setAttribute('aria-hidden', 'true');
                        petImg.style.display = 'none';
                        if (petFallback) petFallback.classList.add('visible');
                    };
                    petImg.src = pet.imageUrl;
                    petImg.style.display = '';
                }
                if (petFallback && (pet.species || '').toLowerCase() === 'cat') petFallback.innerHTML = '<i class="fa-solid fa-cat" aria-hidden="true"></i>';
            }
        });
    }
    currentDetailsApt = apt;
    if (detailsDownloadPdfBtn) {
        detailsDownloadPdfBtn.classList.add('is-hidden');
        detailsDownloadPdfBtn.setAttribute('hidden', '');
    }
    if (detailsJoinBtn) {
        detailsJoinBtn.classList.add('is-loading-video-status');
        detailsJoinBtn.disabled = true;
        detailsJoinBtn.setAttribute('aria-disabled', 'true');
        detailsJoinBtn.title = 'Checking call status...';
        detailsJoinBtn.innerHTML = '<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">Loading...</span>';
        detailsJoinBtn.classList.add('is-past');
    }
    getDoc(doc(db, 'appointments', apt.id, 'videoCall', 'room')).then((videoSnap) => {
        const videoCall = videoSnap.exists() ? videoSnap.data() : null;
        detailsJoinBtn?.classList.remove('is-loading-video-status');
        updateDetailsJoinButton(apt, videoCall);
    }).catch(() => {
        detailsJoinBtn?.classList.remove('is-loading-video-status');
        updateDetailsJoinButton(apt, null);
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
});
detailsClose?.addEventListener('click', closeDetailsModal);
detailsDownloadPdfBtn?.addEventListener('click', () => {
    if (!currentDetailsApt?.id) return;
    downloadConsultationReportForAppointment(currentDetailsApt.id, detailsDownloadPdfBtn);
});
detailsMessageBtn?.addEventListener('click', () => {
    const vetId = currentDetailsApt?.vetId || currentDetailsApt?.vetID || '';
    const petId = currentDetailsApt?.petId || currentDetailsApt?.petID || '';
    if (!vetId || !petId) return;
    closeDetailsModal();
    const params = new URLSearchParams({
        vetId,
        petId,
    });
    if (currentDetailsApt?.id) params.set('appointmentId', currentDetailsApt.id);
    if (currentDetailsApt.petName) params.set('petName', currentDetailsApt.petName);
    if (currentDetailsApt.vetName) params.set('vetName', currentDetailsApt.vetName);
    const messagesUrl = `messages.html?${params.toString()}`;
    if (!window.__spaNavigate || !window.__spaNavigate(messagesUrl)) window.location.href = messagesUrl;
});
detailsOverlay?.addEventListener('click', (e) => { if (e.target === detailsOverlay) closeDetailsModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailsOverlay?.classList.contains('is-open')) closeDetailsModal();
});
detailsJoinBtn?.addEventListener('click', () => {
    if (!currentDetailsApt || detailsJoinBtn.disabled) return;
    window.location.href = `video-call.html?appointmentId=${currentDetailsApt.id}`;
});

// Details media lightbox (click to enlarge, no new tab)
function initDetailsMediaLightbox() {
    const lb = $('details-media-lightbox');
    const lbImg = lb?.querySelector('.details-media-lightbox-img');
    const lbVideo = lb?.querySelector('.details-media-lightbox-video');
    const lbIframe = lb?.querySelector('.details-media-lightbox-iframe');
    const closeBtn = lb?.querySelector('.details-media-lightbox-close');
    const backdrop = lb?.querySelector('.details-media-lightbox-backdrop');
    const listEl = $('details-shared-images-list');

    const closeLB = () => {
        if (!lb) return;
        if (lbVideo) {
            lbVideo.pause();
            lbVideo.removeAttribute('src');
            lbVideo.load?.();
        }
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = (detailsOverlay?.classList.contains('is-open') ? 'hidden' : '');
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
                lbImg.src = url;
                lbImg.classList.remove('is-hidden');
                lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
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
        if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) {
            closeLB();
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
    listEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('.details-shared-image-link, .details-shared-file-link, .details-shared-video-link');
        if (!btn?.dataset?.url) return;
        e.preventDefault();
        const kind = btn.dataset.mediaKind || (btn.dataset.isImage === 'true' ? 'image' : 'pdf');
        openLB(btn.dataset.url, kind);
    });
    const skinInner = $('details-attached-skin-inner');
    skinInner?.addEventListener('click', (e) => {
        const thumbBtn = e.target.closest('.details-attached-skin-img-btn');
        const url = thumbBtn?.dataset?.skinFullImageUrl || thumbBtn?.querySelector('.details-attached-skin-thumb')?.src;
        if (!url) return;
        e.preventDefault();
        openLB(url, 'image');
    });
}
initDetailsMediaLightbox();

function hideAppointmentsLoading() {
    if (!appointmentsLoading || appointmentsLoading.classList.contains('is-hidden')) return;
    appointmentsLoading.classList.add('is-fading-out');
    setTimeout(() => {
        appointmentsLoading.setAttribute('aria-hidden', 'true');
        appointmentsLoading.classList.add('is-hidden');
        appointmentsLoading.classList.remove('is-fading-out');
    }, 350);
}

/**
 * Resolve the signed-in user for this page without hanging forever.
 * On some mobile browsers, awaiting auth.authStateReady() inside onAuthStateChanged can stall
 * (IndexedDB / persistence), which left the appointments spinner running indefinitely.
 */
async function resolveUserForAppointments(userFromCallback) {
    if (userFromCallback) return userFromCallback;
    const maxMs = 10000;
    await Promise.race([
        auth.authStateReady(),
        new Promise((resolve) => setTimeout(resolve, maxMs)),
    ]);
    return auth.currentUser;
}

// Auth & subscriptions
onAuthStateChanged(auth, async (userFromCallback) => {
    if (typeof window._appointmentsUnsub === 'function') {
        window._appointmentsUnsub();
        window._appointmentsUnsub = null;
    }
    const user = await resolveUserForAppointments(userFromCallback);
    if (!user) {
        hideAppointmentsLoading();
        renderUpcomingPanel(upcomingRoot, []);
        renderCompletedPanel(completedRoot, []);
        renderAllAppointmentsPanel(allAppointmentsRoot, []);
        return;
    }
    const callback = (appointments) => {
        window._appointmentsCache = appointments;
        hideAppointmentsLoading();
        renderUpcomingPanel(upcomingRoot, appointments);
        renderCompletedPanel(completedRoot, appointments);
        renderAllAppointmentsPanel(allAppointmentsRoot, appointments);
    };
    const unsub = subscribeAppointments(user.uid, callback);
    window._appointmentsUnsub = unsub;

    Promise.all([loadVets(), loadPets(user.uid)]).then(([vets, pets]) => {
        cachedVetsList = Array.isArray(vets) ? vets : [];
        cachedPetsList = Array.isArray(pets) ? pets : [];
        populateVetSelect($('booking-vet-dropdown'), vets);
        populatePetSelect($('booking-pet-dropdown'), pets);
        const petHint = $('booking-pet-hint');
        if (petHint) petHint.classList.toggle('is-hidden', pets.length > 0);
        window._bookingPetsCount = pets.length;
        updateConfirmButtonState();
    }).catch((err) => {
        console.error('Load vets/pets for appointment page:', err);
        cachedVetsList = [];
        cachedPetsList = [];
        populateVetSelect($('booking-vet-dropdown'), []);
        populatePetSelect($('booking-pet-dropdown'), []);
        window._bookingPetsCount = 0;
        updateConfirmButtonState();
    });
});

// Last resort if Firestore and timers never complete (extreme throttling / broken transport).
const APPOINTMENTS_LOADING_FALLBACK_MS = 25000;
setTimeout(() => {
    if (!appointmentsLoading || appointmentsLoading.classList.contains('is-hidden')) return;
    console.warn('Appointments: loading UI fallback - hiding spinner.');
    hideAppointmentsLoading();
    if (!window._appointmentsCache) {
        renderUpcomingPanel(upcomingRoot, []);
        renderCompletedPanel(completedRoot, []);
        renderAllAppointmentsPanel(allAppointmentsRoot, []);
    }
}, APPOINTMENTS_LOADING_FALLBACK_MS);

// TEST-ONLY (REMOVE AFTER QA): one click == booked, no payment redirect
testBookBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) { showFormError('You must be signed in.'); return; }

    try {
        testBookBtn.disabled = true;
        const labelEl = testBookBtn.querySelector('span');
        if (labelEl) labelEl.textContent = 'Booking test...';

        if (!validateAndHighlightFields()) { showFormError(''); return; }
        clearFieldErrors();
        showFormError('');

        const petSelect = $('booking-pet');
        const vetSelect = $('booking-vet');
        const reasonEl = $('booking-reason');
        const titleEl = $('booking-title');
        const petId = petSelect?.value;
        const petName = petSelect?.dataset?.petName || '';
        const petSpecies = petSelect?.dataset?.species || '';
        const vetId = vetSelect?.value;
        const reason = reasonEl?.value?.trim();
        const title = titleEl?.value?.trim();
        const vetOpt = vetId ? getVetOption(vetId) : null;
        const vetName = vetOpt?.name || vetSelect?.dataset?.vetName || '';
        const clinicName = vetOpt?.clinic || vetSelect?.dataset?.clinic || '';
        const dateStr = bookingDate?.value || '';
        const timeVal = bookingTime?.value || '';
        const timeOpt = bookingTime?.options?.[bookingTime.selectedIndex];
        const slotEnd = timeOpt?.dataset?.slotEnd || null;
        const timeDisplay = formatTimeDisplay(timeVal, slotEnd, dateStr);

        if (vetId && dateStr && timeVal) {
            const check = await checkSlotAvailability(vetId, dateStr, timeVal, user.uid);
            if (!check.available) {
                const msg = check.reason === 'owner_overlap'
                    ? "You already have an appointment at this time. Please choose another slot."
                    : "I'm sorry, this slot is no longer available. It's either deleted or already booked.";
                showFormError(msg);
                return;
            }
        }

        // Use attachments exactly like the payment flow, but upload now (no redirect).
        syncFileInputFromBookingMedia();
        const mediaFiles = bookingMediaFiles.length ? bookingMediaFiles : (fileInput?.files ? Array.from(fileInput.files) : []);

        await createAppointment({
            title,
            petId,
            petName,
            petSpecies: petSpecies || '',
            vetId,
            vetName,
            clinicName,
            reason,
            dateStr,
            timeDisplay,
            slotStart: timeVal || null,
            slotEnd: slotEnd || null,
            mediaFiles,
            ...(bookingAttachedSkinSnapshot ? { attachedSkinAnalysis: bookingAttachedSkinSnapshot } : {}),
        });

        closeModal();
        resetBookingFormState();
        showBookingAppToast('Test appointment booked (no payment).');
    } catch (err) {
        showFormError(err?.message || 'Test booking failed. Please try again.');
    } finally {
        if (testBookBtn) {
            testBookBtn.disabled = (window._bookingPetsCount ?? 0) === 0;
            const labelEl = testBookBtn.querySelector('span');
            if (labelEl) labelEl.textContent = 'Book test (no payment)';
        }
    }
});

// Form submit
form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const petSelect = $('booking-pet');
    const vetSelect = $('booking-vet');
    const reasonEl = $('booking-reason');
    const titleEl = $('booking-title');
    const petId = petSelect?.value;
    const petName = petSelect?.dataset?.petName || '';
    const vetId = vetSelect?.value;
    const reason = reasonEl?.value?.trim();
    const title = titleEl?.value?.trim();
    const vetOpt = vetId ? getVetOption(vetId) : null;
    const vetName = vetOpt?.name || vetSelect?.dataset?.vetName || '';
    const clinicName = vetOpt?.clinic || vetSelect?.dataset?.clinic || '';
    const dateStr = bookingDate?.value || '';
    const timeVal = bookingTime?.value || '';
    const timeOpt = bookingTime?.options?.[bookingTime.selectedIndex];
    const slotEnd = timeOpt?.dataset?.slotEnd || null;
    const timeDisplay = formatTimeDisplay(timeVal, slotEnd, dateStr);

    if (!validateAndHighlightFields()) { showFormError(''); return; }
    clearFieldErrors();
    showFormError('');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.querySelector('.booking-confirm-text').textContent = 'Checking availability...';
    }
    try {
        if (vetId && dateStr && timeVal) {
            const ownerId = auth.currentUser?.uid || null;
            const check = await checkSlotAvailability(vetId, dateStr, timeVal, ownerId);
            if (!check.available) {
                const msg = check.reason === 'owner_overlap'
                    ? "You already have an appointment at this time. Please choose another slot."
                    : "I'm sorry, this slot is no longer available. It's either deleted or already booked.";
                showFormError(msg);
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.querySelector('.booking-confirm-text').textContent = 'Confirm booking';
                }
                return;
            }
        }
        if (confirmBtn) confirmBtn.querySelector('.booking-confirm-text').textContent = 'Saving files...';
        const petSpecies = petSelect?.dataset?.species || '';
        syncFileInputFromBookingMedia();
        const mediaFiles = bookingMediaFiles.length ? bookingMediaFiles : (fileInput?.files ? Array.from(fileInput.files) : []);
        let mediaKey = null;
        if (mediaFiles.length > 0) {
            try {
                mediaKey = await saveBookingMediaToIndexedDB(mediaFiles);
            } catch (err) {
                showFormError('Could not save your files. Please try again.');
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.querySelector('.booking-confirm-text').textContent = 'Confirm booking'; }
                return;
            }
        }
        if (confirmBtn) confirmBtn.querySelector('.booking-confirm-text').textContent = 'Booking consultation...';
        const vetFeeSettings = await loadVetSettings(vetId);
        const booking = {
            title,
            petId,
            petName,
            petSpecies: petSpecies || '',
            vetId,
            vetName,
            clinicName,
            reason,
            dateStr,
            timeDisplay,
            slotStart: timeVal || null,
            slotEnd: slotEnd || null,
            amountCentavosTest: vetFeeSettings.consultationPriceCentavosTest,
            amountCentavosLive: vetFeeSettings.consultationPriceCentavosLive,
            amountCentavos: vetFeeSettings.consultationPriceCentavosTest,
            mediaKey: mediaKey || undefined,
            ...(bookingAttachedSkinSnapshot ? { attachedSkinAnalysis: bookingAttachedSkinSnapshot } : {}),
        };
        sessionStorage.setItem('televet_booking', JSON.stringify(booking));
        closeModal();
        resetBookingFormState();
        const payUrl = 'payment.html?booking=1';
        if (!window.__spaNavigate || !window.__spaNavigate(payUrl)) window.location.href = payUrl;
    } catch (err) {
        showFormError(err?.message || 'Failed to continue. Please try again.');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.querySelector('.booking-confirm-text').textContent = 'Confirm booking';
        }
    }
});

(function initBookingSkinAttachUi() {
    $('booking-skin-attach-remove')?.addEventListener('click', () => {
        clearBookingSkinAttachment();
        showBookingAppToast('Attachment removed.');
    });
    const skinOv = $('booking-skin-overlay');
    $('booking-skin-attach-btn')?.addEventListener('click', async () => {
        const user = auth.currentUser;
        if (!user) return;
        const listEl = $('booking-skin-modal-list');
        const emptyEl = $('booking-skin-modal-empty');
        if (!skinOv || !listEl) return;
        skinOv.classList.add('is-open');
        skinOv.setAttribute('aria-hidden', 'false');
        listEl.innerHTML = '<li class="booking-skin-loading">Loading…</li>';
        emptyEl?.classList.add('is-hidden');
        try {
            const rows = await listSkinAnalyses(user.uid);
            listEl.innerHTML = '';
            if (!rows.length) {
                emptyEl?.classList.remove('is-hidden');
                if (emptyEl) emptyEl.textContent = 'No saved analyses yet. Save one from Skin Health Analysis first.';
            } else {
                rows.forEach((row) => {
                    const li = document.createElement('li');
                    li.className = 'booking-skin-picker-item';
                    const ms = savedAtToMs(row.savedAt);
                    const dateStr = ms
                        ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                        : '';
                    const conf = typeof row.confidence === 'number' ? row.confidence : 0;
                    const imgUrl = row.imageUrl ? escapeHtml(String(row.imageUrl)) : '';
                    const savedName = (row.savedName && String(row.savedName).trim()) || '';
                    const condEsc = escapeHtml(String(row.conditionName || '—'));
                    const titleEsc = escapeHtml(savedName || String(row.conditionName || '—'));
                    const metaLine = savedName
                        ? `${condEsc} · ${(conf * 100).toFixed(1)}% · ${escapeHtml(dateStr)}`
                        : `${(conf * 100).toFixed(1)}% · ${escapeHtml(dateStr)}`;
                    li.innerHTML = `<button type="button" class="booking-skin-picker-btn">
                            ${imgUrl ? `<span class="booking-skin-picker-thumb-wrap"><img src="${imgUrl}" alt="" width="48" height="48"></span>` : '<span class="booking-skin-picker-thumb-wrap"><i class="fa fa-image" aria-hidden="true"></i></span>'}
                            <span class="booking-skin-picker-text"><strong>${titleEsc}</strong><span class="booking-skin-picker-meta">${metaLine}</span></span>
                        </button>`;
                    li.querySelector('.booking-skin-picker-btn')?.addEventListener('click', async () => {
                        if (bookingMediaFiles.length >= MAX_BOOKING_ATTACHMENTS) {
                            showBookingAppToast(`Maximum ${MAX_BOOKING_ATTACHMENTS} attachments. Remove a file to attach skin analysis.`);
                            return;
                        }
                        let rec = { ...row, id: row.id };
                        let snap = skinAnalysisToShareSnapshot(rec);
                        if (skinAnalysisSavedAtToMs(snap) == null && row.id) {
                            try {
                                const docSnap = await getDoc(doc(db, 'users', user.uid, SKIN_ANALYSES_COLLECTION, row.id));
                                if (docSnap.exists()) {
                                    rec = { id: row.id, ...docSnap.data() };
                                    snap = skinAnalysisToShareSnapshot(rec);
                                }
                            } catch (_) {
                                // use list row snapshot
                            }
                        }
                        bookingAttachedSkinSnapshot = snap;
                        const prev = $('booking-skin-attach-preview');
                        const txt = $('booking-skin-attach-preview-text');
                        const previewLabel = (snap.savedName && String(snap.savedName).trim()) || snap.conditionName || 'Analysis';
                        if (txt) txt.textContent = String(previewLabel);
                        prev?.classList.remove('is-hidden');
                        skinOv.classList.remove('is-open');
                        skinOv.setAttribute('aria-hidden', 'true');
                        updateFileList();
                        showBookingAppToast('Analysis attached to this booking.');
                    });
                    listEl.appendChild(li);
                });
            }
        } catch (err) {
            console.error('Booking skin list:', err);
            listEl.innerHTML = '<li class="booking-skin-loading">Could not load analyses.</li>';
        }
    });
    const closeSkin = () => {
        skinOv?.classList.remove('is-open');
        skinOv?.setAttribute('aria-hidden', 'true');
    };
    $('booking-skin-modal-close')?.addEventListener('click', closeSkin);
    skinOv?.addEventListener('click', (e) => {
        if (e.target === skinOv) closeSkin();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (skinOv?.classList.contains('is-open')) closeSkin();
    });
})();
