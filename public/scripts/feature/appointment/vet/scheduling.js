// Vet appointments: availability templates, schedules, slot expiry, booking settings, modals.
import { auth, db } from '../../../core/firebase/firebase-config.js';
import { escapeHtml } from '../../../core/app/utils.js';
import {
    getJoinAvailableLabel,
    isVideoSessionEnded,
    isConsultationPdfAvailable,
    getAppointmentSlotEndDate,
    canRejoinVideoConsultation,
    isVideoJoinClosed,
} from '../../video-consultation/utils/appointment-time.js';
import { normalizeTimeString } from '../../video-consultation/utils/time.js';
import { downloadConsultationReportForAppointment } from '../../consultation/consultation-pdf-download.js';
import { collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, serverTimestamp, query, where } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { registerTemplateEvents, createTemplateApi } from './template.js';
import { registerViewModeEvents, createViewRenderingApi } from './view-mode.js';
import { registerModalEvents, createEditDayApi, createDetailsApi, createBookingSettingsApi } from './modals.js';
import { registerBlockDatesEvents, createBlockDatesApi } from './block-dates.js';
import { markAppointmentNotificationsSeen, subscribeVetAppointmentNotifications } from '../../../core/notifications/appointment-notifications.js';
import {
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST,
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE,
    MIN_CONSULTATION_PRICE_CENTAVOS_LIVE,
    MIN_CONSULTATION_PRICE_CENTAVOS_TEST,
} from '../shared/constants.js';

