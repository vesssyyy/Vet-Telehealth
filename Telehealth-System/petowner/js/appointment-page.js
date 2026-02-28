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
import { auth } from '../../shared/js/firebase-config.js';

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

let cachedAvailability = { dates: [], slotsByDate: {} };

function openModal() {
    if (!overlay || !modal) return;
    clearFieldErrors();
    showFormError('');
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
    let hasError = false;
    if (!petVal || !petNameVal) { setFieldError($('booking-pet-dropdown')); hasError = true; }
    if (!vetVal || !vetNameVal) { setFieldError($('booking-vet-dropdown')); hasError = true; }
    if (!reasonVal) { setFieldError(reasonInput); hasError = true; }
    if (!dateVal || !timeVal) {
        if (!dateVal) setFieldError(dateEl);
        if (!timeVal) setFieldError(timeEl);
        hasError = true;
    }
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

function updateFileList() {
    const files = fileInput?.files ? Array.from(fileInput.files) : [];
    if (!fileListEl) return;
    fileListEl.innerHTML = '';
    fileListEl.classList.toggle('has-files', files.length > 0);
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
}
function removeFile(index) {
    if (!fileInput?.files?.length) return;
    const dt = new DataTransfer();
    for (let i = 0; i < fileInput.files.length; i++) {
        if (i !== index) dt.items.add(fileInput.files[i]);
    }
    fileInput.files = dt.files;
    updateFileList();
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
    const parts = timeVal.split(':');
    const h = parseInt(parts[0], 10);
    const m = parts[1] ? parseInt(parts[1], 10) : 0;
    const startStr = (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
    let endStr = '';
    if (slotEnd) {
        const p = slotEnd.split(':');
        const hE = parseInt(p[0], 10);
        const mM = p[1] ? parseInt(p[1], 10) : 0;
        endStr = (hE % 12 || 12) + ':' + String(mM).padStart(2, '0') + ' ' + (hE >= 12 ? 'PM' : 'AM');
    }
    const timeDisplay = startStr + (endStr ? ' – ' + endStr : '');
    if (dateStr) {
        try {
            const d = new Date(dateStr + 'T' + timeVal);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + timeDisplay;
        } catch (_) {}
    }
    return timeDisplay;
}

/* Tabs */
document.querySelectorAll('.appointments-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        const t = tab.getAttribute('data-tab');
        document.querySelectorAll('.appointments-tab').forEach((tb) => {
            tb.classList.toggle('active', tb === tab);
            tb.setAttribute('aria-selected', tb === tab ? 'true' : 'false');
        });
        document.querySelectorAll('.appointments-tab-panel').forEach((p) => {
            p.classList.toggle('is-hidden', p.id !== 'panel-' + t);
        });
    });
});

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

if (uploadZone && fileInput && !uploadZone.classList.contains('booking-upload-zone--coming-soon')) {
    uploadZone.addEventListener('click', (e) => { if (!e.target.closest('.booking-file-remove')) fileInput.click(); });
    uploadZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('is-dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('is-dragover');
        if (e.dataTransfer?.files?.length) {
            const dt = new DataTransfer();
            if (fileInput.files) Array.from(fileInput.files).forEach((f) => dt.items.add(f));
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const f = e.dataTransfer.files[i];
                if ((f.type?.includes('image')) || (f.name?.toLowerCase().endsWith('.pdf'))) dt.items.add(f);
            }
            fileInput.files = dt.files;
            updateFileList();
        }
    });
}
if (fileInput && !uploadZone?.classList.contains('booking-upload-zone--coming-soon')) fileInput.addEventListener('change', updateFileList);
fileListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.booking-file-remove');
    if (btn?.dataset.index != null) removeFile(parseInt(btn.dataset.index, 10));
});

/* Details modal */
const detailsOverlay = $('details-modal-overlay');
const detailsModalEl = $('details-modal');
const detailsClose = $('details-modal-close');
const detailsJoinBtn = $('details-join-btn');
function closeDetailsModal() {
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
    $('details-concern').textContent = (apt.reason?.trim()) ? apt.reason.trim() : '—';
    $('details-appointment-id').textContent = aptId || '—';
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
    detailsOverlay.classList.add('is-open');
    detailsOverlay.setAttribute('aria-hidden', 'false');
    detailsModalEl.focus();
    document.body.style.overflow = 'hidden';
});
detailsClose?.addEventListener('click', closeDetailsModal);
detailsOverlay?.addEventListener('click', (e) => { if (e.target === detailsOverlay) closeDetailsModal(); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailsOverlay?.classList.contains('is-open')) closeDetailsModal();
});
detailsJoinBtn?.addEventListener('click', () => alert('Video call integration coming soon. You will be able to join your consultation here.'));

/* Auth & subscriptions — subscribe to appointments first so loading clears even if loadVets/loadPets fail */
auth.onAuthStateChanged((user) => {
    if (!user) return;
    const callback = (appointments) => {
        window._appointmentsCache = appointments;
        if (appointmentsLoading) {
            appointmentsLoading.setAttribute('aria-hidden', 'true');
            appointmentsLoading.classList.add('is-hidden');
        }
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
        if (confirmBtn) confirmBtn.disabled = pets.length === 0;
    }).catch((err) => {
        console.error('Load vets/pets for appointment page:', err);
        populateVetSelect($('booking-vet-dropdown'), []);
        populatePetSelect($('booking-pet-dropdown'), []);
        if (confirmBtn) confirmBtn.disabled = true;
    });
});

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
            const check = await checkSlotAvailability(vetId, dateStr, timeVal);
            if (!check.available) {
                showFormError("I'm sorry, this slot is no longer available. It's either deleted or already booked.");
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.querySelector('.booking-confirm-text').textContent = 'Book Online Consultation';
                }
                return;
            }
        }
        if (confirmBtn) confirmBtn.querySelector('.booking-confirm-text').textContent = 'Booking consultation…';
        const petSpecies = petSelect?.dataset?.species || '';
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
