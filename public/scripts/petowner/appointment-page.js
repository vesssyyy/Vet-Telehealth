/**
 * Pet Owner Appointment page: tabs, booking modal, details modal, form submit.
 */
import {
    loadPets,
    loadVets,
    loadVetProfile,
    populatePetSelect,
    populateVetSelect,
    subscribeAppointments,
    renderUpcomingPanel,
    renderHistoryPanel,
    getVetOption,
    getAvailableDatesAndSlots,
    checkSlotAvailability,
    formatAppointmentDate,
    getAppointmentTimeDisplay,
    CLINIC_HOURS_PLACEHOLDER,
} from './appointment-manager.js';
import { auth, db } from '../core/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { formatTime12h } from '../core/utils.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { isWithinAppointmentTime, getJoinAvailableLabel, isVideoSessionEnded, isConsultationPdfAvailable } from '../core/video-call-utils.js';
import { downloadConsultationReportForAppointment } from '../core/consultation-pdf-download.js';

const $ = (id) => document.getElementById(id);
const overlay = $('booking-modal-overlay');
const modal = $('booking-modal');
const closeBtn = $('booking-modal-close');
const cancelBtn = $('booking-cancel-btn');
const form = $('booking-form');
const confirmBtn = $('booking-confirm-btn');
const formError = $('booking-form-error');
const appointmentsLoading = $('appointments-loading');
const upcomingRoot = $('upcoming-appointments-root');
const historyRoot = $('history-appointments-root');
const bookingDate = $('booking-date');
const bookingTime = $('booking-time');
const bookingVet = $('booking-vet');
const bookingVetDropdown = $('booking-vet-dropdown');
const uploadZone = $('booking-upload-zone');
const fileInput = $('booking-media');
const fileListEl = $('booking-file-list');
const uploadHint = $('booking-upload-hint');

const MIN_MEDIA_FILES = 0;
const MAX_MEDIA_FILES = 3;
const BOOKING_MEDIA_DB = 'televet_booking_media';
const BOOKING_MEDIA_STORE = 'files';

let cachedAvailability = { dates: [], slotsByDate: {} };
/** Persisted list so "Add more" stacks files instead of replacing. */
let bookingMediaFiles = [];
let ignoreFileInputChange = false;

function syncFileInputFromBookingMedia() {
    if (!fileInput) return;
    ignoreFileInputChange = true;
    const dt = new DataTransfer();
    bookingMediaFiles.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
    ignoreFileInputChange = false;
}

function openModal() {
    if (!overlay || !modal) return;
    clearFieldErrors();
    showFormError('');
    bookingMediaFiles = [];
    syncFileInputFromBookingMedia();
    if (fileListEl) { fileListEl.classList.add('is-hidden'); fileListEl.innerHTML = ''; }
    if (uploadZone) uploadZone.classList.remove('booking-upload-zone--has-files');
    const addMoreWrap = $('booking-add-more-wrap');
    if (addMoreWrap) addMoreWrap.classList.add('is-hidden');
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
    const reasonInput = $('booking-reason');
    const dateEl = $('booking-date');
    const timeEl = $('booking-time');
    const petVal = petInput?.value;
    const petNameVal = petInput?.dataset?.petName;
    const vetVal = vetInput?.value;
    const vetNameVal = vetInput?.dataset?.vetName;
    const reasonVal = reasonInput?.value?.trim();
    const dateVal = dateEl?.value;
    const timeVal = timeEl?.value;
    const fileCount = fileInput?.files?.length ?? 0;
    let hasError = false;
    if (!petVal || !petNameVal) { setFieldError($('booking-pet-dropdown')); hasError = true; }
    if (!vetVal || !vetNameVal) { setFieldError($('booking-vet-dropdown')); hasError = true; }
    if (!reasonVal) { setFieldError(reasonInput); hasError = true; }
    if (!dateVal || !timeVal) {
        if (!dateVal) setFieldError(dateEl);
        if (!timeVal) setFieldError(timeEl);
        hasError = true;
    }
    if (fileCount > MAX_MEDIA_FILES) {
        setFieldError(uploadZone);
        if (uploadHint) { uploadHint.textContent = `Maximum ${MAX_MEDIA_FILES} files. Remove ${fileCount - MAX_MEDIA_FILES} file(s).`; uploadHint.classList.remove('is-hidden'); }
        hasError = true;
    } else if (uploadHint) uploadHint.classList.add('is-hidden');
    return !hasError;
}

