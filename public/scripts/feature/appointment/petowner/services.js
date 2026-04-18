// Televet Health - Pet Owner Appointment data layer (Firestore, Storage)
import { auth, db, storage } from '../../../core/firebase/firebase-config.js';
import { escapeHtml, formatDisplayName, formatTime12h, withDr } from '../../../core/app/utils.js';
import {
    APPOINTMENTS_COLLECTION,
    CLINIC_HOURS_PLACEHOLDER,
    DEFAULT_MIN_ADVANCE_MINUTES,
    DEFAULT_SLOT_DURATION_MINUTES,
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST,
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE,
    MIN_CONSULTATION_PRICE_CENTAVOS_LIVE,
    MIN_CONSULTATION_PRICE_CENTAVOS_TEST,
} from '../shared/constants.js';
import {
    getTodayDateString,
    addMinutesToTime,
} from '../shared/time.js';
import { skinAnalysisSavedAtToMs } from '../../skin-disease/skin-analysis-repository.js';
import {
    isSlotExpired,
    isSlotPastCutoff,
    ensureSlotExpiry,
    slotsOverlapSameDate,
} from '../shared/slots.js';
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
    runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    ref as storageRef,
    uploadBytesResumable,
    getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';

const usersRef = () => collection(db, 'users');
const petsRef = (uid) => collection(db, 'users', uid, 'pets');
const appointmentsRef = () => collection(db, APPOINTMENTS_COLLECTION);
const scheduleCol = (vetId) => collection(db, 'users', vetId, 'schedules');
const scheduleDoc = (vetId, dateStr) => doc(db, 'users', vetId, 'schedules', dateStr);
const vetSettingsDoc = (vetId) => doc(db, 'users', vetId, 'vetSettings', 'scheduling');

// Load owner's upcoming appointment time ranges (dateStr, start, end) for overlap checks. Excludes cancelled/completed, dateStr >= today.
async function getOwnerUpcomingSlotRanges(ownerId) {
    if (!ownerId) return [];
    const today = getTodayDateString();
    const q = query(appointmentsRef(), where('ownerId', '==', ownerId));
    const snap = await getDocs(q);
    const ranges = [];
    snap.docs.forEach((d) => {
        const data = d.data();
        const status = (data.status || 'booked').toLowerCase();
        if (status === 'cancelled' || status === 'completed') return;
        const dateStr = data.dateStr || data.date || '';
        if (dateStr < today) return;
        const start = data.slotStart || data.timeStart || '';
        if (!start) return;
        const end = data.slotEnd || data.timeEnd || addMinutesToTime(start, DEFAULT_SLOT_DURATION_MINUTES);
        ranges.push({ dateStr, start, end });
    });
    return ranges;
}

// Returns true if the given slot overlaps any of the owner's upcoming appointments.
async function ownerHasOverlappingAppointment(ownerId, dateStr, slotStart, slotEnd) {
    if (!ownerId || !dateStr || !slotStart) return false;
    const end = slotEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
    const ranges = await getOwnerUpcomingSlotRanges(ownerId);
    return ranges.some((r) => r.dateStr === dateStr && slotsOverlapSameDate(slotStart, end, r.start, r.end));
}

function vetDisplayName(data) {
    const name = (data.displayName || '').trim()
        || [data.firstName, data.lastName].filter(Boolean).join(' ').trim()
        || (data.email || '').split('@')[0]
        || 'Veterinarian';
    return withDr(name);
}


function formatAppointmentDate(dateStr) {
    if (!dateStr) return '-';
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

// Extract time range from timeDisplay string (e.g. "Feb 25, 2026 at 8:15 AM" -> "8:15 AM", "Feb 25, 2026 at 8:15 AM - 9:15 AM" -> "8:15 AM - 9:15 AM").
function extractTimeRangeFromDisplay(timeDisplay) {
    if (!timeDisplay || typeof timeDisplay !== 'string') return null;
    const s = timeDisplay.trim();
    const atIdx = s.lastIndexOf(' at ');
    if (atIdx === -1) return s; // no " at " - might already be time-only
    const timePart = s.slice(atIdx + 4).trim();
    if (!timePart) return null;
    // Normalize en-dash/em-dash to hyphen for consistency
    return timePart.replace(/\s*[–—]\s*/g, ' - ');
}

// Build time range only for card display (e.g. "8:00 AM - 9:00 AM"). Uses slotEnd or default duration when start is known.
function getAppointmentTimeDisplay(apt) {
    const slotStart = apt.slotStart;
    const slotEnd = apt.slotEnd || (slotStart ? addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES) : null);
    if (slotStart) {
        const endPart = slotEnd ? ` - ${formatTime12h(slotEnd)}` : '';
        return `${formatTime12h(slotStart)}${endPart}`;
    }
    const extracted = extractTimeRangeFromDisplay(apt.timeDisplay || apt.time || '');
    return extracted || formatTimeDisplay(apt.timeDisplay || apt.time || '');
}