(function () {
    'use strict';

    // === Constants ===
    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const DAY_LABELS = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };
    const WEEK_START_HOUR = 7, WEEK_END_HOUR = 20, HOUR_HEIGHT = 55;
    const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DEFAULT_MIN_ADVANCE_MINUTES = 30, MIN_ADVANCE_MIN = 1, MIN_ADVANCE_MAX_MINUTES = 1440;

    const $ = (id) => document.getElementById(id);
    const templateCol = (uid) => collection(db, 'users', uid, 'template');
    const templateDoc = (uid, id) => doc(db, 'users', uid, 'template', id);
    const scheduleCol = (uid) => collection(db, 'users', uid, 'schedules');
    const scheduleDoc = (uid, dateStr) => doc(db, 'users', uid, 'schedules', dateStr);
    const vetSettingsDoc = (uid) => doc(db, 'users', uid, 'vetSettings', 'scheduling');
    const appointmentDoc = (appointmentId) => doc(db, 'appointments', appointmentId);
    const typeLabel = (t) => (t?.type === 'week' ? 'Week template' : 'Day template');

    // === State ===
    let selectedDay = 'monday', editingTemplateId = null, cachedTemplates = [], weekSlots = {}, daySlots = [];
    let templateType = 'week', gridViewActive = false, cachedSchedules = null, nextCleanupTimerId = null;
    let cachedVetSettings = {
        minAdvanceBookingMinutes: DEFAULT_MIN_ADVANCE_MINUTES,
        consultationPriceCentavosTest: DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST,
        consultationPriceCentavosLive: DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE,
    };
    let currentTemplateAction = null, schedulesUnsubscribe = null;
    let blockCalendarMonth = null, blockSelectedDates = new Set(), blockPreviouslyBlocked = new Set();
    let editDayDateStr = null, editDaySlots = [];
    let currentDetailsApt = null;
    /** @type {Map<string, number>} */
    let unreadNotifByAppointmentId = new Map();
    let notifUnsub = null;
    let viewRenderingApi = null;
    let templateApi = null;
    function invalidateSchedulesCache() { cachedSchedules = null; }
    function setErrorEl(id, msg, hidden) { const el = $(id); if (el) { el.textContent = msg ?? ''; el.classList.toggle('is-hidden', !!hidden); } }

    const blockDatesApi = createBlockDatesApi({
        $, auth, escapeHtml, scheduleDoc, setDoc, deleteDoc, toLocalDateString, formatDisplayDate,
        ensureSchedulesLoaded, setModalVisible, showToast, invalidateSchedulesCache,
        loadBlockedDatesView, loadSchedulesView, loadWeeklyScheduleView,
        getBlockCalendarMonth: () => blockCalendarMonth, setBlockCalendarMonth: (v) => { blockCalendarMonth = v; },
        getBlockSelectedDates: () => blockSelectedDates, setBlockSelectedDates: (v) => { blockSelectedDates = v; },
        getBlockPreviouslyBlocked: () => blockPreviouslyBlocked, setBlockPreviouslyBlocked: (v) => { blockPreviouslyBlocked = v; }
    });
    const editDayApi = createEditDayApi({
        $, auth, scheduleDoc, getDoc, deleteDoc, setDoc,
        formatDisplayDate, setModalVisible,
        renderSlotsList: (...args) => templateApi?.renderSlotsList(...args),
        validateSlots: (...args) => templateApi?.validateSlots(...args),
        setErrorEl,
        getMinAdvanceMinutes, ensureSlotExpiry, isSlotExpired, isSlotPastCutoff, formatMinutesForDisplay,
        showToast, invalidateSchedulesCache, loadSchedulesView, loadWeeklyScheduleView,
        getEditDayDateStr: () => editDayDateStr, setEditDayDateStr: (v) => { editDayDateStr = v; },
        getEditDaySlots: () => editDaySlots, setEditDaySlots: (v) => { editDaySlots = v; }
    });

    // === DOM & UI helpers ===
    function setModalVisible(overlayId, modalId, visible) {
        const hidden = !visible;
        [$(overlayId), $(modalId)].forEach((el) => { if (el) { el.classList.toggle('is-hidden', hidden); el.setAttribute('aria-hidden', String(hidden)); } });
    }
    const onOverlayClick = (overlayId, closeFn) => $(overlayId)?.addEventListener('click', (e) => { if (e.target.id === overlayId) closeFn(); });

    function formatMinutesForDisplay(mins) {
        if (mins >= 60 && mins % 60 === 0) return `${mins / 60} hour${mins / 60 !== 1 ? 's' : ''}`;
        return `${mins} minute${mins !== 1 ? 's' : ''}`;
    }

    // === Templates list ===
    function showEmpty(show) {
        $('appointments-templates-list')?.classList.toggle('is-hidden', show);
        $('appointments-empty')?.classList.toggle('is-hidden', !show);
    }

    function renderTemplatesList(templates) {
        const list = $('appointments-templates-list');
        if (!list) return;
        list.innerHTML = '';
        if (!templates?.length) {
            showEmpty(true);
            return;
        }
        showEmpty(false);
        templates.forEach((t) => {
            const card = document.createElement('div');
            card.className = 'appointments-template-card appointments-template-card-clickable';
            card.dataset.templateId = t.id;
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `Template: ${escapeHtml(t.name || 'Unnamed')}. Click to view actions.`);
            card.innerHTML = `
                <div class="appointments-template-info">
                    <div class="appointments-template-icon"><i class="fa fa-${t.type === 'week' ? 'calendar' : 'clock-o'}" aria-hidden="true"></i></div>
                    <div>
                        <div class="appointments-template-name">${escapeHtml(t.name || 'Unnamed')}</div>
                        <div class="appointments-template-meta">${escapeHtml(typeLabel(t))}</div>
                    </div>
                </div>
                <i class="fa fa-chevron-right appointments-template-chevron" aria-hidden="true"></i>
            `;
            card.addEventListener('click', () => templateApi?.openTemplateActionModal(t));
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); templateApi?.openTemplateActionModal(t); } });
            list.appendChild(card);
        });
    }

    function loadTemplates() {
        const user = auth.currentUser;
        if (!user) return Promise.resolve([]);
        return getDocs(templateCol(user.uid))
            .then((snap) => {
                cachedTemplates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                renderTemplatesList(cachedTemplates);
                return cachedTemplates;
            })
            .catch((err) => {
                console.error('Load templates error:', err);
                showEmpty(true);
                return [];
            });
    }

    // === Schedules (slot expiry, load, filter) ===
    function getTodayDateString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    function getActiveSlotFilter() { return document.querySelector('.schedules-slot-btn.active')?.dataset?.slotFilter || 'all'; }
    function getMinAdvanceMinutes() { return cachedVetSettings?.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES; }

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

    function getConsultationPriceCentavosTest() {
        return normalizeConsultationPriceTest(cachedVetSettings?.consultationPriceCentavosTest);
    }

    function getConsultationPriceCentavosLive() {
        return normalizeConsultationPriceLive(cachedVetSettings?.consultationPriceCentavosLive);
    }

    // Compute expiryTime (ms) for a slot: slot start time minus advance booking limit.
    function computeExpiryTimeMs(dateStr, slotStart, minAdvanceMinutes) {
        const [h, m] = (slotStart || '').split(':').map(Number);
        const slotMins = (h || 0) * 60 + (m || 0);
        const d = new Date(dateStr + 'T00:00:00');
        d.setMinutes(d.getMinutes() + slotMins - (minAdvanceMinutes ?? getMinAdvanceMinutes()));
        return d.getTime();
    }

    // True if an available slot is past expiryTime (or status expired); booked/ongoing/completed are never expired here.
    function isSlotExpired(slot, nowMs) {
        const status = slot.status || 'available';
        if (status === 'booked' || status === 'ongoing' || status === 'completed') return false;
        if (status === 'expired') return true;
        const expiry = slot.expiryTime != null ? Number(slot.expiryTime) : null;
        if (expiry == null) return false;
        return nowMs >= expiry;
    }

    // Update Firebase: set status to "expired" for slots that are available and past expiryTime. Makes expiry visible in DB.
    async function markExpiredSlotsInFirebase() {
        const user = auth.currentUser;
        if (!user) return;
        const nowMs = Date.now();
        const all = await loadAllSchedules();
        for (const sch of all) {
            if (sch.blocked === true) continue;
            const dateStr = sch.date || sch.id || '';
            const slots = sch.slots || [];
            let scheduleHasChanges = false;
            const updated = slots.map((s) => {
                const status = s.status || 'available';
                if (status === 'booked' || status === 'ongoing' || status === 'completed') return s;
                if (status === 'expired') return s;
                if (isSlotExpired(s, nowMs)) {
                    scheduleHasChanges = true;
                    return { ...s, status: 'expired' };
                }
                return s;
            });
            if (scheduleHasChanges) {
                await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: updated });
            }
        }
        if (cachedSchedules) {
            cachedSchedules = await loadAllSchedules();
        }
    }

    // Returns true if slot is past cutoff (past date, or within min advance window today). Booked slots should always be shown.
    function isSlotPastCutoff(dateStr, slotStart, minAdvanceMinutes) {
        const today = getTodayDateString();
        if (dateStr < today) return true;
        if (dateStr > today) return false;
        const now = new Date();
        const [h, m] = (slotStart || '').split(':').map(Number);
        const slotMins = (h || 0) * 60 + (m || 0);
        const nowMins = now.getHours() * 60 + now.getMinutes();
        const diffMinutes = slotMins - nowMins;
        return diffMinutes < (minAdvanceMinutes ?? getMinAdvanceMinutes());
    }

    // Ensure slot has expiryTime (for legacy slots). Uses dateStr and slot.start.
    function ensureSlotExpiry(slot, dateStr, minAdvanceMinutes) {
        const mins = minAdvanceMinutes ?? getMinAdvanceMinutes();
        if (slot.expiryTime != null) return slot;
        return { ...slot, expiryTime: computeExpiryTimeMs(dateStr, slot.start, mins) };
    }

    async function loadVetSettings() {
        const user = auth.currentUser;
        if (!user) return;
        try {
            const snap = await getDoc(vetSettingsDoc(user.uid));
            if (snap.exists()) {
                const data = snap.data();
                const legacy = data.consultationPriceCentavos;
                cachedVetSettings = {
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
            console.error('Load vet settings error:', err);
        }
    }

    // Write vet scheduling settings (min advance booking, test/live consultation prices in centavos).
    async function saveVetSettings(updates) {
        const user = auth.currentUser;
        if (!user) return;
        const test = normalizeConsultationPriceTest(
            updates.consultationPriceCentavosTest ?? cachedVetSettings.consultationPriceCentavosTest,
        );
        const live = normalizeConsultationPriceLive(
            updates.consultationPriceCentavosLive ?? cachedVetSettings.consultationPriceCentavosLive,
        );
        const next = {
            minAdvanceBookingMinutes: updates.minAdvanceBookingMinutes ?? cachedVetSettings.minAdvanceBookingMinutes,
            consultationPriceCentavosTest: test,
            consultationPriceCentavosLive: live,
            consultationPriceCentavos: test,
        };
        try {
            await setDoc(vetSettingsDoc(user.uid), next, { merge: true });
            cachedVetSettings = { ...cachedVetSettings, ...next };
        } catch (err) {
            console.error('Save vet settings error:', err);
            throw err;
        }
    }

    // Recalculate expiryTime for all future unbooked slots and update Firestore.
    async function recalcExpiryForFutureSlots() {
        const user = auth.currentUser;
        if (!user) return;
        const today = getTodayDateString();
        const minAdvance = getMinAdvanceMinutes();
        const all = await loadAllSchedules();
        for (const sch of all) {
            if (sch.blocked === true) continue;
            const dateStr = sch.date || sch.id || '';
            if (dateStr < today) continue;
            const slots = sch.slots || [];
            const updated = slots.map((s) => {
                if ((s.status || 'available') === 'booked') return s;
                return ensureSlotExpiry(s, dateStr, minAdvance);
            });
            if (updated.length === 0) continue;
            const changed = slots.some((s, i) => (s.status || 'available') !== 'booked' && (s.expiryTime !== updated[i].expiryTime));
            if (!changed) continue;
            await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: updated });
        }
        cachedSchedules = await loadAllSchedules();
    }

    // Permanently delete all expired (available, past expiryTime) slot records in bulk.
    async function deleteAllExpiredSlots() {
        const user = auth.currentUser;
        if (!user) return;
        const nowMs = Date.now();
        const today = getTodayDateString();
        const all = await loadAllSchedules();
        let deletedCount = 0;
        for (const sch of all) {
            if (sch.blocked === true) continue;
            const dateStr = sch.date || sch.id || '';
            const slots = sch.slots || [];
            const kept = slots.filter((s) => {
                const status = s.status || 'available';
                if (status === 'booked' || status === 'ongoing' || status === 'completed') return true;
                return !isSlotExpired(s, nowMs);
            });
            if (kept.length === slots.length) continue;
            try {
                if (kept.length === 0) {
                    await deleteDoc(scheduleDoc(user.uid, dateStr));
                    deletedCount += slots.length;
                } else {
                    await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: kept });
                    deletedCount += slots.length - kept.length;
                }
            } catch (err) {
                console.error('Delete expired slots error:', err);
            }
        }
        invalidateSchedulesCache();
        cachedSchedules = await loadAllSchedules();
        if (gridViewActive) loadWeeklyScheduleView();
        else loadSchedulesView();
        loadBlockedDatesView();
        return deletedCount;
    }

    async function loadAllSchedules() {
        const user = auth.currentUser;
        if (!user) return [];
        const snap = await getDocs(scheduleCol(user.uid));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    // Returns ms until the next expiry (next available slot with expiryTime > now), or null if none.
    function getMsUntilNextExpiry(schedules, nowMs) {
        nowMs = nowMs ?? Date.now();
        let nextExpiryMs = null;
        for (const sch of schedules || []) {
            if (sch.blocked === true) continue;
            for (const s of sch.slots || []) {
                if ((s.status || 'available') === 'booked') continue;
                const expiry = s.expiryTime != null ? Number(s.expiryTime) : null;
                if (expiry == null || expiry <= nowMs) continue;
                if (nextExpiryMs === null || expiry < nextExpiryMs) nextExpiryMs = expiry;
            }
        }
        return nextExpiryMs != null ? Math.max(0, nextExpiryMs - nowMs) : null;
    }

    // Schedules a single re-render at the next slot expiry. When expiry hits, marks expired slots in Firebase and updates UI.
    function scheduleNextExpiryRerender(schedules) {
        if (nextCleanupTimerId) clearTimeout(nextCleanupTimerId);
        nextCleanupTimerId = null;
        const ms = getMsUntilNextExpiry(schedules);
        if (ms === null) return;
        nextCleanupTimerId = setTimeout(async () => {
            nextCleanupTimerId = null;
            await markExpiredSlotsInFirebase();
            if (gridViewActive) loadWeeklyScheduleView();
            else loadSchedulesView();
            scheduleNextExpiryRerender(cachedSchedules);
        }, ms);
    }

    // Starts realtime listener on schedules; expired slots are marked in Firebase and filtered in UI.
    function startSchedulesRealtime() {
        const user = auth.currentUser;
        if (!user || schedulesUnsubscribe) return;
        schedulesUnsubscribe = onSnapshot(scheduleCol(user.uid), (snapshot) => {
            const schedules = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
            cachedSchedules = schedules;
            scheduleNextExpiryRerender(schedules);
            if (gridViewActive) loadWeeklyScheduleView();
            else loadSchedulesView();
            loadBlockedDatesView();
        }, (err) => {
            console.error('Schedules listener error:', err);
            if (typeof showToast === 'function') showToast('Could not load schedules. Check your connection.');
        });
    }

    function stopSchedulesRealtime() {
        if (schedulesUnsubscribe) { schedulesUnsubscribe(); schedulesUnsubscribe = null; }
    }

    // Returns schedules from cache. Realtime updates come from onSnapshot; call startSchedulesRealtime() once.
    async function ensureSchedulesLoaded() {
        if (cachedSchedules !== null) return cachedSchedules;
        try {
            const all = await loadAllSchedules();
            cachedSchedules = all;
            startSchedulesRealtime();
            scheduleNextExpiryRerender(all);
            return all;
        } catch (err) {
            console.error('Load schedules error:', err);
            if (typeof showToast === 'function') showToast('Could not load schedules. Check your connection and try again.');
            return [];
        }
    }

    // List view order: today → upcoming days (soonest first) → past days (most recent first) → missing date last.
    function compareScheduleDatesForVetList(aDate, bDate, todayStr) {
        const da = aDate || '';
        const db = bDate || '';
        const bucket = (d) => {
            if (!d) return 3;
            if (d === todayStr) return 0;
            if (d > todayStr) return 1;
            return 2;
        };
        const ba = bucket(da);
        const bb = bucket(db);
        if (ba !== bb) return ba - bb;
        if (ba === 1) return da.localeCompare(db);
        if (ba === 2) return db.localeCompare(da);
        return da.localeCompare(db);
    }

    function filterSchedules(schedules, filterMode, specificDate) {
        if (!schedules?.length) return [];
        const todayStr = getTodayDateString();
        const sorted = [...schedules].sort((a, b) => compareScheduleDatesForVetList(a.date || '', b.date || '', todayStr));
        if (filterMode === 'today') return sorted.filter((s) => (s.date || '') === todayStr);
        if (filterMode === 'date' && specificDate) return sorted.filter((s) => (s.date || '') === specificDate);
        return sorted;
    }

    function renderBlockedDatesView(blockedSchedules) {
        const list = $('blocked-dates-list');
        const empty = $('blocked-dates-empty');
        if (!list) return;
        list.innerHTML = '';
        if (!blockedSchedules?.length) {
            list.classList.add('is-hidden');
            empty?.classList.remove('is-hidden');
            return;
        }
        list.classList.remove('is-hidden');
        empty?.classList.add('is-hidden');
        const sorted = [...blockedSchedules].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        sorted.forEach((sch) => {
            const dateStr = sch.date || sch.id || '';
            const item = document.createElement('div');
            item.className = 'blocked-dates-item';
            item.innerHTML = `
                <span class="blocked-dates-item-date">${escapeHtml(formatDisplayDate(dateStr))}</span>
                <button type="button" class="schedules-unblock-btn" data-date="${escapeHtml(dateStr)}" aria-label="Unblock date"><i class="fa fa-undo" aria-hidden="true"></i> Unblock</button>
            `;
            item.querySelector('.schedules-unblock-btn')?.addEventListener('click', () => blockDatesApi.unblockDate(dateStr));
            list.appendChild(item);
        });
    }

    async function loadBlockedDatesView() {
        const all = await ensureSchedulesLoaded();
        const blocked = all.filter((s) => s.blocked === true);
        renderBlockedDatesView(blocked);
    }

    function dedupeSlots(slots, dateStr) {
        const seen = new Set();
        return slots.filter((s) => {
            const key = `${dateStr}|${s.start}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // Display/filter status when appointment doc is completed but schedule slot was not synced yet.
    function slotEffectiveStatus(s) {
        return (s && s.__displayStatus) || (s && s.status) || 'available';
    }

    function cloneSchedulesShallow(schedules) {
        return (schedules || []).map((sch) => ({
            ...sch,
            slots: (sch.slots || []).map((slot) => ({ ...slot })),
        }));
    }

    function isAptCompletedInFirestore(aptData) {
        if (!aptData || typeof aptData !== 'object') return false;
        if (isVideoSessionEnded(aptData)) return true;
        return String(aptData.status || '').toLowerCase() === 'completed';
    }

    // Match Join button: after slot end, show as finished in the list even if schedule doc still says booked.
    function isPastAppointmentSlotEndForDisplay(aptData) {
        const endAt = getAppointmentSlotEndDate(aptData);
        return !!(endAt && Date.now() >= endAt.getTime());
    }

    const scheduleRepairInFlight = new Set();

    async function repairVetScheduleSlotToCompleted(vetUid, dateStr, appointmentId, slotStart) {
        if (!vetUid || !dateStr || !appointmentId) return;
        const ref = scheduleDoc(vetUid, dateStr);
        const snap = await getDoc(ref);
        if (!snap.exists()) return;
        const norm = (t) => normalizeTimeString(String(t || ''));
        const normStart = normalizeTimeString(slotStart || '');
        const slots = (snap.data().slots || []).map((slot) => {
            const matchById = String(slot.appointmentId || '') === String(appointmentId);
            const matchBySlot = normStart && norm(slot.start) === normStart;
            const cur = slot.status || 'booked';
            if ((matchById || matchBySlot) && (cur === 'booked' || cur === 'ongoing')) {
                return { ...slot, status: 'completed' };
            }
            return slot;
        });
        await updateDoc(ref, { slots, updatedAt: serverTimestamp() });
    }

    function queueScheduleSlotRepairIfNeeded(vetUid, dateStr, appointmentId, slotStart) {
        const k = `${dateStr}|${appointmentId}`;
        if (scheduleRepairInFlight.has(k)) return;
        scheduleRepairInFlight.add(k);
        repairVetScheduleSlotToCompleted(vetUid, dateStr, appointmentId, slotStart)
            .catch((e) => console.warn('Schedule slot repair:', e))
            .finally(() => setTimeout(() => scheduleRepairInFlight.delete(k), 8000));
    }

    // For booked/ongoing slots with an appointmentId, load appointment docs and mark display (and optionally repair Firestore) when the appointment is already completed.
    async function resolveAppointmentFromScheduleSlot(vetId, dateStr, slotStart) {
        const safeVetId = String(vetId || '').trim();
        const safeDate = String(dateStr || '').trim();
        const safeStart = normalizeTimeString(String(slotStart || '').trim());
        if (!safeVetId || !safeDate || !safeStart) return null;
        try {
            const qPrimary = query(
                collection(db, 'appointments'),
                where('vetId', '==', safeVetId),
                where('dateStr', '==', safeDate),
                where('slotStart', '==', safeStart),
            );
            const snapPrimary = await getDocs(qPrimary);
            if (!snapPrimary.empty) {
                const first = snapPrimary.docs[0];
                return { id: first.id, ...first.data() };
            }
            const qFallback = query(
                collection(db, 'appointments'),
                where('vetId', '==', safeVetId),
                where('date', '==', safeDate),
                where('slotStart', '==', safeStart),
            );
            const snapFallback = await getDocs(qFallback);
            if (!snapFallback.empty) {
                const first = snapFallback.docs[0];
                return { id: first.id, ...first.data() };
            }
        } catch (_) {}
        return null;
    }

    async function enrichSchedulesWithAppointmentStatus(schedules) {
        const cloned = cloneSchedulesShallow(schedules);
        const ids = new Set();
        const unresolvedSlots = [];
        cloned.forEach((sch) => {
            (sch.slots || []).forEach((s) => {
                const st = s.status || 'available';
                const aid = (s.appointmentId || '').trim();
                if (st !== 'booked' && st !== 'ongoing') return;
                if (aid) {
                    ids.add(aid);
                    return;
                }
                unresolvedSlots.push({
                    vetId: s.vetId || auth.currentUser?.uid || '',
                    dateStr: sch.date || sch.id || '',
                    slotStart: s.start || '',
                });
            });
        });
        if (!ids.size && !unresolvedSlots.length) return cloned;

        const aptMap = new Map();
        await Promise.all(
            [...ids].map(async (id) => {
                try {
                    const snap = await getDoc(appointmentDoc(id));
                    if (snap.exists()) aptMap.set(id, snap.data());
                } catch (_) {}
            }),
        );
        await Promise.all(
            unresolvedSlots.map(async (slot) => {
                const key = `${slot.vetId}|${slot.dateStr}|${normalizeTimeString(slot.slotStart)}`;
                if (aptMap.has(key)) return;
                const resolved = await resolveAppointmentFromScheduleSlot(slot.vetId, slot.dateStr, slot.slotStart);
                if (resolved?.id) {
                    aptMap.set(key, resolved);
                    aptMap.set(resolved.id, resolved);
                }
            }),
        );

        const vetUid = auth.currentUser?.uid || '';
        cloned.forEach((sch) => {
            const dateStr = sch.date || sch.id || '';
            (sch.slots || []).forEach((s) => {
                const st = s.status || 'available';
                const aid = (s.appointmentId || '').trim();
                if (!aid || (st !== 'booked' && st !== 'ongoing')) return;
                const data = aptMap.get(aid);
                if (isAptCompletedInFirestore(data)) {
                    s.__displayStatus = 'completed';
                    if (vetUid && dateStr) queueScheduleSlotRepairIfNeeded(vetUid, dateStr, aid, s.start || '');
                } else if (data && isPastAppointmentSlotEndForDisplay(data)) {
                    s.__displayStatus = 'completed';
                }
            });
        });
        cloned.forEach((sch) => {
            const dateStr = sch.date || sch.id || '';
            (sch.slots || []).forEach((s) => {
                const st = s.status || 'available';
                const aid = (s.appointmentId || '').trim();
                if (aid || (st !== 'booked' && st !== 'ongoing')) return;
                const key = `${s.vetId || auth.currentUser?.uid || ''}|${dateStr}|${normalizeTimeString(s.start || '')}`;
                const data = aptMap.get(key);
                if (!data) return;
                if (isAptCompletedInFirestore(data) || isPastAppointmentSlotEndForDisplay(data)) {
                    s.__displayStatus = 'completed';
                }
                if (isAptCompletedInFirestore(data) && data.id && vetUid && dateStr) {
                    queueScheduleSlotRepairIfNeeded(vetUid, dateStr, data.id, s.start || '');
                }
            });
        });
        return cloned;
    }

    function formatDisplayDate(dateStr) {
        if (!dateStr) return '—';
        return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    function parseTimeParts(timeStr) {
        if (timeStr == null || !String(timeStr).trim()) return null;
        const parts = String(timeStr).trim().split(':');
        const h = parseInt(parts[0], 10);
        const m = parts[1] != null ? parseInt(parts[1], 10) : 0;
        return isNaN(h) ? null : { h, m };
    }

    function formatTime12h(timeStr, withAmPm = true) {
        if (!timeStr || typeof timeStr !== 'string') return timeStr || '—';
        const p = parseTimeParts(timeStr);
        if (!p) return timeStr || '—';
        const hour = p.h % 12 || 12;
        const min = isNaN(p.m) ? '00' : String(p.m).padStart(2, '0');
        return withAmPm ? `${hour}:${min} ${p.h < 12 ? 'AM' : 'PM'}` : `${hour}:${min}`;
    }

    const formatTimeCompact = (timeStr) => formatTime12h(timeStr, false);

    function formatTimeRangeCompact(startStr, endStr) {
        const start = formatTimeCompact(startStr);
        const end = formatTimeCompact(endStr);
        if (start === '—' || end === '—') return `${start} – ${end}`;
        const sh = parseInt(String(startStr || '').split(':')[0], 10);
        const eh = parseInt(String(endStr || '').split(':')[0], 10);
        if (isNaN(sh) || isNaN(eh)) return `${start} – ${end}`;
        if (sh < 12 && eh < 12) return `${start}–${end} AM`;
        if (sh >= 12 && eh >= 12) return `${start}–${end} PM`;
        return `${formatTime12h(startStr)} – ${formatTime12h(endStr)}`;
    }

    // === Appointment details modal (same format as pet owner; Owner instead of Vet) ===
    const detailsApi = createDetailsApi({
        $, auth, db, doc, getDoc, appointmentDoc,
        formatDisplayDate, formatTime12h,
        getJoinAvailableLabel, isConsultationPdfAvailable, canRejoinVideoConsultation, isVideoJoinClosed,
        setCurrentDetailsApt: (v) => { currentDetailsApt = v; },
        resolveAppointmentFromSlotData: async (slotData) => {
            const dateStr = String(slotData?.dateStr || '').trim();
            const slotStart = String(slotData?.timeStart || '').trim();
            const vetId = String(slotData?.vetId || auth.currentUser?.uid || '').trim();
            if (!dateStr || !slotStart || !vetId) return null;
            try {
                const qPrimary = query(
                    collection(db, 'appointments'),
                    where('vetId', '==', vetId),
                    where('dateStr', '==', dateStr),
                    where('slotStart', '==', slotStart)
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
                    where('slotStart', '==', slotStart)
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
        }
    });
    function loadSchedulesView() {
        return viewRenderingApi?.loadSchedulesView();
    }

    function loadWeeklyScheduleView() {
        return viewRenderingApi?.loadWeeklyScheduleView();
    }

    function openSlotDetailsModal(appointmentId, slotDataFromRow) {
        const aptId = String(appointmentId || '').trim();
        // Mark as seen eagerly so badge updates immediately (details modal counts as "viewed").
        if (aptId) markAppointmentNotificationsSeen(aptId).catch(() => {});
        return detailsApi.openSlotDetailsModal(appointmentId, slotDataFromRow);
    }

    // === Date/slot helpers (parse, template slots, conflict) ===
    function parseLocalDate(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function toLocalDateString(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function getWeekdayFromDate(date) {
        return DAY_NAMES[date.getDay()];
    }

    // Get slots from template for a date, optionally filtering out slots that are past or within min-advance (for apply-template).
    function getSlotsForDateFromTemplate(template, date, minAdvanceMinutes, filterPastCutoff = false) {
        const dateStr = toLocalDateString(date);
        const mins = minAdvanceMinutes ?? getMinAdvanceMinutes();
        let raw = [];
        const dayName = getWeekdayFromDate(date);
        if (template.type === 'week' && template.days) {
            const slots = template.days[dayName];
            raw = Array.isArray(slots) ? slots.filter((s) => s.start && s.end && s.start < s.end).map((s) => ({ start: s.start, end: s.end, status: 'available' })) : [];
        } else if (template.type === 'day' && template.slots) {
            raw = template.slots.filter((s) => s.start && s.end && s.start < s.end).map((s) => ({ start: s.start, end: s.end, status: 'available' }));
        }
        let result = raw.map((s) => ({ ...s, expiryTime: computeExpiryTimeMs(dateStr, s.start, mins) }));
        if (filterPastCutoff) {
            result = result.filter((s) => !isSlotPastCutoff(dateStr, s.start, mins));
        }
        return result;
    }

    function slotsOverlap(slotA, slotB) {
        return slotA.start < slotB.end && slotB.start < slotA.end;
    }

    function getConflictCase(existingSlots, newSlots) {
        if (!existingSlots?.length || !newSlots?.length) return { case: 1 };
        const hasBookedOverlap = existingSlots.some((e) => (e.status || 'available') === 'booked' && newSlots.some((n) => slotsOverlap(e, n)));
        if (hasBookedOverlap) return { case: 3 };
        const hasOverlap = existingSlots.some((e) => newSlots.some((n) => slotsOverlap(e, n)));
        return { case: hasOverlap ? 2 : 1 };
    }

    function mergeSlots(existingSlots, newSlots) {
        const merged = [...(existingSlots || [])];
        for (const neu of newSlots || []) {
            const overlaps = merged.some((e) => slotsOverlap(e, neu));
            if (!overlaps) merged.push({ ...neu, status: neu.status || 'available' });
        }
        return merged.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    }

    function showToast(message) {
        return templateApi?.showToast(message);
    }

    function bindAvailabilityPanelsToggle() {
        const btn = $('availability-panels-toggle-btn');
        if (!btn) return;

        const topRow = document.querySelector('.appointments-top-row');
        const divider = document.querySelector('.appointments-partition-horizontal');
        if (!topRow || !divider) return;

        const setCollapsed = (collapsed) => {
            topRow.classList.toggle('is-hidden', collapsed);
            divider.classList.toggle('is-hidden', collapsed);

            const icon = btn.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-bars', collapsed);
                icon.classList.toggle('fa-times', !collapsed);
            }
            const label = collapsed ? 'Show templates and blocked dates' : 'Hide templates and blocked dates';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
            btn.dataset.collapsed = collapsed ? '1' : '0';
        };

        setCollapsed(btn.dataset.collapsed === '1');
        btn.addEventListener('click', () => setCollapsed(!(btn.dataset.collapsed === '1')));
    }

    // === Event bindings ===
    document.addEventListener('DOMContentLoaded', () => {
        const pageBootstrapEl = $('appointments-page-bootstrap');
        const setPageBootstrap = (active) => {
            if (!pageBootstrapEl) return;
            pageBootstrapEl.classList.toggle('is-hidden', !active);
            pageBootstrapEl.setAttribute('aria-hidden', active ? 'false' : 'true');
            document.body.classList.toggle('appointments-loading', !!active);
            if (active) pageBootstrapEl.setAttribute('aria-busy', 'true');
            else pageBootstrapEl.removeAttribute('aria-busy');
        };

        const skipFullPageBootstrap = document.body.classList.contains('no-cat-on-load');
        if (!skipFullPageBootstrap) setPageBootstrap(true);
        else setPageBootstrap(false);
        bindAvailabilityPanelsToggle();

        // Add unread badge container to Booked filter button (appointments notifications).
        (function ensureBookedFilterBadge() {
            const bookedBtn = document.getElementById('schedules-slot-booked');
            if (!bookedBtn) return;
            if (bookedBtn.querySelector('.slot-filter-notif-badge')) return;
            const badge = document.createElement('span');
            badge.className = 'slot-filter-notif-badge';
            badge.setAttribute('aria-hidden', 'true');
            bookedBtn.appendChild(badge);
        })();

        function setBookedFilterUnreadBadge(unreadCount) {
            const bookedBtn = document.getElementById('schedules-slot-booked');
            const badge = bookedBtn?.querySelector?.('.slot-filter-notif-badge');
            if (!badge) return;
            const n = Number(unreadCount);
            const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
            const text = v > 9 ? '9+' : (v > 0 ? String(v) : '');
            badge.textContent = text;
            badge.classList.toggle('is-visible', !!text);
            badge.setAttribute('aria-hidden', text ? 'false' : 'true');
        }

        const setTemplateType = (type) => {
            templateType = type;
            templateApi?.syncTemplateTypeUI();
            templateApi?.toggleWeekDaySections();
        };
        document.querySelectorAll('input[name="template-type"]').forEach((radio) => radio.addEventListener('change', () => setTemplateType(radio.value)));
        document.querySelectorAll('.template-type-option').forEach((opt) => opt.addEventListener('click', (e) => { const input = opt.querySelector('input'); if (input && !input.checked) { input.checked = true; setTemplateType(input.value); } }));

        templateApi = createTemplateApi({
            $, auth, DAYS, DAY_LABELS, escapeHtml, typeLabel, formatTime12h,
            setModalVisible, setErrorEl, getTodayDateString,
            templateCol, templateDoc, addDoc, updateDoc, deleteDoc,
            parseLocalDate, toLocalDateString, getSlotsForDateFromTemplate, getConflictCase, mergeSlots,
            ensureSlotExpiry, getMinAdvanceMinutes, scheduleDoc, getDoc, setDoc,
            invalidateSchedulesCache, loadSchedulesView, loadWeeklyScheduleView,
            getEditingTemplateId: () => editingTemplateId, setEditingTemplateId: (v) => { editingTemplateId = v; },
            getTemplateType: () => templateType, setTemplateType: (v) => { templateType = v; },
            getSelectedDay: () => selectedDay, setSelectedDay: (v) => { selectedDay = v; },
            getWeekSlots: () => weekSlots, setWeekSlots: (v) => { weekSlots = v; },
            getDaySlots: () => daySlots, setDaySlots: (v) => { daySlots = v; },
            getCurrentTemplateAction: () => currentTemplateAction, setCurrentTemplateAction: (v) => { currentTemplateAction = v; },
            getCachedTemplates: () => cachedTemplates
        });

        registerTemplateEvents({
            $, onOverlayClick, templateApi,
            getWeekSlots: () => weekSlots,
            getSelectedDay: () => selectedDay,
            getDaySlots: () => daySlots,
            getCurrentTemplateAction: () => currentTemplateAction,
            loadTemplates
        });

        const bookingSettingsApi = createBookingSettingsApi({
            $, setModalVisible, onOverlayClick,
            getMinAdvanceMinutes,
            getConsultationPriceCentavosTest,
            getConsultationPriceCentavosLive,
            formatMinutesForDisplay,
            MIN_ADVANCE_MIN, MIN_ADVANCE_MAX_MINUTES,
            MIN_CONSULTATION_PRICE_CENTAVOS_LIVE,
            MIN_CONSULTATION_PRICE_CENTAVOS_TEST,
            saveVetSettings, invalidateSchedulesCache, recalcExpiryForFutureSlots,
            scheduleNextExpiryRerender, getCachedSchedules: () => cachedSchedules,
            getGridViewActive: () => gridViewActive,
            loadWeeklyScheduleView, loadSchedulesView, loadBlockedDatesView,
            showToast
        });
        const updateMinAdvanceInputs = bookingSettingsApi.updateMinAdvanceInputs;
        const updateConsultationPriceInputs = bookingSettingsApi.updateConsultationPriceInputs;
        const updateCurrentAdvanceDisplay = bookingSettingsApi.updateCurrentAdvanceDisplay;
        const updateCurrentConsultationFeeDisplay = bookingSettingsApi.updateCurrentConsultationFeeDisplay;
        const openBookingSettingsModal = bookingSettingsApi.openBookingSettingsModal;
        const closeBookingSettingsModal = bookingSettingsApi.closeBookingSettingsModal;
        bookingSettingsApi.bindBookingSettingsEvents();

        const escapeModals = [
            ['conflict-modal', () => templateApi.closeConflictModal(true)],
            ['edit-day-modal', editDayApi.closeEditDayModal],
            ['block-modal', blockDatesApi.closeBlockModal],
            ['template-view-modal', templateApi.closeViewModal],
            ['apply-modal', templateApi.closeApplyModal],
            ['booking-settings-modal', () => closeBookingSettingsModal(true)],
            ['template-action-modal', templateApi.closeTemplateActionModal],
            ['template-modal', templateApi.closeModal],
        ];
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const intervalPanel = $('template-interval-panel');
            if (intervalPanel && !intervalPanel.classList.contains('is-hidden')) {
                e.preventDefault();
                templateApi.closeGenerateIntervalModal();
                return;
            }
            const pair = escapeModals.find(([id]) => !$(id)?.classList.contains('is-hidden'));
            if (pair) pair[1]();
        });

        registerBlockDatesEvents({
            $, onOverlayClick,
            openBlockModal: () => blockDatesApi.openBlockModal(),
            closeBlockModal: () => blockDatesApi.closeBlockModal(),
            doBlockDates: () => blockDatesApi.doBlockDates()
        });
        registerModalEvents({
            $, onOverlayClick, detailsApi, editDayApi,
            currentDetailsAptRef: () => currentDetailsApt,
            downloadConsultationReportForAppointment, editDaySlotsRef: () => editDaySlots
        });

        viewRenderingApi = createViewRenderingApi({
            $, auth, escapeHtml,
            formatDisplayDate, formatTime12h, formatTimeRangeCompact, parseTimeParts,
            WEEK_START_HOUR, WEEK_END_HOUR, HOUR_HEIGHT, WEEKDAY_LABELS,
            slotEffectiveStatus, dedupeSlots, ensureSlotExpiry, isSlotExpired, getMinAdvanceMinutes,
            ensureSchedulesLoaded, enrichSchedulesWithAppointmentStatus, filterSchedules, getActiveSlotFilter,
            toLocalDateString, getTodayDateString,
            getGridViewActive: () => gridViewActive,
            openSlotDetailsModal,
            openEditDayModal: (dateStr) => editDayApi.openEditDayModal(dateStr)
            ,
            getUnreadNotifCountForAppointment: (appointmentId) => {
                const k = String(appointmentId || '').trim();
                if (!k) return 0;
                return unreadNotifByAppointmentId.get(k) || 0;
            }
        });

        const { syncGridOptionVisibility } = registerViewModeEvents({
            $,
            getTodayDateString,
            getWeekRangeForFilter: (weekFilter, specificDateStr) => (
                viewRenderingApi?.getWeekRangeForFilter(weekFilter, specificDateStr)
                || (() => {
                    const d = new Date();
                    d.setDate(d.getDate() - d.getDay());
                    const end = new Date(d);
                    end.setDate(d.getDate() + 6);
                    return { start: toLocalDateString(d), end: toLocalDateString(end), startDate: d, endDate: end };
                })()
            ),
            getActiveSlotFilter,
            loadSchedulesView, loadWeeklyScheduleView,
            getGridViewActive: () => gridViewActive,
            setGridViewActive: (v) => { gridViewActive = v; },
            openBookingSettingsModal, deleteAllExpiredSlots, showToast
        });

        async function refreshSchedulesWithCleanup() {
            invalidateSchedulesCache();
            await ensureSchedulesLoaded();
            await markExpiredSlotsInFirebase();
            if (gridViewActive) await loadWeeklyScheduleView();
            else await loadSchedulesView();
            loadBlockedDatesView();
        }

        async function initAppointments() {
            try {
                if (!skipFullPageBootstrap) setPageBootstrap(true);
                await loadVetSettings();
                updateMinAdvanceInputs();
                updateConsultationPriceInputs();
                updateCurrentAdvanceDisplay();
                updateCurrentConsultationFeeDisplay();
                loadTemplates();
                await ensureSchedulesLoaded();
                await markExpiredSlotsInFirebase();
                loadBlockedDatesView();
                const slotFilterParam = new URLSearchParams(window.location.search).get('slotFilter');
                const slotFilterBtn = slotFilterParam
                    && document.querySelector(`.schedules-slot-btn[data-slot-filter="${CSS.escape(slotFilterParam)}"]`);
                if (slotFilterBtn) slotFilterBtn.click();
                else loadSchedulesView();
                syncGridOptionVisibility();

                // Realtime appointment notifications (unread badges inside slot threads + sidebar badge).
                if (typeof notifUnsub === 'function') {
                    notifUnsub();
                    notifUnsub = null;
                }
                notifUnsub = subscribeVetAppointmentNotifications((state) => {
                    unreadNotifByAppointmentId = state?.byAppointmentId instanceof Map
                        ? state.byAppointmentId
                        : new Map();
                    setBookedFilterUnreadBadge(state?.unreadCount || 0);
                    // Refresh current view so badges track filters (date/status) accurately.
                    if (gridViewActive) loadWeeklyScheduleView();
                    else loadSchedulesView();
                });

                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') refreshSchedulesWithCleanup();
                });
            } finally {
                setPageBootstrap(false);
            }
        }

        if (auth.currentUser) {
            initAppointments();
        } else {
            const unsub = auth.onAuthStateChanged((user) => {
                if (user) { initAppointments(); unsub(); }
            });
        }
    });
})();