function formatDisplayDate(dateStr) {
    if (!dateStr) return '—';
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
    if (bookingDate) bookingDate.innerHTML = '<option value="">Loading availability…</option>';
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
    const fileCount = fileInput?.files?.length ?? 0;
    if (confirmBtn) confirmBtn.disabled = petCount === 0 || fileCount > MAX_MEDIA_FILES;
}

function updateFileList() {
    const files = fileInput?.files ? Array.from(fileInput.files) : [];
    updateConfirmButtonState();
    if (!fileListEl) return;
    fileListEl.innerHTML = '';
    fileListEl.classList.toggle('has-files', files.length > 0);
    fileListEl.classList.toggle('is-hidden', files.length === 0);
    if (uploadHint) {
        if (files.length > MAX_MEDIA_FILES) {
            uploadHint.textContent = `Maximum ${MAX_MEDIA_FILES} files.`;
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
        const icon = (file.type || '').includes('image') ? 'fa-file-image-o' : 'fa-file-pdf-o';
        li.innerHTML = '<i class="fa ' + icon + '" aria-hidden="true"></i><span class="booking-file-name" title="' + name.replace(/"/g, '&quot;') + '">' + name + '</span><span class="booking-file-size">' + sizeStr + '</span><button type="button" class="booking-file-remove" data-index="' + i + '" aria-label="Remove file"><i class="fa fa-times" aria-hidden="true"></i></button>';
        fileListEl.appendChild(li);
    });
    const addMoreWrap = $('booking-add-more-wrap');
    if (addMoreWrap) {
        addMoreWrap.classList.toggle('is-hidden', files.length === 0 || files.length >= MAX_MEDIA_FILES);
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

/** Save files to IndexedDB for retrieval on payment page. Returns the storage key. */
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
    const timeDisplay = formatTime12h(timeVal) + (slotEnd ? ' \u2013 ' + formatTime12h(slotEnd) : '');
    if (dateStr) {
        try {
            const d = new Date(dateStr + 'T' + timeVal);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + timeDisplay;
        } catch (_) {}
    }
    return timeDisplay;
}

/* Tabs */
function switchToTab(tabKey) {
    const tab = document.querySelector(`.appointments-tab[data-tab="${tabKey}"]`);
    if (!tab) return;
    document.querySelectorAll('.appointments-tab').forEach((tb) => {
        tb.classList.toggle('active', tb === tab);
        tb.setAttribute('aria-selected', tb === tab ? 'true' : 'false');
    });
    document.querySelectorAll('.appointments-tab-panel').forEach((p) => {
        p.classList.toggle('is-hidden', p.id !== 'panel-' + tabKey);
    });
}

document.querySelectorAll('.appointments-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        const t = tab.getAttribute('data-tab');
        switchToTab(t);
    });
});

// If redirected from session-ended (e.g. ?tab=history), open History tab
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('tab') === 'history') {
    switchToTab('history');
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
form?.querySelectorAll('#booking-pet-dropdown, #booking-vet-dropdown, #booking-reason, #booking-date, #booking-time').forEach((el) => {
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
                if ((f.type?.includes('image')) || (f.name?.toLowerCase().endsWith('.pdf'))) bookingMediaFiles.push(f);
            }
            bookingMediaFiles = bookingMediaFiles.slice(0, MAX_MEDIA_FILES);
            syncFileInputFromBookingMedia();
            updateFileList();
        }
    });
}
if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (ignoreFileInputChange) return;
        const newFiles = Array.from(fileInput.files || []);
        bookingMediaFiles = bookingMediaFiles.concat(newFiles).slice(0, MAX_MEDIA_FILES);
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