function getAppointmentSlotEndDate(apt) {
    const dateStr = apt.dateStr || apt.date || '';
    const slotStart = apt.slotStart;
    if (!dateStr || !slotStart) return null;
    try {
        const end = apt.slotEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
        const dt = new Date(`${dateStr}T${end}:00`);
        return Number.isFinite(dt.getTime()) ? dt : null;
    } catch (_) {
        return null;
    }
}

function isUpcoming(appointment) {
    const status = (appointment.status || 'booked').toLowerCase();
    if (status === 'cancelled' || status === 'completed') return false;
    const dateStr = appointment.date || appointment.dateStr || '';
    const today = getTodayDateString();
    if (!dateStr) return true;
    if (dateStr < today) return false;
    if (dateStr > today) return true;
    // Same calendar day: after slot end, show under History even if status is still booked (completion syncing).
    const endAt = getAppointmentSlotEndDate(appointment);
    if (endAt && Date.now() >= endAt.getTime()) return false;
    return true;
}

// Load current user's pets from Firestore
export async function loadPets(uid) {
    if (!uid) return [];
    const snap = await getDocs(petsRef(uid));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Load a single vet's profile (photoURL, displayName) by vetId
export async function loadVetProfile(vetId) {
    if (!vetId) return null;
    try {
        const snap = await getDoc(doc(db, 'users', vetId));
        if (!snap.exists()) return null;
        const data = snap.data();
        return {
            id: vetId,
            name: vetDisplayName(data),
            photoURL: data.photoURL || data.photoUrl || null,
        };
    } catch (err) {
        console.warn('Load vet profile error:', err);
        return null;
    }
}

// Load registered vets from Firestore (users with role === 'vet', not disabled)
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

function normalizeConsultationPriceTest(raw) {
    const fallback = DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
    if (n < MIN_CONSULTATION_PRICE_CENTAVOS_TEST) return fallback;
    return n;
}

function normalizeConsultationPriceLive(raw) {
    const fallback = DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
    if (n < MIN_CONSULTATION_PRICE_CENTAVOS_LIVE) return fallback;
    return n;
}

// Load vet's scheduling settings (min advance, test vs live consultation fees).
export async function loadVetSettings(vetId) {
    const defaults = {
        minAdvanceBookingMinutes: DEFAULT_MIN_ADVANCE_MINUTES,
        consultationPriceCentavosTest: DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST,
        consultationPriceCentavosLive: DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE,
    };
    if (!vetId) return defaults;
    try {
        const snap = await getDoc(vetSettingsDoc(vetId));
        if (snap.exists()) {
            const data = snap.data();
            const legacy = data.consultationPriceCentavos;
            return {
                minAdvanceBookingMinutes: data.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES,
                consultationPriceCentavosTest: normalizeConsultationPriceTest(
                    data.consultationPriceCentavosTest ?? legacy,
                ),
                consultationPriceCentavosLive: normalizeConsultationPriceLive(
                    data.consultationPriceCentavosLive ?? legacy,
                ),
            };
        }
    } catch (err) {
        console.warn('Load vet settings error:', err);
    }
    return defaults;
}

// Load vet's schedules from Firestore
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

// Get available dates and time slots for a vet. Returns { dates: string[], slotsByDate: { [dateStr]: [{ start, end, display }] } }
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
                display: formatTime12h(s.start) + ' - ' + formatTime12h(s.end),
            }));
        }
    }
    dates.sort();
    return { dates, slotsByDate };
}

