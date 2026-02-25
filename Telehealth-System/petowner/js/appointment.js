/**
 * Pet Owner Appointment Page — UI logic (tabs, modal, form, file list)
 */
import {
    loadPets,
    loadVets,
    populatePetSelect,
    populateVetSelect,
    createAppointment,
    subscribeAppointments,
    renderUpcomingPanel,
    renderHistoryPanel,
    getAvailableDatesAndSlots,
    CLINIC_HOURS_PLACEHOLDER,
} from './appointment-manager.js';
import { auth } from '../../shared/js/firebase-config.js';

const $ = (id) => document.getElementById(id);

// DOM refs
const overlay = $('booking-modal-overlay');
const modal = $('booking-modal');
const form = $('booking-form');
const formError = $('booking-form-error');
const confirmBtn = $('booking-confirm-btn');
const loadingEl = $('appointments-loading');
const upcomingRoot = $('upcoming-appointments-root');
const historyRoot = $('history-appointments-root');
const bookingDate = $('booking-date');
const bookingTime = $('booking-time');
const bookingVet = $('booking-vet');
const fileInput = $('booking-media');
const fileListEl = $('booking-file-list');

let cachedAvailability = { dates: [], slotsByDate: {} };

// Tabs
document.querySelectorAll('.appointments-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        const t = tab.dataset.tab;
        document.querySelectorAll('.appointments-tab').forEach((tb) => {
            tb.classList.toggle('active', tb === tab);
            tb.setAttribute('aria-selected', tb === tab);
        });
        document.querySelectorAll('.appointments-tab-panel').forEach((p) => {
            p.classList.toggle('is-hidden', p.id !== `panel-${t}`);
        });
    });
});

// Modal
const openModal = () => {
    form.querySelectorAll('.booking-form-group.has-error').forEach((g) => g.classList.remove('has-error'));
    showError('');
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    modal.focus();
    document.body.style.overflow = 'hidden';
};

const closeModal = () => {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
};

const showError = (msg) => {
    if (formError) {
        formError.textContent = msg || '';
        formError.classList.toggle('is-hidden', !msg);
    }
};

const setFieldError = (el) => el?.closest('.booking-form-group')?.classList.add('has-error');
const clearFieldErrors = () => form.querySelectorAll('.booking-form-group.has-error').forEach((g) => g.classList.remove('has-error'));

const validate = () => {
    clearFieldErrors();
    const pet = $('booking-pet');
    const vet = $('booking-vet');
    const reason = $('booking-reason');
    const checks = [
        [!pet?.value || !pet?.dataset?.petName, $('booking-pet-dropdown')],
        [!vet?.value || !vet?.dataset?.vetName, $('booking-vet-dropdown')],
        [!reason?.value?.trim(), reason],
        [!bookingDate?.value, bookingDate],
        [!bookingTime?.value, bookingTime],
    ];
    checks.forEach(([fail, el]) => fail && el && setFieldError(el));
    return !checks.some(([fail]) => fail);
};

const formatDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—');

const formatTime = (val) => {
    if (!val) return '';
    const [h, m = 0] = val.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

const onVetChange = async () => {
    const vetId = bookingVet?.value;
    bookingDate.disabled = !vetId;
    bookingTime.disabled = true;
    bookingDate.innerHTML = '<option value="">Select a date</option>';
    bookingTime.innerHTML = '<option value="">Select a date first</option>';
    if (!vetId) return;

    bookingDate.innerHTML = '<option value="">Loading…</option>';
    try {
        cachedAvailability = await getAvailableDatesAndSlots(vetId);
        bookingDate.innerHTML = '<option value="">Select a date</option>';
        (cachedAvailability.dates || []).forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = formatDate(d);
            bookingDate.appendChild(opt);
        });
        if (!cachedAvailability.dates?.length) bookingDate.innerHTML = '<option value="">No available dates</option>';
    } catch (err) {
        const isPerm = err?.code === 'permission-denied' || err?.message?.includes('permission');
        bookingDate.innerHTML = `<option value="">${isPerm ? 'Permission denied' : 'Failed to load'}</option>`;
        showError(isPerm ? 'Firestore rules needed for vet schedules.' : '');
    }
};

const onDateChange = () => {
    const dateStr = bookingDate?.value;
    bookingTime.disabled = !dateStr;
    bookingTime.innerHTML = '<option value="">Select a time</option>';
    const slots = dateStr && cachedAvailability.slotsByDate?.[dateStr];
    if (slots?.length) slots.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.start;
        opt.textContent = s.display;
        bookingTime.appendChild(opt);
    });
    else if (dateStr) bookingTime.innerHTML = '<option value="">No available times</option>';
};

// Wire vet/date
window._onVetChange = onVetChange;
bookingDate?.addEventListener('change', onDateChange);

// Clear errors on interaction
const onFieldInteraction = (e) => e.target?.closest('.booking-form-group')?.classList.remove('has-error');
['#booking-pet-dropdown', '#booking-vet-dropdown', '#booking-reason', '#booking-date', '#booking-time'].forEach((sel) => {
    const el = form?.querySelector(sel);
    el?.addEventListener('change', onFieldInteraction);
    el?.addEventListener('input', onFieldInteraction);
    el?.addEventListener('click', onFieldInteraction);
});