/* Details modal */
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
    const sessionEnded = videoCall?.status === 'ended' || isVideoSessionEnded(apt);
    const within = !sessionEnded && isWithinAppointmentTime(apt);
    detailsJoinBtn.disabled = sessionEnded || !within;
    detailsJoinBtn.setAttribute('aria-disabled', detailsJoinBtn.disabled ? 'true' : 'false');
    const label = getJoinAvailableLabel(apt, videoCall);
    detailsJoinBtn.title = label;
    detailsJoinBtn.innerHTML = `<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">${label}</span>`;
    detailsJoinBtn.classList.toggle('is-past', !within || sessionEnded);
    detailsJoinBtn.classList.toggle('is-session-ended', sessionEnded);
}

function closeDetailsModal() {
    if (detailsJoinCheckTimer) {
        clearInterval(detailsJoinCheckTimer);
        detailsJoinCheckTimer = null;
    }
    if (detailsOverlay) {
        detailsOverlay.classList.remove('is-open');
        detailsOverlay.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
}
function formatPetAge(age) {
    if (age == null || age === '') return '—';
    const n = Number(age);
    return isNaN(n) ? String(age) : n === 1 ? '1 Year' : n + ' Years';
}
function formatPetWeight(weight) {
    if (weight == null || weight === '') return '—';
    const n = Number(weight);
    return isNaN(n) ? String(weight) : n + ' kg';
}
document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.appointment-view-btn');
    if (!btn?.dataset.id) return;
    e.preventDefault();
    const aptId = btn.dataset.id;
    const appointments = window._appointmentsCache || [];
    const apt = appointments.find((a) => a.id === aptId);
    if (!apt) return;
    const titleEl = $('details-title');
    titleEl.textContent = (apt.title?.trim()) ? apt.title.trim() : '—';
    titleEl.classList.toggle('is-empty', !apt.title?.trim());
    $('details-vet-name').textContent = apt.vetName || '—';
    $('details-date').textContent = formatAppointmentDate(apt.date || apt.dateStr);
    $('details-time').textContent = getAppointmentTimeDisplay(apt);
    const payRow = $('details-payment');
    if (payRow) payRow.textContent = apt.paid === true ? 'Paid' : '—';
    $('details-concern').textContent = (apt.reason?.trim()) ? apt.reason.trim() : '—';
    $('details-appointment-id').textContent = aptId || '—';
    const mediaUrls = apt.mediaUrls && Array.isArray(apt.mediaUrls) ? apt.mediaUrls : [];
    const placeholderEl = $('details-shared-images-placeholder');
    const listEl = $('details-shared-images-list');
    if (placeholderEl) placeholderEl.classList.toggle('is-hidden', mediaUrls.length > 0);
    if (listEl) {
        listEl.classList.toggle('is-hidden', mediaUrls.length === 0);
        listEl.innerHTML = '';
        mediaUrls.forEach((url, idx) => {
            const isPdf = /\.pdf(\?|$)/i.test(url) || (typeof url === 'string' && url.toLowerCase().includes('pdf'));
            const isImage = !isPdf;
            const item = document.createElement('div');
            item.className = 'details-shared-image-item';
            if (isImage) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'details-shared-image-link';
                btn.dataset.url = url;
                btn.dataset.isImage = 'true';
                const img = document.createElement('img');
                img.src = url;
                img.alt = `Shared image ${idx + 1}`;
                img.className = 'details-shared-image-thumb';
                img.loading = 'lazy';
                btn.appendChild(img);
                item.appendChild(btn);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'details-shared-file-link';
                btn.dataset.url = url;
                btn.dataset.isImage = 'false';
                btn.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> View document ' + (idx + 1);
                item.appendChild(btn);
            }
            listEl.appendChild(item);
        });
    }
    const vetImg = $('details-vet-img');
    const vetFallback = $('details-vet-avatar-fallback');
    if (vetImg) { vetImg.style.display = 'none'; vetImg.src = ''; vetImg.alt = apt.vetName || 'Vet'; }
    if (vetFallback) vetFallback.classList.add('visible');
    loadVetProfile(apt.vetId).then((vet) => {
        if (vet?.photoURL && vetImg) {
            vetImg.src = vet.photoURL;
            vetImg.style.display = '';
            if (vetFallback) vetFallback.classList.remove('visible');
        }
    });
    const petImg = $('details-pet-img');
    const petFallback = $('details-pet-avatar-fallback');
    const petAvatarWrap = $('details-pet-avatar-wrap');
    if (petImg) { petImg.style.display = 'none'; petImg.src = ''; petImg.alt = apt.petName || 'Pet'; }
    if (petFallback) {
        petFallback.classList.add('visible');
        petFallback.innerHTML = (apt.petSpecies || '').toLowerCase() === 'cat' ? '<i class="fa-solid fa-cat" aria-hidden="true"></i>' : '<i class="fa fa-paw" aria-hidden="true"></i>';
    }
    if (petAvatarWrap) petAvatarWrap.classList.toggle('details-pet-avatar-wrap--cat', (apt.petSpecies || '').toLowerCase() === 'cat');
    $('details-pet-name').textContent = apt.petName || '—';
    $('details-pet-age').textContent = '—';
    $('details-pet-weight').textContent = '—';
    const initSp = (apt.petSpecies || '').trim();
    $('details-pet-species').textContent = initSp ? initSp.charAt(0).toUpperCase() + initSp.slice(1).toLowerCase() : '—';
    if (auth.currentUser) {
        loadPets(auth.currentUser.uid).then((pets) => {
            const pet = pets.find((p) => p.id === apt.petId);
            if (pet) {
                $('details-pet-age').textContent = formatPetAge(pet.age);
                $('details-pet-weight').textContent = formatPetWeight(pet.weight);
                const sp = (pet.species || apt.petSpecies || '').trim();
                $('details-pet-species').textContent = sp ? sp.charAt(0).toUpperCase() + sp.slice(1).toLowerCase() : '—';
                if (pet.imageUrl && petImg) {
                    petImg.src = pet.imageUrl;
                    petImg.style.display = '';
                    if (petFallback) petFallback.classList.remove('visible');
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
        detailsJoinBtn.title = 'Checking call status…';
        detailsJoinBtn.innerHTML = '<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">Loading…</span>';
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
    window.location.href = `messages.html?${params.toString()}`;
});
detailsOverlay?.addEventListener('click', (e) => { if (e.target === detailsOverlay) closeDetailsModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailsOverlay?.classList.contains('is-open')) closeDetailsModal();
});
detailsJoinBtn?.addEventListener('click', () => {
    if (!currentDetailsApt || detailsJoinBtn.disabled) return;
    window.location.href = `video-call.html?appointmentId=${currentDetailsApt.id}`;
});

/* Details media lightbox (click to enlarge, no new tab) */
function initDetailsMediaLightbox() {
    const lb = $('details-media-lightbox');
    const lbImg = lb?.querySelector('.details-media-lightbox-img');
    const lbIframe = lb?.querySelector('.details-media-lightbox-iframe');
    const closeBtn = lb?.querySelector('.details-media-lightbox-close');
    const backdrop = lb?.querySelector('.details-media-lightbox-backdrop');
    const listEl = $('details-shared-images-list');

    const closeLB = () => {
        if (!lb) return;
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = (detailsOverlay?.classList.contains('is-open') ? 'hidden' : '');
        if (lbImg) { lbImg.src = ''; lbImg.classList.remove('is-hidden'); }
        if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
    };
    const openLB = (url, isImage) => {
        if (!lb) return;
        if (isImage) {
            if (lbImg) { lbImg.src = url; lbImg.classList.remove('is-hidden'); }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
        } else {
            if (lbIframe) { lbIframe.src = url; lbIframe.classList.remove('is-hidden'); }
            if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
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
        const btn = e.target.closest('.details-shared-image-link, .details-shared-file-link');
        if (!btn?.dataset?.url) return;
        e.preventDefault();
        openLB(btn.dataset.url, btn.dataset.isImage === 'true');
    });
}
initDetailsMediaLightbox();

function hideAppointmentsLoading() {
    if (!appointmentsLoading) return;
    appointmentsLoading.setAttribute('aria-hidden', 'true');
    appointmentsLoading.classList.add('is-hidden');
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

/* Auth & subscriptions */
onAuthStateChanged(auth, async (userFromCallback) => {
    if (typeof window._appointmentsUnsub === 'function') {
        window._appointmentsUnsub();
        window._appointmentsUnsub = null;
    }
    const user = await resolveUserForAppointments(userFromCallback);
    if (!user) {
        hideAppointmentsLoading();
        renderUpcomingPanel(upcomingRoot, []);
        renderHistoryPanel(historyRoot, []);
        return;
    }
    const callback = (appointments) => {
        window._appointmentsCache = appointments;
        hideAppointmentsLoading();
        renderUpcomingPanel(upcomingRoot, appointments);
        renderHistoryPanel(historyRoot, appointments);
    };
    const unsub = subscribeAppointments(user.uid, callback);
    window._appointmentsUnsub = unsub;

    Promise.all([loadVets(), loadPets(user.uid)]).then(([vets, pets]) => {
        populateVetSelect($('booking-vet-dropdown'), vets);
        populatePetSelect($('booking-pet-dropdown'), pets);
        const petHint = $('booking-pet-hint');
        if (petHint) petHint.classList.toggle('is-hidden', pets.length > 0);
        window._bookingPetsCount = pets.length;
        updateConfirmButtonState();
    }).catch((err) => {
        console.error('Load vets/pets for appointment page:', err);
        populateVetSelect($('booking-vet-dropdown'), []);
        populatePetSelect($('booking-pet-dropdown'), []);
        window._bookingPetsCount = 0;
        updateConfirmButtonState();
    });
});

/** Last resort if Firestore and timers never complete (extreme throttling / broken transport). */
const APPOINTMENTS_LOADING_FALLBACK_MS = 25000;
setTimeout(() => {
    if (!appointmentsLoading || appointmentsLoading.classList.contains('is-hidden')) return;
    console.warn('Appointments: loading UI fallback — hiding spinner.');
    hideAppointmentsLoading();
    if (!window._appointmentsCache) {
        renderUpcomingPanel(upcomingRoot, []);
        renderHistoryPanel(historyRoot, []);
    }
}, APPOINTMENTS_LOADING_FALLBACK_MS);

/* Form submit */
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
        confirmBtn.querySelector('.booking-confirm-text').textContent = 'Checking availability…';
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
                    confirmBtn.querySelector('.booking-confirm-text').textContent = 'Book Online Consultation';
                }
                return;
            }
        }
        if (confirmBtn) confirmBtn.querySelector('.booking-confirm-text').textContent = 'Saving files…';
        const petSpecies = petSelect?.dataset?.species || '';
        syncFileInputFromBookingMedia();
        const mediaFiles = bookingMediaFiles.length ? bookingMediaFiles : (fileInput?.files ? Array.from(fileInput.files) : []);
        let mediaKey = null;
        if (mediaFiles.length > 0) {
            try {
                mediaKey = await saveBookingMediaToIndexedDB(mediaFiles);
            } catch (err) {
                showFormError('Could not save your files. Please try again.');
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.querySelector('.booking-confirm-text').textContent = 'Book Online Consultation'; }
                return;
            }
        }
        if (confirmBtn) confirmBtn.querySelector('.booking-confirm-text').textContent = 'Booking consultation…';
        const booking = {
            title: title || null,
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
            mediaKey: mediaKey || undefined,
        };
        sessionStorage.setItem('televet_booking', JSON.stringify(booking));
        closeModal();
        form.reset();
        document.querySelector('.booking-pet-trigger-text') && (document.querySelector('.booking-pet-trigger-text').textContent = 'Select Pet');
        document.querySelector('.booking-vet-trigger-text') && (document.querySelector('.booking-vet-trigger-text').textContent = 'Select Vet');
        if (bookingDate) { bookingDate.innerHTML = '<option value="">Select a vet first</option>'; bookingDate.disabled = true; }
        if (bookingTime) { bookingTime.innerHTML = '<option value="">Select a date first</option>'; bookingTime.disabled = true; }
        cachedAvailability = { dates: [], slotsByDate: {} };
        if (fileListEl && typeof updateFileList === 'function') updateFileList();
        window.location.href = 'payment.html?booking=1';
    } catch (err) {
        showFormError(err?.message || 'Failed to continue. Please try again.');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.querySelector('.booking-confirm-text').textContent = 'Book Online Consultation';
        }
    }
});