// Pre-submit guard: slot still available (not blocked, expired, taken, or overlapping owner’s other bookings).
export async function checkSlotAvailability(vetId, dateStr, slotStart, ownerId = null) {
    if (!vetId || !dateStr || !slotStart) return { available: false };
    try {
        const [scheduleSnap, settings] = await Promise.all([
            getDoc(scheduleDoc(vetId, dateStr)),
            loadVetSettings(vetId),
        ]);
        if (!scheduleSnap.exists()) return { available: false };
        const scheduleData = scheduleSnap.data();
        if (scheduleData.blocked === true) return { available: false };
        const slots = scheduleData.slots || [];
        const targetSlot = slots.find((s) => (s.start || '') === slotStart);
        if (!targetSlot) return { available: false };
        const status = targetSlot.status || 'available';
        if (status !== 'available') return { available: false };
        const minAdvance = settings.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
        const slotWithExpiry = ensureSlotExpiry(targetSlot, dateStr, minAdvance);
        const nowMs = Date.now();
        if (isSlotExpired(slotWithExpiry, nowMs)) return { available: false };
        if (isSlotPastCutoff(dateStr, slotStart, minAdvance)) return { available: false };
        if (ownerId) {
            const slotEnd = targetSlot.end || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
            const overlap = await ownerHasOverlappingAppointment(ownerId, dateStr, slotStart, slotEnd);
            if (overlap) {
                return { available: false, reason: 'owner_overlap' };
            }
        }
        return { available: true };
    } catch (err) {
        console.warn('checkSlotAvailability error:', err);
        return { available: false };
    }
}

// Upload files to Storage under appointments/{appointmentId}/media/
async function uploadMediaFiles(appointmentId, ownerId, files) {
    if (!appointmentId || !ownerId || !files?.length) return [];
    const urls = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = file.name || `file_${i}`;
        const ext = name.split('.').pop() || (file.type && file.type.indexOf('pdf') !== -1 ? 'pdf' : 'bin');
        const path = `appointments/${appointmentId}/media/${ownerId}_${Date.now()}_${i}.${ext}`;
        const ref = storageRef(storage, path);
        await uploadBytesResumable(ref, file);
        const url = await getDownloadURL(ref);
        urls.push(url);
    }
    return urls;
}

function normalizeAttachedSkinAnalysis(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const imageUrl = String(raw.imageUrl || '').trim();
    if (!imageUrl) return null;
    const conf = typeof raw.confidence === 'number' && !Number.isNaN(raw.confidence) ? raw.confidence : 0;
    const savedAtMs = skinAnalysisSavedAtToMs(raw);
    return {
        imageUrl,
        conditionName: String(raw.conditionName || '').slice(0, 200),
        savedName: String(raw.savedName || '').trim().slice(0, 120),
        confidence: Math.max(0, Math.min(1, conf)),
        notes: String(raw.notes || '').trim().slice(0, 500),
        savedRecordId: String(raw.savedRecordId || '').slice(0, 128),
        apiLabel: String(raw.apiLabel || '').slice(0, 100),
        petType: String(raw.petType || '').slice(0, 20),
        ...(savedAtMs != null
            ? { savedAtMs, savedAtIso: new Date(savedAtMs).toISOString() }
            : {}),
    };
}

