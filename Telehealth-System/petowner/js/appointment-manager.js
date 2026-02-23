/**
 * Televet Health — Pet Owner Appointment Booking & List
 * Backend: Firestore (appointments, pets), optional Storage (media)
 */
import { auth, db, storage } from '../../shared/js/firebase-config.js';
import {
    collection,
    doc,
    getDocs,
    getDoc,
    addDoc,
    setDoc,
    updateDoc,
    onSnapshot,
    query,
    where,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    ref as storageRef,
    uploadBytesResumable,
    getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';

const APPOINTMENTS_COLLECTION = 'appointments';
const CLINIC_HOURS_PLACEHOLDER = 'Online consultation (time TBC)';

/** Fallback when no vets are registered in Firestore */
const VET_OPTIONS_FALLBACK = [
    { id: 'dr-smith', name: 'Dr. Smith', clinic: 'Happy Paws Clinic' },
    { id: 'dr-lee', name: 'Dr. Lee', clinic: 'Greenfield Vet Center' },
    { id: 'dr-jones', name: 'Dr. Jones', clinic: 'Purr & Paw Spa' },
];

const usersRef = () => collection(db, 'users');
const petsRef = (uid) => collection(db, 'users', uid, 'pets');
const appointmentsRef = () => collection(db, APPOINTMENTS_COLLECTION);
const scheduleCol = (vetId) => collection(db, 'users', vetId, 'schedules');
const scheduleDoc = (vetId, dateStr) => doc(db, 'users', vetId, 'schedules', dateStr);
const vetSettingsDoc = (vetId) => doc(db, 'users', vetId, 'vetSettings', 'scheduling');

const DEFAULT_MIN_ADVANCE_MINUTES = 30;

function computeExpiryTimeMs(dateStr, slotStart, minAdvanceMinutes) {
    const [h, m] = (slotStart || '').split(':').map(Number);
    const slotMins = (h || 0) * 60 + (m || 0);
    const d = new Date(dateStr + 'T00:00:00');
    d.setMinutes(d.getMinutes() + slotMins - (minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES));
    return d.getTime();
}

function isSlotExpired(slot, nowMs) {
    const status = slot.status || 'available';
    if (status === 'booked') return false;
    if (status === 'expired') return true;
    const expiry = slot.expiryTime != null ? Number(slot.expiryTime) : null;
    if (expiry == null) return false;
    return nowMs >= expiry;
}

function isSlotPastCutoff(dateStr, slotStart, minAdvanceMinutes) {
    const today = getTodayDateString();
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    const now = new Date();
    const [h, m] = (slotStart || '').split(':').map(Number);
    const slotMins = (h || 0) * 60 + (m || 0);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const diffMinutes = slotMins - nowMins;
    return diffMinutes < (minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES);
}

function ensureSlotExpiry(slot, dateStr, minAdvanceMinutes) {
    const mins = minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
    if (slot.expiryTime != null) return slot;
    return { ...slot, expiryTime: computeExpiryTimeMs(dateStr, slot.start, mins) };
}

function formatTime12h(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return timeStr || '—';
    const parts = String(timeStr).trim().split(':');
    const h = parseInt(parts[0], 10);
    const m = parts[1] != null ? parseInt(parts[1], 10) : 0;
    if (isNaN(h)) return timeStr;
    const hour = h % 12 || 12;
    const min = isNaN(m) ? '00' : String(m).padStart(2, '0');
    return `${hour}:${min} ${h < 12 ? 'AM' : 'PM'}`;
}

function vetDisplayName(data) {
    const name = (data.displayName || '').trim()
        || [data.firstName, data.lastName].filter(Boolean).join(' ').trim()
        || (data.email || '').split('@')[0]
        || 'Veterinarian';
    return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatAppointmentDate(dateStr) {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

function formatTimeDisplay(timeStr) {
    if (!timeStr) return '';
    return timeStr;
}

function getTodayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isUpcoming(appointment) {
    const status = (appointment.status || 'pending').toLowerCase();
    if (status === 'cancelled' || status === 'completed') return false;
    const dateStr = appointment.date || appointment.dateStr || '';
    return !dateStr || dateStr >= getTodayDateString();
}

/** Load current user's pets from Firestore */
export async function loadPets(uid) {
    if (!uid) return [];
    const snap = await getDocs(petsRef(uid));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function speciesIcon(species, extraClass = '') {
    const isCat = (species || '').toLowerCase() === 'cat';
    const cls = extraClass ? ` ${extraClass}` : '';
    return isCat ? `<i class="fa-solid fa-cat${cls}" aria-hidden="true"></i>` : `<i class="fa fa-paw${cls}" aria-hidden="true"></i>`;
}

/** Populate pet dropdown (Switch Pet style): no placeholder, only pet names with icons */
export function populatePetSelect(containerEl, pets) {
    if (!containerEl) return;
    const menu = containerEl.querySelector('.booking-pet-menu, [role="menu"]');
    const trigger = containerEl.querySelector('.booking-pet-trigger, .dropdown-trigger');
    const triggerText = containerEl.querySelector('.booking-pet-trigger-text');
    const hiddenInput = document.getElementById('booking-pet');
    if (!menu || !trigger || !triggerText || !hiddenInput) return;

    const list = Array.isArray(pets) ? pets : [];
    const items = list.map(
        (p) =>
            `<button type="button" class="dropdown-item booking-pet-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(p.name || 'Unnamed pet')}" data-species="${escapeHtml((p.species || '').toLowerCase())}">${speciesIcon(p.species, 'dropdown-item-icon')}<span>${escapeHtml(p.name || 'Unnamed pet')}</span></button>`
    ).join('');

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
        selectPet(list[0].id, list[0].name || 'Unnamed pet', (list[0].species || '').toLowerCase());
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

/** Load registered vets from Firestore (users with role === 'vet', not disabled) */
export async function loadVets() {
    try {
        const q = query(usersRef(), where('role', '==', 'vet'));
        const snap = await getDocs(q);
        const vets = snap.docs
            .filter((d) => !d.data().disabled)
            .map((d) => {
                const data = d.data();
                const name = vetDisplayName(data);
                const clinic = (data.clinicName || data.clinic || '').trim() || '';
                return { id: d.id, name, clinic };
            })
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return vets;
    } catch (err) {
        console.error('Load vets error:', err);
        return [];
    }
}

/** Load vet's scheduling settings (min advance booking) */
export async function loadVetSettings(vetId) {
    if (!vetId) return { minAdvanceBookingMinutes: DEFAULT_MIN_ADVANCE_MINUTES };
    try {
        const snap = await getDoc(vetSettingsDoc(vetId));
        if (snap.exists()) {
            const data = snap.data();
            return { minAdvanceBookingMinutes: data.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES };
        }
    } catch (err) {
        console.warn('Load vet settings error:', err);
    }
    return { minAdvanceBookingMinutes: DEFAULT_MIN_ADVANCE_MINUTES };
}

/** Load vet's schedules from Firestore */
export async function loadVetSchedules(vetId) {
    if (!vetId) return [];
    try {
        const snap = await getDocs(scheduleCol(vetId));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Load vet schedules error:', err);
        if (err?.code === 'permission-denied') {
            console.error('Firestore permission denied for vet schedules. Add rules for users/{userId}/schedules in Firebase Console.');
        }
        throw err;
    }
}

/** Get available dates and time slots for a vet. Returns { dates: string[], slotsByDate: { [dateStr]: [{ start, end, display }] } } */
export async function getAvailableDatesAndSlots(vetId) {
    if (!vetId) return { dates: [], slotsByDate: {} };
    const [schedules, settings] = await Promise.all([loadVetSchedules(vetId), loadVetSettings(vetId)]);
    const minAdvance = settings.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
    const today = getTodayDateString();
    const nowMs = Date.now();
    const dates = [];
    const slotsByDate = {};

    const nonBlocked = (schedules || []).filter((s) => s.blocked !== true);
    for (const sch of nonBlocked) {
        const dateStr = sch.date || sch.id || '';
        if (dateStr < today) continue;
        const slots = (sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance));
        const available = slots.filter((s) => {
            const status = s.status || 'available';
            if (status !== 'available') return false;
            if (isSlotExpired(s, nowMs)) return false;
            if (isSlotPastCutoff(dateStr, s.start, minAdvance)) return false;
            return true;
        });
        if (available.length > 0) {
            dates.push(dateStr);
            slotsByDate[dateStr] = available.map((s) => ({
                start: s.start,
                end: s.end,
                display: formatTime12h(s.start) + ' – ' + formatTime12h(s.end),
            }));
        }
    }
    dates.sort();
    return { dates, slotsByDate };
}

/** Populate vet dropdown (Switch Pet style): no placeholder, only vet names with icon */
export function populateVetSelect(containerEl, vets) {
    if (!containerEl) return;
    const menu = containerEl.querySelector('.booking-vet-menu, [role="menu"]');
    const trigger = containerEl.querySelector('.booking-vet-trigger, .dropdown-trigger');
    const triggerText = containerEl.querySelector('.booking-vet-trigger-text');
    const hiddenInput = document.getElementById('booking-vet');
    if (!menu || !trigger || !triggerText || !hiddenInput) return;

    const list = Array.isArray(vets) && vets.length > 0 ? vets : VET_OPTIONS_FALLBACK;
    const items = list.map(
        (v) =>
            `<button type="button" class="dropdown-item booking-vet-item" role="menuitem" data-vet-id="${escapeHtml(v.id)}" data-vet-name="${escapeHtml(v.name)}" data-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-stethoscope dropdown-item-icon" aria-hidden="true"></i><span>${escapeHtml(v.name)}${v.clinic ? ' – ' + escapeHtml(v.clinic) : ''}</span></button>`
    ).join('');

    menu.innerHTML = items;

    const setOpen = (open) => {
        containerEl.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open);
    };

    const selectVet = (vetId, vetName, clinic) => {
        hiddenInput.value = vetId || '';
        hiddenInput.dataset.vetName = vetName || '';
        hiddenInput.dataset.clinic = clinic || '';
        triggerText.textContent = vetName ? (vetName + (clinic ? ' – ' + clinic : '')) : 'Select Vet';
        setOpen(false);
        if (typeof window._onVetChange === 'function') window._onVetChange();
    };

    if (list.length === 1) {
        selectVet(list[0].id, list[0].name, list[0].clinic || '');
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

/** Upload files to Storage under appointments/{appointmentId}/media/ */
async function uploadMediaFiles(appointmentId, ownerId, files) {
    if (!appointmentId || !ownerId || !files?.length) return [];
    const urls = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = (file.name || '').split('.').pop() || 'bin';
        const path = `appointments/${appointmentId}/media/${ownerId}_${Date.now()}_${i}.${ext}`;
        const ref = storageRef(storage, path);
        await uploadBytesResumable(ref, file);
        const url = await getDownloadURL(ref);
        urls.push(url);
    }
    return urls;
}

/** Create appointment in Firestore; optionally upload media and add URLs. If slotStart is provided, marks the vet's schedule slot as booked. */
export async function createAppointment(data) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in to book an appointment.');

    const { title, petId, petName, petSpecies, vetId, vetName, clinicName, reason, dateStr, timeDisplay, mediaFiles, slotStart } = data;
    if (!petId || !petName || !vetId || !vetName || !reason?.trim()) {
        throw new Error('Please provide pet, vet, and reason.');
    }

    const appointmentData = {
        ownerId: user.uid,
        ownerEmail: user.email || '',
        ownerName: (user.displayName || '').trim() || 'Pet Owner',
        title: (title && String(title).trim()) || null,
        petId,
        petName: petName.trim(),
        petSpecies: (petSpecies || '').trim() || null,
        vetId,
        vetName: vetName.trim(),
        clinicName: (clinicName || '').trim(),
        date: dateStr || getTodayDateString(),
        dateStr: dateStr || getTodayDateString(),
        timeDisplay: timeDisplay || CLINIC_HOURS_PLACEHOLDER,
        reason: reason.trim(),
        mediaUrls: [],
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    };

    const docRef = await addDoc(appointmentsRef(), appointmentData);
    const appointmentId = docRef.id;

    if (mediaFiles?.length) {
        try {
            const urls = await uploadMediaFiles(appointmentId, user.uid, mediaFiles);
            if (urls.length) {
                const { updateDoc } = await import('https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js');
                await updateDoc(doc(db, APPOINTMENTS_COLLECTION, appointmentId), {
                    mediaUrls: urls,
                    updatedAt: serverTimestamp(),
                });
            }
        } catch (err) {
            console.warn('Media upload failed:', err);
        }
    }

    if (slotStart && vetId && dateStr) {
        try {
            const { updateDoc } = await import('https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js');
            const scheduleSnap = await getDoc(scheduleDoc(vetId, dateStr));
            if (scheduleSnap.exists()) {
                const scheduleData = scheduleSnap.data();
                const slots = scheduleData.slots || [];
                const updated = slots.map((s) => {
                    if ((s.start || '') === slotStart && (s.status || 'available') === 'available') {
                        return {
                            ...s,
                            status: 'booked',
                            appointmentId,
                            ownerId: user.uid,
                            ownerName: (user.displayName || '').trim() || 'Pet Owner',
                            petName: petName || '',
                        };
                    }
                    return s;
                });
                await setDoc(scheduleDoc(vetId, dateStr), { date: dateStr, slots: updated });
            }
        } catch (err) {
            console.warn('Mark slot booked failed:', err);
        }
    }

    return { id: appointmentId, ...appointmentData };
}

/** Mark appointment as paid (called from payment page) */
export async function markAppointmentPaid(appointmentId) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in.');
    const aptRef = doc(db, APPOINTMENTS_COLLECTION, appointmentId);
    const snap = await getDoc(aptRef);
    if (!snap.exists()) throw new Error('Appointment not found.');
    if (snap.data().ownerId !== user.uid) throw new Error('Not your appointment.');
    await updateDoc(aptRef, { paid: true, status: 'confirmed', updatedAt: serverTimestamp() });
}

/** Subscribe to appointments for current user */
export function subscribeAppointments(uid, callback) {
    if (!uid) return () => {};
    const q = query(appointmentsRef(), where('ownerId', '==', uid));
    return onSnapshot(
        q,
        (snapshot) => {
            const appointments = snapshot.docs.map((d) => {
                const data = d.data();
                const createdAt = data.createdAt?.toMillis?.() ?? data.createdAt?.getTime?.() ?? 0;
                return { id: d.id, ...data, createdAt };
            });
            appointments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            callback(appointments);
        },
        (err) => {
            console.error('Appointments subscription error:', err);
            callback([]);
        }
    );
}

/** Render upcoming appointments into panel */
export function renderUpcomingPanel(panelEl, appointments) {
    if (!panelEl) return;
    const upcoming = (appointments || []).filter(isUpcoming);
    const byDate = {};
    upcoming.forEach((apt) => {
        const key = apt.date || apt.dateStr || 'No date';
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(apt);
    });
    const sortedDates = Object.keys(byDate).sort();

    if (sortedDates.length === 0) {
        panelEl.innerHTML = `
            <div class="appointments-empty-state">
                <i class="fa fa-calendar-plus-o" aria-hidden="true"></i>
                <p>No upcoming online consultations</p>
                <span class="appointments-empty-hint">Book an online video consultation using the button above.</span>
            </div>
        `;
        return;
    }

    panelEl.innerHTML = sortedDates
        .map((dateStr) => {
            const heading = dateStr === 'No date' ? 'Scheduled' : formatAppointmentDate(dateStr);
            const cards = byDate[dateStr]
                .map(
                    (apt) => `
                <div class="appointment-card" data-appointment-id="${escapeHtml(apt.id)}">
                    <div class="appointment-card-pet">
                        <div class="appointment-card-pet-img ${(apt.petSpecies || '').toLowerCase() === 'cat' ? 'appointment-card-pet-img--cat' : ''}" aria-hidden="true"><i class="fa fa-paw" aria-hidden="true"></i></div>
                    </div>
                    <div class="appointment-card-body">
                        <h4 class="appointment-card-title">${escapeHtml(apt.title && apt.title.trim() ? apt.title.trim() : (apt.petName || 'Pet') + "'s Online Consultation")}</h4>
                        <p class="appointment-card-meta">${escapeHtml(apt.vetName || '')} | ${escapeHtml(apt.clinicName || '')}</p>
                        <p class="appointment-card-time"><i class="fa fa-clock-o" aria-hidden="true"></i> ${escapeHtml(apt.timeDisplay || CLINIC_HOURS_PLACEHOLDER)}</p>
                        ${(apt.status === 'pending' && !apt.paid) ? '<p class="appointment-card-status appointment-card-status--pending"><i class="fa fa-hourglass-half" aria-hidden="true"></i> Pending confirmation</p>' : apt.paid ? '<p class="appointment-card-status appointment-card-status--confirmed"><i class="fa fa-check-circle" aria-hidden="true"></i> Confirmed</p>' : ''}
                    </div>
                    <div class="appointment-card-actions">
                        <button type="button" class="appointment-view-btn" data-id="${escapeHtml(apt.id)}">View Details <i class="fa fa-chevron-right" aria-hidden="true"></i></button>
                    </div>
                </div>
            `
                )
                .join('');
            return `
                <section class="appointments-date-group">
                    <h3 class="appointments-date-heading">${escapeHtml(heading)}</h3>
                    ${cards}
                </section>
            `;
        })
        .join('');
}

/** Render history panel */
export function renderHistoryPanel(panelEl, appointments) {
    if (!panelEl) return;
    const history = (appointments || []).filter((a) => !isUpcoming(a));
    if (history.length === 0) {
        panelEl.innerHTML = `
            <div class="appointments-empty-state">
                <i class="fa fa-calendar-o" aria-hidden="true"></i>
                <p>No consultation history</p>
                <span class="appointments-empty-hint">Your past online consultations will appear here.</span>
            </div>
        `;
        return;
    }
    const byDate = {};
    history.forEach((apt) => {
        const key = apt.date || apt.dateStr || 'Other';
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(apt);
    });
    const sortedDates = Object.keys(byDate).sort().reverse();
    panelEl.innerHTML = sortedDates
        .map((dateStr) => {
            const heading = formatAppointmentDate(dateStr);
            const cards = byDate[dateStr]
                .map(
                    (apt) => `
                <div class="appointment-card appointment-card--history" data-appointment-id="${escapeHtml(apt.id)}">
                    <div class="appointment-card-pet">
                        <div class="appointment-card-pet-img ${(apt.petSpecies || '').toLowerCase() === 'cat' ? 'appointment-card-pet-img--cat' : ''}" aria-hidden="true"><i class="fa fa-paw" aria-hidden="true"></i></div>
                    </div>
                    <div class="appointment-card-body">
                        <h4 class="appointment-card-title">${escapeHtml(apt.title && apt.title.trim() ? apt.title.trim() : (apt.petName || 'Pet'))}</h4>
                        <p class="appointment-card-meta">${escapeHtml(apt.vetName || '')} | ${escapeHtml(apt.clinicName || '')}</p>
                        <p class="appointment-card-time"><i class="fa fa-clock-o" aria-hidden="true"></i> ${escapeHtml(apt.timeDisplay || '—')}</p>
                        <p class="appointment-card-status appointment-card-status--${escapeHtml((apt.status || '').toLowerCase())}"><i class="fa fa-check-circle" aria-hidden="true"></i> ${escapeHtml((apt.status || 'completed').toLowerCase())}</p>
                    </div>
                    <div class="appointment-card-actions">
                        <button type="button" class="appointment-view-btn" data-id="${escapeHtml(apt.id)}">View Details <i class="fa fa-chevron-right" aria-hidden="true"></i></button>
                    </div>
                </div>
            `
                )
                .join('');
            return `
                <section class="appointments-date-group">
                    <h3 class="appointments-date-heading">${escapeHtml(heading)}</h3>
                    ${cards}
                </section>
            `;
        })
        .join('');
}

/** Get vet label by id from a list (e.g. from loadVets or fallback) */
export function getVetOption(vetId, vetsList) {
    const list = Array.isArray(vetsList) && vetsList.length > 0 ? vetsList : VET_OPTIONS_FALLBACK;
    return list.find((v) => v.id === vetId) || null;
}

export { VET_OPTIONS_FALLBACK, CLINIC_HOURS_PLACEHOLDER };