// File list (for when upload is enabled)
const formatFileSize = (bytes) => !bytes ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const updateFileList = () => {
    const files = fileInput?.files ? Array.from(fileInput.files) : [];
    if (!fileListEl) return;
    fileListEl.innerHTML = '';
    fileListEl.classList.toggle('has-files', files.length > 0);
    fileListEl.classList.toggle('is-hidden', !files.length);
    files.forEach((file, i) => {
        const li = document.createElement('li');
        li.className = 'booking-file-item';
        const name = file.name || `File ${i + 1}`;
        const icon = (file.type || '').includes('image') ? 'fa-file-image-o' : 'fa-file-pdf-o';
        li.innerHTML = `<i class="fa ${icon}" aria-hidden="true"></i><span class="booking-file-name" title="${name.replace(/"/g, '&quot;')}">${name}</span><span class="booking-file-size">${formatFileSize(file.size)}</span><button type="button" class="booking-file-remove" data-index="${i}" aria-label="Remove file"><i class="fa fa-times" aria-hidden="true"></i></button>`;
        fileListEl.appendChild(li);
    });
};
const removeFile = (index) => {
    if (!fileInput?.files?.length) return;
    const dt = new DataTransfer();
    for (let i = 0; i < fileInput.files.length; i++) if (i !== index) dt.items.add(fileInput.files[i]);
    fileInput.files = dt.files;
    updateFileList();
};
const uploadZone = $('booking-upload-zone');
if (uploadZone && fileInput && !uploadZone.classList.contains('booking-upload-zone--coming-soon')) {
    uploadZone.addEventListener('click', (e) => !e.target.closest('.booking-file-remove') && fileInput.click());
    uploadZone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fileInput.click()));
    uploadZone.addEventListener('dragover', (e) => (e.preventDefault(), uploadZone.classList.add('is-dragover')));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('is-dragover');
        if (e.dataTransfer?.files?.length) {
            const dt = new DataTransfer();
            Array.from(fileInput.files || []).forEach((f) => dt.items.add(f));
            for (const f of e.dataTransfer.files) if ((f.type && f.type.includes('image')) || (f.name && f.name.toLowerCase().endsWith('.pdf'))) dt.items.add(f);
            fileInput.files = dt.files;
            updateFileList();
        }
    });
}
fileInput?.addEventListener('change', updateFileList);
fileListEl?.addEventListener('click', (e) => { const btn = e.target.closest('.booking-file-remove'); if (btn?.dataset.index != null) removeFile(parseInt(btn.dataset.index, 10)); });

// Modal events
$('book-appointment-btn')?.addEventListener('click', openModal);
$('booking-modal-close')?.addEventListener('click', closeModal);
$('booking-cancel-btn')?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => e.target === overlay && closeModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && overlay?.classList.contains('is-open') && closeModal());

// Form submit
const resetForm = () => {
    form?.reset();
    const petT = document.querySelector('.booking-pet-trigger-text');
    const vetT = document.querySelector('.booking-vet-trigger-text');
    if (petT) petT.textContent = 'Select Pet';
    if (vetT) vetT.textContent = 'Select Vet';
    if (bookingDate) { bookingDate.innerHTML = '<option value="">Select a vet first</option>'; bookingDate.disabled = true; }
    if (bookingTime) { bookingTime.innerHTML = '<option value="">Select a date first</option>'; bookingTime.disabled = true; }
    cachedAvailability = { dates: [], slotsByDate: {} };
    updateFileList();
};

form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) return showError('');

    clearFieldErrors();
    showError('');
    const confirmText = confirmBtn?.querySelector('.booking-confirm-text');
    if (confirmBtn) confirmBtn.disabled = true;
    if (confirmText) confirmText.textContent = 'Booking…';

    try {
        const pet = $('booking-pet');
        const vet = $('booking-vet');
        const dateStr = bookingDate?.value || '';
        const timeVal = bookingTime?.value || '';
        let timeDisplay = CLINIC_HOURS_PLACEHOLDER;
        if (timeVal) {
            const t = formatTime(timeVal);
            timeDisplay = dateStr ? new Date(dateStr + 'T' + timeVal).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + t : t;
        } else if (dateStr) {
            timeDisplay = formatDate(dateStr) + ' (consultation)';
        }

        const res = await createAppointment({
            title: $('booking-title')?.value?.trim() || null,
            petId: pet?.value,
            petName: pet?.dataset?.petName || '',
            petSpecies: pet?.dataset?.species || '',
            vetId: vet?.value,
            vetName: vet?.dataset?.vetName || '',
            clinicName: vet?.dataset?.clinic || '',
            reason: $('booking-reason')?.value?.trim(),
            dateStr,
            timeDisplay,
            mediaFiles: fileInput?.files?.length ? Array.from(fileInput.files) : [],
            slotStart: timeVal || null,
        });
        closeModal();
        resetForm();
        window.location.href = `payment.html?booking=1&id=${encodeURIComponent(res.id)}`;
    } catch (err) {
        showError(err.message || 'Failed to book. Please try again.');
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
        if (confirmText) confirmText.textContent = 'Confirm Online Consultation';
    }
});

// Auth init
auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    const [vets, pets] = await Promise.all([loadVets(), loadPets(user.uid)]);
    populateVetSelect($('booking-vet-dropdown'), vets);
    populatePetSelect($('booking-pet-dropdown'), pets);

    const petHint = $('booking-pet-hint');
    if (petHint) petHint.classList.toggle('is-hidden', pets.length > 0);
    if (confirmBtn) confirmBtn.disabled = pets.length === 0;

    subscribeAppointments(user.uid, (appointments) => {
        if (loadingEl) { loadingEl.classList.add('is-hidden'); loadingEl.setAttribute('aria-hidden', 'true'); }
        renderUpcomingPanel(upcomingRoot, appointments);
        renderHistoryPanel(historyRoot, appointments);
    });
});