// Create appointment in Firestore; optionally upload media and add URLs. If slotStart is provided, validates slot is still available and atomically marks it as booked. Prevents booking when vet has deleted/blocked the date.
export async function createAppointment(data) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in to book an appointment.');

    const { title, petId, petName, petSpecies, vetId, vetName, clinicName, reason, dateStr, timeDisplay, mediaFiles, slotStart, slotEnd } = data;
    const attachedSkinAnalysis = normalizeAttachedSkinAnalysis(data.attachedSkinAnalysis);
    if (!petId || !petName || !vetId || !vetName || !reason?.trim()) {
        throw new Error('Please provide pet, vet, and concern.');
    }

    const costPaidCentavos = (() => {
        const n = Number(data?.costPaidCentavos ?? data?.amountPaidCentavos ?? data?.amountCentavos ?? data?.costCentavos);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    })();

    const appointmentData = {
        ownerId: user.uid,
        ownerEmail: user.email || '',
        ownerName: formatDisplayName((user.displayName || '').trim()) || 'Pet Owner',
        title: (title && String(title).trim()) || null,
        petId,
        petName: formatDisplayName(petName.trim()),
        petSpecies: (petSpecies || '').trim() || null,
        vetId,
        vetName: formatDisplayName(vetName.trim()),
        clinicName: (clinicName || '').trim(),
        date: dateStr || getTodayDateString(),
        dateStr: dateStr || getTodayDateString(),
        timeDisplay: timeDisplay || CLINIC_HOURS_PLACEHOLDER,
        slotStart: slotStart || null,
        slotEnd: slotEnd || null,
        reason: reason.trim(),
        mediaUrls: [],
        status: 'booked',
        paid: false,
        costPaidCentavos: costPaidCentavos,
        paymentMethod: data?.paymentMethod || null,
        paymentIntentId: data?.paymentIntentId || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        /** Vet-facing new-booking badge; cleared when the vet acknowledges (appointment-notifications.js). */
        vetBookingAlertUnread: true,
        ...(attachedSkinAnalysis ? { attachedSkinAnalysis } : {}),
    };

    const SLOT_UNAVAILABLE_MSG = "I'm sorry, this slot is no longer available. It's either deleted or already booked.";
    const OWNER_OVERLAP_MSG = "You already have an appointment at this time. Please choose another slot.";

    if (slotStart && vetId && dateStr) {
        const slotEndVal = data.slotEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
        const ownerOverlap = await ownerHasOverlappingAppointment(user.uid, dateStr, slotStart, slotEndVal);
        if (ownerOverlap) {
            throw new Error(OWNER_OVERLAP_MSG);
        }

        const appointmentId = await runTransaction(db, async (transaction) => {
            const scheduleSnap = await transaction.get(scheduleDoc(vetId, dateStr));
            if (!scheduleSnap.exists()) {
                throw new Error(SLOT_UNAVAILABLE_MSG);
            }
            const scheduleData = scheduleSnap.data();
            if (scheduleData.blocked === true) {
                throw new Error(SLOT_UNAVAILABLE_MSG);
            }
            const slots = scheduleData.slots || [];
            const minAdvance = (await loadVetSettings(vetId)).minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
            const nowMs = Date.now();
            const targetSlot = slots.find((s) => (s.start || '') === slotStart);
            if (!targetSlot) {
                throw new Error(SLOT_UNAVAILABLE_MSG);
            }
            const status = targetSlot.status || 'available';
            if (status !== 'available') {
                throw new Error(SLOT_UNAVAILABLE_MSG);
            }
            const slotWithExpiry = ensureSlotExpiry(targetSlot, dateStr, minAdvance);
            if (isSlotExpired(slotWithExpiry, nowMs)) {
                throw new Error(SLOT_UNAVAILABLE_MSG);
            }
            if (isSlotPastCutoff(dateStr, slotStart, minAdvance)) {
                throw new Error('This slot is too soon to book. Please choose another slot.');
            }

            const aptRef = doc(appointmentsRef());
            transaction.set(aptRef, appointmentData);

            const updatedSlots = slots.map((s) => (s.start === slotStart
                ? {
                    ...s,
                    status: 'booked',
                    bookedBy: user.uid,
                    appointmentId: aptRef.id,
                    ownerId: user.uid,
                    ownerName: formatDisplayName((user.displayName || '').trim()),
                    petId,
                    petName: formatDisplayName(petName.trim()),
                    petSpecies: (petSpecies || '').trim() || '',
                    vetId,
                    reason: reason.trim(),
                }
                : s));
            transaction.update(scheduleDoc(vetId, dateStr), { slots: updatedSlots, updatedAt: serverTimestamp() });
            return aptRef.id;
        });

        if (mediaFiles?.length) {
            try {
                const urls = await uploadMediaFiles(appointmentId, user.uid, mediaFiles);
                if (urls.length) {
                    await updateDoc(doc(db, APPOINTMENTS_COLLECTION, appointmentId), {
                        mediaUrls: urls,
                        updatedAt: serverTimestamp(),
                    });
                }
            } catch (err) {
                console.error('Appointment media upload failed:', err);
                throw new Error('Your appointment was booked but uploading photos failed. You can send them in the chat. ' + (err.message || ''));
            }
        }

        return { id: appointmentId, ...appointmentData };
    }

    const docRef = await addDoc(appointmentsRef(), appointmentData);
    const appointmentId = docRef.id;

    if (mediaFiles?.length) {
        try {
            const urls = await uploadMediaFiles(appointmentId, user.uid, mediaFiles);
            if (urls.length) {
                await updateDoc(doc(db, APPOINTMENTS_COLLECTION, appointmentId), {
                    mediaUrls: urls,
                    updatedAt: serverTimestamp(),
                });
            }
        } catch (err) {
            console.error('Appointment media upload failed:', err);
            throw new Error('Your appointment was booked but uploading photos failed. You can send them in the chat. ' + (err.message || ''));
        }
    }

    return { id: appointmentId, ...appointmentData };
}

// Mark appointment as paid (called from payment page)
export async function markAppointmentPaid(appointmentId) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in.');
    const aptRef = doc(db, APPOINTMENTS_COLLECTION, appointmentId);
    const snap = await getDoc(aptRef);
    if (!snap.exists()) throw new Error('Appointment not found.');
    if (snap.data().ownerId !== user.uid) throw new Error('Not your appointment.');
    const extra = arguments.length > 1 ? arguments[1] : null;
    const patch = { paid: true, updatedAt: serverTimestamp() };
    if (extra && typeof extra === 'object') {
        const amt = Number(extra.amountCentavos ?? extra.costPaidCentavos);
        if (Number.isFinite(amt) && amt >= 0) patch.costPaidCentavos = Math.round(amt);
        if (extra.paymentMethod) patch.paymentMethod = String(extra.paymentMethod);
        if (extra.paymentIntentId) patch.paymentIntentId = String(extra.paymentIntentId);
    }
    await updateDoc(aptRef, patch);
}

/**
 * Normalize Firestore createdAt (Timestamp, plain {seconds}, Date, or ms) for UI + sorting.
 * @param {unknown} c
 */
function appointmentCreatedAtFieldToMs(c) {
    if (c == null) return 0;
    if (typeof c === 'object' && typeof c.toMillis === 'function') {
        const ms = c.toMillis();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (c instanceof Date && Number.isFinite(c.getTime())) return c.getTime();
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'object' && c !== null) {
        const sec = c.seconds ?? c._seconds;
        if (sec != null && Number.isFinite(Number(sec))) {
            const ns = Number(c.nanoseconds ?? c._nanoseconds ?? 0);
            return Number(sec) * 1000 + Math.floor(ns / 1e6);
        }
    }
    return 0;
}

function mapAppointmentSnapshotDocs(docs) {
    const appointments = docs.map((d) => {
        const data = d.data();
        const createdAt = appointmentCreatedAtFieldToMs(data.createdAt);
        return { id: d.id, ...data, createdAt };
    });
    appointments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return appointments;
}

/**
 * Subscribe to appointments for current user.
 * getDocs + onSnapshot: if one transport stalls (common on mobile / tunneling), the other can still complete.
 * Watchdog: iOS often throttles long timers; interval clears the spinner even when setTimeout is delayed.
 */
export function subscribeAppointments(uid, callback) {
    if (!uid) return () => {};
    const q = query(appointmentsRef(), where('ownerId', '==', uid));
    let active = true;
    let initialDone = false;
    let initialDelivered = false;
    const safetyMs = 12000;
    const started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let watchdogId = null;
    const trySafetyKick = () => {
        if (!active || initialDone) return false;
        const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        if (now - started < safetyMs) return false;
        initialDone = true;
        clearTimeout(safetyTimer);
        if (watchdogId != null) clearInterval(watchdogId);
        console.warn('Appointments: initial sync is slow; showing empty list until data arrives.');
        if (!initialDelivered) { initialDelivered = true; callback([]); }
        return true;
    };
    const safetyTimer = setTimeout(trySafetyKick, safetyMs);
    watchdogId = setInterval(() => {
        trySafetyKick();
        if (initialDone || !active) {
            if (watchdogId != null) clearInterval(watchdogId);
        }
    }, 2000);
    const deliver = (list) => {
        if (!active) return;
        if (!initialDone) {
            initialDone = true;
            clearTimeout(safetyTimer);
            if (watchdogId != null) clearInterval(watchdogId);
        }
        callback(list);
    };

    let isFirstSnapshot = true;

    getDocs(q)
        .then((snap) => {
            if (!initialDelivered) { initialDelivered = true; deliver(mapAppointmentSnapshotDocs(snap.docs)); }
        })
        .catch((err) => {
            console.error('Appointments getDocs error:', err);
            if (!initialDelivered) { initialDelivered = true; deliver([]); }
        });

    const unsub = onSnapshot(
        q,
        (snapshot) => {
            if (isFirstSnapshot) {
                isFirstSnapshot = false;
                if (initialDelivered) return;
                initialDelivered = true;
            }
            deliver(mapAppointmentSnapshotDocs(snapshot.docs));
        },
        (err) => {
            console.error('Appointments subscription error:', err);
            deliver([]);
        }
    );
    return () => {
        active = false;
        clearTimeout(safetyTimer);
        if (watchdogId != null) clearInterval(watchdogId);
        unsub();
    };
}

// Get vet label by id from a list
export function getVetOption(vetId, vetsList) {
    const list = Array.isArray(vetsList) ? vetsList : [];
    return list.find((v) => v.id === vetId) || null;
}

export { CLINIC_HOURS_PLACEHOLDER } from '../shared/constants.js';

