/**
 * Televet Health — Vet Appointments
 * Availability templates (week/day) & schedules management
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

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
    const typeLabel = (t) => (t?.type === 'week' ? 'Week template' : 'Day template');

    // === State ===
    let selectedDay = 'monday', editingTemplateId = null, cachedTemplates = [], weekSlots = {}, daySlots = [];
    let templateType = 'week', gridViewActive = false, cachedSchedules = null, nextCleanupTimerId = null;
    let cachedVetSettings = { minAdvanceBookingMinutes: DEFAULT_MIN_ADVANCE_MINUTES };
    let currentTemplateAction = null, schedulesUnsubscribe = null;
    let blockCalendarMonth = null, blockSelectedDates = new Set(), blockPreviouslyBlocked = new Set();
    let editDayDateStr = null, editDaySlots = [];

    // === DOM & UI helpers ===
    const invalidateSchedulesCache = () => { cachedSchedules = null; };
    const escapeHtml = (text) => { const d = document.createElement('div'); d.textContent = text == null ? '' : String(text); return d.innerHTML; };
    function setModalVisible(overlayId, modalId, visible) {
        const hidden = !visible;
        [$(overlayId), $(modalId)].forEach((el) => { if (el) { el.classList.toggle('is-hidden', hidden); el.setAttribute('aria-hidden', String(hidden)); } });
    }
    const onOverlayClick = (overlayId, closeFn) => $(overlayId)?.addEventListener('click', (e) => { if (e.target.id === overlayId) closeFn(); });
    const setErrorEl = (id, msg, hidden) => { const el = $(id); if (el) { el.textContent = msg ?? ''; el.classList.toggle('is-hidden', !!hidden); } };

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
            card.addEventListener('click', () => openTemplateActionModal(t));
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTemplateActionModal(t); } });
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
    const getTodayDateString = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const getActiveSlotFilter = () => document.querySelector('.schedules-slot-btn.active')?.dataset?.slotFilter || 'all';
    const getMinAdvanceMinutes = () => cachedVetSettings?.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;

    /** Compute expiryTime (ms) for a slot: slot start time minus advance booking limit. */
    function computeExpiryTimeMs(dateStr, slotStart, minAdvanceMinutes) {
        const [h, m] = (slotStart || '').split(':').map(Number);
        const slotMins = (h || 0) * 60 + (m || 0);
        const d = new Date(dateStr + 'T00:00:00');
        d.setMinutes(d.getMinutes() + slotMins - (minAdvanceMinutes ?? getMinAdvanceMinutes()));
        return d.getTime();
    }

    /** Returns true if slot is expired (available and past expiryTime, or already marked expired). Booked slots are not considered expired for display.
     *  Security: Pet owner booking must only allow slots where !isSlotExpired(slot, Date.now()) && (slot.status || 'available') === 'available'. */
    function isSlotExpired(slot, nowMs) {
        const status = slot.status || 'available';
        if (status === 'booked') return false;
        if (status === 'expired') return true;
        const expiry = slot.expiryTime != null ? Number(slot.expiryTime) : null;
        if (expiry == null) return false;
        return nowMs >= expiry;
    }

    /** Update Firebase: set status to "expired" for slots that are available and past expiryTime. Makes expiry visible in DB. */
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
                if (status === 'booked') return s;
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

    /** Returns true if slot is past cutoff (past date, or within min advance window today). Booked slots should always be shown. */
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

    /** Ensure slot has expiryTime (for legacy slots). Uses dateStr and slot.start. */
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
                cachedVetSettings = { minAdvanceBookingMinutes: data.minAdvanceBookingMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES };
            }
        } catch (err) {
            console.error('Load vet settings error:', err);
        }
    }

    async function saveVetSettings(minAdvanceMinutes) {
        const user = auth.currentUser;
        if (!user) return;
        try {
            await setDoc(vetSettingsDoc(user.uid), { minAdvanceBookingMinutes: minAdvanceMinutes }, { merge: true });
            cachedVetSettings = { minAdvanceBookingMinutes: minAdvanceMinutes };
        } catch (err) {
            console.error('Save vet settings error:', err);
            throw err;
        }
    }

    /** Recalculate expiryTime for all future unbooked slots and update Firestore. */
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

    /** Permanently delete all expired (available, past expiryTime) slot records in bulk. */
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
                if ((s.status || 'available') === 'booked') return true;
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

    /** Returns ms until the next expiry (next available slot with expiryTime > now), or null if none. */
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

    /** Schedules a single re-render at the next slot expiry. When expiry hits, marks expired slots in Firebase and updates UI. */
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

    /** Starts realtime listener on schedules; expired slots are marked in Firebase and filtered in UI. */
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

    /** Returns schedules from cache. Realtime updates come from onSnapshot; call startSchedulesRealtime() once. */
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

    function filterSchedules(schedules, filterMode, specificDate) {
        if (!schedules?.length) return [];
        const sorted = [...schedules].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        if (filterMode === 'today') return sorted.filter((s) => (s.date || '') === getTodayDateString());
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
            item.querySelector('.schedules-unblock-btn')?.addEventListener('click', () => unblockDate(dateStr));
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

    const formatDisplayDate = (dateStr) => !dateStr ? '—' : new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

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

    function renderSchedulesView(schedules, slotFilter) {
        const wrap = $('schedules-view-wrap');
        const empty = $('schedules-view-empty');
        const listEl = $('schedules-list');
        if (!wrap || !listEl) return;

        const nonBlocked = (schedules || []).filter((s) => s.blocked !== true);
        if (!nonBlocked?.length) {
            wrap.classList.add('is-hidden');
            empty?.classList.remove('is-hidden');
            const p = empty?.querySelector('p');
            const hint = empty?.querySelector('.schedules-view-empty-hint');
            if (p) p.textContent = 'No schedules to display';
            if (hint) hint.textContent = 'Apply a template to a date range first to generate schedules.';
            return;
        }
        wrap.classList.remove('is-hidden');
        empty?.classList.add('is-hidden');

        const nowMs = Date.now();
        const filter = slotFilter || 'all';
        const showExpiredView = filter === 'expired';
        const renderSlot = (s, dateStr, isExpired = false) => {
            const status = s.status || 'available';
            const extraClass = isExpired ? ' schedules-slot-item-expired' : '';
            return `<div class="schedules-slot-item${extraClass}" data-status="${status}" data-date="${escapeHtml(dateStr)}" data-start="${escapeHtml(s.start)}" data-expired="${isExpired}"><span class="schedules-slot-indicator ${status}" aria-hidden="true"></span><span class="schedules-slot-time">${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}</span></div>`;
        };

        const minAdvance = getMinAdvanceMinutes();
        const blocks = nonBlocked.map((sch) => {
            const dateStr = sch.date || sch.id || '';
            const slots = dedupeSlots((sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance)), dateStr);
            const slotsFilteredByExpiry = slots.filter((s) => {
                if (showExpiredView) return isSlotExpired(s, nowMs);
                if ((s.status || 'available') === 'booked') return true;
                return !isSlotExpired(s, nowMs);
            });
            const filtered = filter === 'available' ? slotsFilteredByExpiry.filter((s) => (s.status || 'available') === 'available')
                : filter === 'booked' ? slotsFilteredByExpiry.filter((s) => s.status === 'booked') : slotsFilteredByExpiry;
            if (!filtered.length) return '';
            const slotHtml = filtered.map((s) => renderSlot(s, dateStr, filter === 'expired')).join('');
            const showEditDay = filter !== 'booked' && filter !== 'expired';
            const editDayBtn = showEditDay ? `<button type="button" class="schedules-edit-day-btn" data-date="${escapeHtml(dateStr)}" aria-label="Edit this day"><i class="fa fa-pencil" aria-hidden="true"></i> Edit day</button>` : '';
            return `<div class="schedules-date-block" data-date="${escapeHtml(dateStr)}">
                <div class="schedules-schedule-header">
                    <h3 class="schedules-date-title">${escapeHtml(formatDisplayDate(dateStr))}</h3>
                    ${editDayBtn}
                </div>
                <div class="schedules-slot-list">${slotHtml}</div>
            </div>`;
        }).filter(Boolean).join('');

        listEl.innerHTML = blocks || (filter !== 'all' ? '<p class="schedules-no-slots">No matching slots in this view.</p>' : '');
        $('schedules-expired-actions')?.classList.toggle('is-hidden', filter !== 'expired');
    }

    async function loadSchedulesView() {
        const filterMode = $('schedules-filter')?.value || 'all';
        const specificDate = $('schedules-date-picker')?.value || '';
        const slotFilter = getActiveSlotFilter();
        const all = await ensureSchedulesLoaded();
        const filtered = filterSchedules(all, filterMode, specificDate);
        renderSchedulesView(filtered, slotFilter);
    }

    // === Weekly schedule grid ===
    function getStartOfWeek(date) {
        const d = new Date(date);
        d.setDate(d.getDate() - d.getDay());
        return d;
    }

    function getWeekRangeForFilter(weekFilter, specificDateStr) {
        const now = new Date();
        let ref = now;
        if (weekFilter === 'specific' && specificDateStr) {
            const d = new Date(specificDateStr + 'T12:00:00');
            if (!isNaN(d.getTime())) ref = d;
        }
        let start = getStartOfWeek(ref);
        if (weekFilter === 'next') start.setDate(start.getDate() + 7);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return { start: toLocalDateString(start), end: toLocalDateString(end), startDate: start, endDate: end };
    }

    function parseTimeToMinutes(timeStr) {
        const p = parseTimeParts(timeStr);
        return p ? p.h * 60 + (isNaN(p.m) ? 0 : p.m) : 0;
    }

    function minsToPxWithinHour(mins) {
        return (mins / 60) * HOUR_HEIGHT;
    }

    function timeToDurationPx(startStr, endStr) {
        const startMins = parseTimeToMinutes(startStr);
        const endMins = parseTimeToMinutes(endStr);
        const startBound = Math.max(startMins, WEEK_START_HOUR * 60);
        const endBound = Math.min(endMins, WEEK_END_HOUR * 60);
        const durationMins = Math.max(0, endBound - startBound);
        return minsToPxWithinHour(durationMins);
    }

    function getDateStrDayIndex(dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        return d.getDay();
    }

    function renderWeeklyScheduleGridFixed(weekSlots, weekRange, slotFilter) {
        const gridEl = $('weekly-schedule-grid');
        const emptyEl = $('weekly-schedule-empty');
        const wrapEl = $('weekly-schedule-grid-wrap');
        const labelEl = $('weekly-schedule-week-label');
        const emptyMsgEl = $('weekly-schedule-empty-msg');

        if (!gridEl) return;

        const totalHours = WEEK_END_HOUR - WEEK_START_HOUR;
        const totalRows = totalHours;
        const startFmt = weekRange.startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const endFmt = weekRange.endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

        const filter = slotFilter || 'all';
        const filtered = filter === 'available' ? weekSlots.filter((x) => (x.slot.status || 'available') === 'available')
            : filter === 'booked' ? weekSlots.filter((x) => x.slot.status === 'booked') : weekSlots;

        const weekDisplayText = `${startFmt} – ${endFmt}`;
        const weekDisplayEl = $('weekly-schedule-week-display');
        if (weekDisplayEl) weekDisplayEl.textContent = `Viewing week: ${weekDisplayText}`;
        if (labelEl) labelEl.textContent = weekDisplayText;

        if (gridViewActive) {
            wrapEl?.classList.remove('is-hidden');
            emptyEl?.classList.add('is-hidden');
        }

        const rows = totalRows + 1;
        const cols = 8;
        let html = '';
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const isCorner = r === 0 && c === 0;
                const isTimeCol = c === 0;
                const isHeaderRow = r === 0;
                let cls = 'weekly-schedule-cell';
                let content = '';
                if (isCorner) {
                    cls += ' weekday-header';
                    content = '';
                } else if (isHeaderRow) {
                    cls += ' weekday-header';
                    content = WEEKDAY_LABELS[c - 1];
                } else if (isTimeCol) {
                    cls += ' time-header';
                    const hour = WEEK_START_HOUR + r - 1;
                    const h12 = hour % 12 || 12;
                    const ampm = hour < 12 ? 'AM' : 'PM';
                    content = `${h12} ${ampm}`;
                } else {
                    cls += ' slot-cell';
                    const hourRow = r - 1;
                    const dayCol = c - 1;
                    const gridRow = r + 1;
                    const gridCol = c + 1;
                    html += `<div class="${cls}" data-day="${dayCol}" data-hour="${hourRow}" style="grid-row:${gridRow};grid-column:${gridCol}"></div>`;
                    continue;
                }
                const gridRow = r === 0 ? 1 : r + 1;
                const gridCol = c + 1;
                html += `<div class="${cls}" style="grid-row:${gridRow};grid-column:${gridCol}">${content}</div>`;
            }
        }

        gridEl.innerHTML = html;
        gridEl.style.gridTemplateRows = `60px repeat(${totalRows}, ${HOUR_HEIGHT}px)`;

        filtered.forEach((item) => {
            const { dateStr, slot } = item;
            const status = slot.status || 'available';
            const dayIdx = getDateStrDayIndex(dateStr);
            const startMins = parseTimeToMinutes(slot.start);
            const startHour = Math.floor(startMins / 60);
            const minsIntoHour = startMins - (startHour * 60);
            const hourRow = Math.max(0, Math.min(startHour - WEEK_START_HOUR, totalRows - 1));
            const top = minsToPxWithinHour(minsIntoHour);
            const durationPx = timeToDurationPx(slot.start, slot.end);
            const height = Math.max(minsToPxWithinHour(30), durationPx);
            const ownerName = slot.ownerName || slot.owner || 'Owner Name';
            const petName = slot.petName || slot.pet || 'Pet Name';
            const isPlaceholder = !slot.ownerName && !slot.owner && !slot.petName && !slot.pet;

            const cell = gridEl.querySelector(`.slot-cell[data-day="${dayIdx}"][data-hour="${hourRow}"]`);
            if (!cell) return;

            const extendsBelow = top + height > HOUR_HEIGHT;
            if (extendsBelow) cell.classList.add('has-extending-event');

            const eventEl = document.createElement('div');
            eventEl.className = `weekly-schedule-event status-${status}`;
            eventEl.style.top = `${top}px`;
            eventEl.style.height = `${Math.max(0, height - 2)}px`;
            if (status === 'booked') {
                eventEl.innerHTML = `
                    <span class="weekly-schedule-event-name ${isPlaceholder ? 'weekly-schedule-event-placeholder' : ''}">${escapeHtml(ownerName)}</span>
                    <span class="weekly-schedule-event-pet ${isPlaceholder ? 'weekly-schedule-event-placeholder' : ''}">${escapeHtml(petName)}</span>
                    <button type="button" class="weekly-schedule-event-btn" data-date="${escapeHtml(dateStr)}" data-start="${escapeHtml(slot.start)}" aria-label="View appointment"><i class="fa fa-eye" aria-hidden="true"></i> View</button>
                `;
                eventEl.querySelector('.weekly-schedule-event-btn')?.addEventListener('click', () => openEditDayModal(dateStr));
            } else {
                const slotLabel = status === 'expired' ? 'Expired' : 'Available';
                eventEl.innerHTML = `
                    <span class="weekly-schedule-event-name">${escapeHtml(slotLabel)}</span>
                    <span class="weekly-schedule-event-pet weekly-schedule-event-time">${escapeHtml(formatTimeRangeCompact(slot.start, slot.end))}</span>
                    <button type="button" class="weekly-schedule-event-btn" data-date="${escapeHtml(dateStr)}" aria-label="Edit this day"><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>
                `;
                eventEl.querySelector('.weekly-schedule-event-btn')?.addEventListener('click', () => openEditDayModal(dateStr));
            }
            cell.appendChild(eventEl);
        });
    }

    async function loadWeeklyScheduleView() {
        const user = auth.currentUser;
        if (!user) return;

        const weekFilter = $('schedules-grid-filter')?.value || 'this';
        const specificWeek = $('schedules-week-picker')?.value || '';
        const weekRange = getWeekRangeForFilter(weekFilter, specificWeek);
        const slotFilter = getActiveSlotFilter();

        const all = await ensureSchedulesLoaded();
        const weekSlots = [];
        const nowMs = Date.now();
        const showExpired = getActiveSlotFilter() === 'expired';
        const minAdvance = getMinAdvanceMinutes();

        const current = new Date(weekRange.startDate);
        const endDay = new Date(weekRange.endDate);
        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            const sch = all.find((s) => (s.date || s.id) === dateStr);
            if (sch && sch.blocked !== true && Array.isArray(sch.slots)) {
                const daySlots = dedupeSlots((sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance)), dateStr);
                daySlots.forEach((slot) => {
                    if (showExpired) {
                        if ((slot.status || 'available') === 'available' && isSlotExpired(slot, nowMs)) weekSlots.push({ dateStr, slot, isExpired: true });
                    } else {
                        if ((slot.status || 'available') === 'booked') weekSlots.push({ dateStr, slot });
                        else if (!isSlotExpired(slot, nowMs)) weekSlots.push({ dateStr, slot });
                    }
                });
            }
            current.setDate(current.getDate() + 1);
        }

        renderWeeklyScheduleGridFixed(weekSlots, weekRange, slotFilter);
    }

    // === Template modal (create/edit) ===
    function initWeekSlots() {
        weekSlots = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    }

    function openModal(template = null) {
        editingTemplateId = template?.id ?? null;
        const overlay = $('template-modal-overlay');
        const modal = $('template-modal');
        if (!overlay || !modal) return;

        $('template-modal-title').textContent = template ? 'Edit template' : 'Create availability template';
        templateType = template?.type || 'week';
        selectedDay = 'monday';
        $('template-name').value = (template?.name || '').trim();
        $('template-type-week').checked = templateType === 'week';
        $('template-type-day').checked = templateType === 'day';

        if (templateType === 'week') {
            initWeekSlots();
            daySlots = [];
            if (template?.days) DAYS.forEach((day) => { weekSlots[day] = (template.days[day] || []).map((s) => ({ start: s.start || '', end: s.end || '' })); });
        } else {
            daySlots = (template?.slots || []).map((s) => ({ start: s.start || '', end: s.end || '' }));
            initWeekSlots();
        }

        syncTemplateTypeUI();
        toggleWeekDaySections();
        renderDaysList();
        renderWeekSlots();
        renderDaySlots();
        populateCopySourceSelect();
        populateCopyFromTemplateSelect();
        hideTemplateError();

        setModalVisible('template-modal-overlay', 'template-modal', true);
        setTimeout(() => $('template-name')?.focus(), 100);
    }

    function closeModal() { editingTemplateId = null; setModalVisible('template-modal-overlay', 'template-modal', false); }

    // === View modal ===
    function openViewModal(template) {
        const titleEl = $('template-view-title');
        const typeEl = $('template-view-type');
        const scheduleEl = $('template-view-schedule');
        if (!titleEl || !typeEl || !scheduleEl) return;

        titleEl.textContent = template.name || 'Unnamed';
        typeEl.textContent = typeLabel(template);
        if (template.type === 'week' && template.days) {
            scheduleEl.innerHTML = DAYS.map((day) => {
                const slots = template.days[day];
                if (!slots?.length) return `<div class="template-view-day"><span class="template-view-day-name">${DAY_LABELS[day]}</span><p>Day off</p></div>`;
                const list = slots.map((s) => `${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}`).join('</li><li>');
                return `<div class="template-view-day"><span class="template-view-day-name">${DAY_LABELS[day]}</span><ul class="template-view-slots"><li>${list}</li></ul></div>`;
            }).join('');
        } else if (template.type === 'day' && template.slots?.length) {
            const list = template.slots.map((s) => `${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}`).join('</li><li>');
            scheduleEl.innerHTML = `<ul class="template-view-slots"><li>${list}</li></ul>`;
        } else {
            scheduleEl.innerHTML = '<p>No schedule</p>';
        }
        setModalVisible('template-view-overlay', 'template-view-modal', true);
    }

    function closeViewModal() { setModalVisible('template-view-overlay', 'template-view-modal', false); }

    // --- Template action modal (popup when clicking a template card) ---
    function openTemplateActionModal(template) {
        if (!$('template-action-overlay') || !$('template-action-modal')) return;
        currentTemplateAction = template;
        const iconEl = $('template-action-modal')?.querySelector('.appointments-template-icon i');
        if (iconEl) iconEl.className = `fa fa-${template.type === 'week' ? 'calendar' : 'clock-o'}`;
        $('template-action-name').textContent = template.name || 'Unnamed';
        $('template-action-meta').textContent = typeLabel(template);
        setModalVisible('template-action-overlay', 'template-action-modal', true);
    }
    function closeTemplateActionModal() { currentTemplateAction = null; setModalVisible('template-action-overlay', 'template-action-modal', false); }

    // === Apply & conflict modals ===
    function openApplyModal(template) {
        const overlay = $('apply-modal-overlay');
        if (!overlay) return;

        const today = getTodayDateString();
        $('apply-template-name').textContent = template.name || 'Unnamed';
        $('apply-start-date').value = '';
        $('apply-end-date').value = '';
        $('apply-start-date').min = today;
        $('apply-end-date').min = today;
        $('apply-error-msg').textContent = '';
        $('apply-error-msg').classList.add('is-hidden');
        overlay.dataset.templateId = template.id;
        overlay.dataset.templateJson = JSON.stringify(template);
        setModalVisible('apply-modal-overlay', 'apply-modal', true);
        setTimeout(() => $('apply-start-date')?.focus(), 100);
    }

    function closeApplyModal() { setModalVisible('apply-modal-overlay', 'apply-modal', false); }

    function showConflictModal(analysis, template, startVal, endVal) {
        const count = analysis.case2.length;
        $('conflict-modal-message').textContent = count === 1
            ? 'Some template time slots conflict with existing slots on the selected date. The conflicting slots are empty (no appointments booked).'
            : `Some template time slots conflict with existing slots on ${count} day(s). The conflicting slots are empty (no appointments booked).`;
        const overlay = $('conflict-modal-overlay');
        overlay.dataset.templateJson = JSON.stringify(template);
        overlay.dataset.startVal = startVal;
        overlay.dataset.endVal = endVal;
        overlay.dataset.case2Json = JSON.stringify(analysis.case2);
        setModalVisible('apply-modal-overlay', 'apply-modal', false);
        setModalVisible('conflict-modal-overlay', 'conflict-modal', true);
    }

    function closeConflictModal(showApplyModal = false) {
        setModalVisible('conflict-modal-overlay', 'conflict-modal', false);
        if (showApplyModal) setModalVisible('apply-modal-overlay', 'apply-modal', true);
    }

    async function executeApplyWithOptions(template, startVal, endVal, replaceDates, skipDates) {
        const errEl = $('apply-error-msg');
        const saveBtn = $('apply-submit-btn');
        if (saveBtn) saveBtn.disabled = true;
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        try {
            const count = await applyTemplateToDateRange(template, startVal, endVal, { replaceDates, skipDates });
            closeApplyModal();
            closeConflictModal();
            showToast(`Schedule created for ${count} day(s).`);
            invalidateSchedulesCache();
            loadSchedulesView();
            loadWeeklyScheduleView();
        } catch (e) {
            if (errEl) { errEl.textContent = e.message || 'Failed to apply template.'; errEl.classList.remove('is-hidden'); }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function doApplyTemplate() {
        const overlay = $('apply-modal-overlay');
        const templateJson = overlay?.dataset?.templateJson;
        const startVal = $('apply-start-date')?.value;
        const endVal = $('apply-end-date')?.value;
        const errEl = $('apply-error-msg');
        const saveBtn = $('apply-submit-btn');

        if (!templateJson || !startVal || !endVal) {
            if (errEl) { errEl.textContent = 'Please select both start and end dates.'; errEl.classList.remove('is-hidden'); }
            return;
        }
        if (startVal < getTodayDateString()) {
            if (errEl) { errEl.textContent = 'Start date cannot be in the past.'; errEl.classList.remove('is-hidden'); }
            return;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }

        try {
            const template = JSON.parse(templateJson);
            const analysis = await analyzeConflictForDateRange(template, startVal, endVal);

            if (analysis.case3.length > 0) {
                const dateList = analysis.case3.length <= 3
                    ? analysis.case3.map(formatDisplayDate).join(', ')
                    : `${analysis.case3.slice(0, 2).map(formatDisplayDate).join(', ')} and ${analysis.case3.length - 2} more`;
                throw new Error(`Some conflicting time slots already have booked appointments (${dateList}). The template cannot be applied until those appointments are rescheduled or cancelled.`);
            }

            if (analysis.case2.length > 0) {
                if (saveBtn) saveBtn.disabled = false;
                showConflictModal(analysis, template, startVal, endVal);
                return;
            }

            const count = await applyTemplateToDateRange(template, startVal, endVal);
            closeApplyModal();
            showToast(`Schedule created for ${count} day(s).`);
            invalidateSchedulesCache();
            loadSchedulesView();
            loadWeeklyScheduleView();
        } catch (e) {
            if (errEl) { errEl.textContent = e.message || 'Failed to apply template.'; errEl.classList.remove('is-hidden'); }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function getConflictOverlayData() {
        const o = $('conflict-modal-overlay');
        const { templateJson, startVal, endVal, case2Json } = o?.dataset || {};
        if (!templateJson || !startVal || !endVal || !case2Json) return null;
        return { template: JSON.parse(templateJson), startVal, endVal, case2: JSON.parse(case2Json) };
    }

    function onConflictReplace() {
        const d = getConflictOverlayData();
        if (!d) return;
        executeApplyWithOptions(d.template, d.startVal, d.endVal, d.case2, []);
    }

    function onConflictCancel() {
        const d = getConflictOverlayData();
        if (!d) return;
        executeApplyWithOptions(d.template, d.startVal, d.endVal, [], d.case2);
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

    /** Get slots from template for a date, optionally filtering out slots that are past or within min-advance (for apply-template). */
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

    async function analyzeConflictForDateRange(template, startDate, endDate) {
        const user = auth.currentUser;
        if (!user) throw new Error('Not signed in');
        const start = parseLocalDate(startDate);
        const end = parseLocalDate(endDate);
        if (start > end) throw new Error('Start date must be before or equal to end date');

        const result = { case1: [], case2: [], case3: [] };
        const current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
            if (existingDoc.exists() && existingDoc.data().blocked === true) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const newSlots = getSlotsForDateFromTemplate(template, current);
            if (newSlots.length === 0) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const existingSlots = existingDoc.exists() ? (existingDoc.data().slots || []) : [];
            const conflict = getConflictCase(existingSlots, newSlots);
            result[`case${conflict.case}`].push(dateStr);
            current.setDate(current.getDate() + 1);
        }
        return result;
    }

    async function applyTemplateToDateRange(template, startDate, endDate, options = {}) {
        const user = auth.currentUser;
        if (!user) throw new Error('Not signed in');
        const start = parseLocalDate(startDate);
        const end = parseLocalDate(endDate);
        if (start > end) throw new Error('Start date must be before or equal to end date');

        const today = getTodayDateString();
        const replaceDates = new Set(options.replaceDates || []);
        const skipDates = new Set(options.skipDates || []);
        const minAdvance = getMinAdvanceMinutes();
        let created = 0;
        const current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            if (dateStr < today) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
            if (existingDoc.exists() && existingDoc.data().blocked === true) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            if (skipDates.has(dateStr)) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const newSlots = getSlotsForDateFromTemplate(template, current, minAdvance, true);
            if (newSlots.length === 0) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const existingSlots = (existingDoc.exists() ? (existingDoc.data().slots || []) : []).map((s) => ensureSlotExpiry(s, dateStr));
            const conflict = getConflictCase(existingSlots, newSlots);

            let finalSlots;
            if (replaceDates.has(dateStr)) {
                finalSlots = newSlots;
            } else if (conflict.case === 1 && existingSlots.length > 0) {
                finalSlots = mergeSlots(existingSlots, newSlots).map((s) => ensureSlotExpiry(s, dateStr));
            } else {
                finalSlots = newSlots;
            }
            await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: finalSlots });
            created++;
            current.setDate(current.getDate() + 1);
        }
        return created;
    }

    // === Slot rendering (week & day) ===
    function createSlotRow(slotsArray, idx, onRemove, opts = {}) {
        const { isEditDay = false } = opts;
        const slot = slotsArray[idx];
        const isBooked = isEditDay && (slot?.status || 'available') === 'booked';
        const disabled = isBooked ? ' disabled' : '';
        const statusIcon = isBooked ? '<span class="template-slot-status-icon template-slot-status-booked" title="Booked"><i class="fa fa-calendar-check-o" aria-hidden="true"></i></span>' : '<span class="template-slot-status-icon" aria-hidden="true"></span>';
        const deleteBtnHtml = isBooked
            ? `<button type="button" class="template-slot-delete" data-slot-index="${idx}" disabled aria-label="Booked slots cannot be removed"><i class="fa fa-trash-o" aria-hidden="true"></i></button>`
            : `<button type="button" class="template-slot-delete" data-slot-index="${idx}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>`;
        const row = document.createElement('div');
        row.className = 'template-slot-row' + (isBooked ? ' template-slot-row-booked' : '');
        row.innerHTML = (isEditDay ? statusIcon : '') + `
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" data-slot-index="${idx}" data-slot-field="start" aria-label="Start time"${disabled}>
            </div>
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" data-slot-index="${idx}" data-slot-field="end" aria-label="End time"${disabled}>
            </div>
            ${deleteBtnHtml}
        `;
        const startInput = row.querySelector('[data-slot-field="start"]');
        const endInput = row.querySelector('[data-slot-field="end"]');
        const deleteBtn = row.querySelector('.template-slot-delete');
        const update = () => { slotsArray[idx].start = startInput?.value ?? ''; slotsArray[idx].end = endInput?.value ?? ''; };
        startInput?.addEventListener('change', update);
        endInput?.addEventListener('change', update);
        if (!isBooked && deleteBtn) deleteBtn.addEventListener('click', () => { slotsArray.splice(idx, 1); onRemove(); });
        return row;
    }

    function renderSlotsList(containerId, slotsArray, onRemove, isEditDay = false) {
        const list = $(containerId);
        if (!list) return;
        list.innerHTML = '';
        const defaultSlot = isEditDay ? { start: '', end: '', status: 'available' } : { start: '', end: '' };
        if (slotsArray.length === 0) {
            slotsArray.push(defaultSlot);
            list.appendChild(createSlotRow(slotsArray, 0, onRemove, { isEditDay }));
            return;
        }
        slotsArray.forEach((slot, i) => {
            const row = createSlotRow(slotsArray, i, onRemove, { isEditDay });
            row.querySelector('[data-slot-field="start"]').value = slot.start || '';
            row.querySelector('[data-slot-field="end"]').value = slot.end || '';
            list.appendChild(row);
        });
    }

    function renderWeekSlots() {
        if (!weekSlots[selectedDay]) weekSlots[selectedDay] = [];
        renderSlotsList('template-slots-list', weekSlots[selectedDay], renderWeekSlots);
    }

    function renderDaySlots() {
        renderSlotsList('template-day-slots-list', daySlots, renderDaySlots);
    }

    function addSlotRow(containerId, slotsArray, onRemove) {
        slotsArray.push({ start: '', end: '' });
        $(containerId)?.appendChild(createSlotRow(slotsArray, slotsArray.length - 1, onRemove));
    }

    // === Copy & sync (template UI) ===
    function toggleWeekDaySections() {
        $('template-week-section')?.classList.toggle('is-hidden', templateType !== 'week');
        $('template-day-section')?.classList.toggle('is-hidden', templateType !== 'day');
    }

    function syncTemplateTypeUI() {
        document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === templateType));
    }

    function renderDaysList() {
        const list = $('template-days-list');
        if (!list) return;
        list.innerHTML = '';
        DAYS.forEach((day) => {
            const label = document.createElement('label');
            label.className = 'template-day-item' + (selectedDay === day ? ' selected' : '');
            label.innerHTML = `<input type="checkbox" ${selectedDay === day ? 'checked' : ''} aria-label="${DAY_LABELS[day]}"><span>${DAY_LABELS[day]}</span>`;
            label.addEventListener('click', (e) => {
                e.preventDefault();
                syncSlotsFromInputs();
                selectedDay = day;
                renderDaysList();
                renderWeekSlots();
                populateCopySourceSelect();
            });
            list.appendChild(label);
        });
    }

    function getCopySourceType() {
        return document.querySelector('input[name="template-copy-source"]:checked')?.value || 'day';
    }

    function populateCopySourceSelect() {
        const menu = $('template-copy-source-menu');
        const triggerText = document.querySelector('#template-copy-source-trigger .vet-template-copy-trigger-text');
        const hiddenInput = $('template-copy-source-select');
        const dropdown = $('template-copy-source-dropdown');
        if (!menu || !hiddenInput || !dropdown) return;
        const type = getCopySourceType();
        let items = '';
        if (type === 'day') {
            const others = DAYS.filter((d) => d !== selectedDay);
            items = others.map((d) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${d}">${DAY_LABELS[d]}</button>`).join('');
        } else {
            const dayTemplates = cachedTemplates.filter((t) => t.type === 'day');
            items = dayTemplates.map((t) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</button>`).join('');
        }
        menu.innerHTML = items || '<span class="vet-template-copy-empty">No options</span>';
        hiddenInput.value = '';
        if (triggerText) triggerText.textContent = 'Copy from';
        menu.querySelectorAll('.vet-template-copy-item').forEach((btn) => {
            btn.onclick = () => {
                const val = btn.dataset.value;
                hiddenInput.value = val;
                triggerText.textContent = btn.textContent;
                dropdown.classList.remove('is-open');
            };
        });
    }

    function populateCopyFromTemplateSelect() {
        const menu = $('template-copy-from-menu');
        const triggerText = document.querySelector('#template-copy-from-trigger .vet-template-copy-trigger-text');
        const hiddenInput = $('template-copy-from-template');
        const dropdown = $('template-copy-from-dropdown');
        if (!menu || !hiddenInput || !dropdown) return;
        const dayTemplates = cachedTemplates.filter((t) => t.type === 'day' && t.id !== editingTemplateId);
        const items = dayTemplates.map((t) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</button>`).join('');
        menu.innerHTML = items || '<span class="vet-template-copy-empty">No templates</span>';
        hiddenInput.value = '';
        if (triggerText) triggerText.textContent = 'Copy from';
        menu.querySelectorAll('.vet-template-copy-item').forEach((btn) => {
            btn.onclick = () => {
                const val = btn.dataset.value;
                hiddenInput.value = val;
                triggerText.textContent = btn.textContent;
                dropdown.classList.remove('is-open');
            };
        });
    }

    function bindTemplateCopyDropdowns() {
        const bind = (triggerId, dropdownId) => {
            const trigger = $(triggerId);
            const dropdown = $(dropdownId);
            if (!trigger || !dropdown) return;
            trigger.onclick = (e) => { e.stopPropagation(); dropdown.classList.toggle('is-open'); };
            dropdown.onclick = (e) => e.stopPropagation();
        };
        bind('template-copy-source-trigger', 'template-copy-source-dropdown');
        bind('template-copy-from-trigger', 'template-copy-from-dropdown');
        document.addEventListener('click', () => {
            $('template-copy-source-dropdown')?.classList.remove('is-open');
            $('template-copy-from-dropdown')?.classList.remove('is-open');
        });
    }

    function copyFromSourceWeek() {
        const type = getCopySourceType();
        const value = $('template-copy-source-select')?.value;
        if (!value) {
            showToast(type === 'day' ? 'Select a day to copy from.' : 'Select a template to copy from.');
            return;
        }
        syncSlotsFromInputs();
        if (type === 'day') {
            const slots = (weekSlots[value] || []).map((s) => ({ start: s.start || '', end: s.end || '' }));
            if (!slots.length) { showToast('Selected day has no slots.'); return; }
            weekSlots[selectedDay] = [...slots];
            $('template-copy-source-select').value = '';
            renderWeekSlots();
            showToast(`Copied ${slots.length} slot(s) from ${DAY_LABELS[value]}.`);
        } else {
            const template = cachedTemplates.find((t) => t.id === value);
            if (!template || template.type !== 'day' || !Array.isArray(template.slots) || !template.slots.length) {
                showToast('Selected template has no slots.');
                return;
            }
            weekSlots[selectedDay] = template.slots.map((s) => ({ start: s.start || '', end: s.end || '' }));
            $('template-copy-source-select').value = '';
            renderWeekSlots();
            showToast(`Copied ${weekSlots[selectedDay].length} slot(s) from "${template.name || 'template'}".`);
        }
    }

    function copyFromTemplate() {
        const templateId = $('template-copy-from-template')?.value;
        if (!templateId) { showToast('Select a template to copy from.'); return; }
        const template = cachedTemplates.find((t) => t.id === templateId);
        if (!template || template.type !== 'day' || !Array.isArray(template.slots) || !template.slots.length) {
            showToast('Selected template has no slots.');
            return;
        }
        daySlots = template.slots.map((s) => ({ start: s.start || '', end: s.end || '' }));
        $('template-copy-from-template').value = '';
        renderDaySlots();
        showToast(`Copied ${daySlots.length} slot(s) from "${template.name || 'template'}".`);
    }

    function syncSlotsFromInputs() {
        const list = templateType === 'week' ? $('template-slots-list') : $('template-day-slots-list');
        const slots = templateType === 'week' ? (weekSlots[selectedDay] || []) : daySlots;
        list?.querySelectorAll('input[type="time"]').forEach((inp) => {
            const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
            const field = inp.getAttribute('data-slot-field');
            if (!isNaN(idx) && slots[idx]) slots[idx][field] = inp.value || '';
        });
    }

    // === Validation & save (template) ===
    function validateSlots(slots, dayLabel) {
        const prefix = dayLabel ? dayLabel + ': ' : '';
        const withTimes = slots.filter((s) => s.start && s.end);
        for (const s of withTimes) { if (s.start >= s.end) return { valid: false, message: prefix + 'Start time must be before end time.' }; }
        const validSlots = withTimes.filter((s) => s.start < s.end).sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 1; i < validSlots.length; i++) { if (validSlots[i].start < validSlots[i - 1].end) return { valid: false, message: prefix + 'Time slots must not overlap.' }; }
        return { valid: true, slots: validSlots };
    }

    function getSlotsForSave() {
        syncSlotsFromInputs();
        if (templateType === 'week') {
            const days = {};
            DAYS.forEach((day) => {
                const arr = (weekSlots[day] || []).filter((s) => s.start && s.end && s.start < s.end);
                if (arr.length) days[day] = arr;
            });
            return { type: 'week', days };
        }
        const slots = daySlots.filter((s) => s.start && s.end && s.start < s.end);
        return { type: 'day', slots };
    }

    const showTemplateError = (msg) => setErrorEl('template-error-msg', msg, false);
    const hideTemplateError = () => setErrorEl('template-error-msg', '', true);

    function showToast(message) {
        document.getElementById('template-success-toast')?.remove();
        const toast = Object.assign(document.createElement('div'), { id: 'template-success-toast', className: 'template-success-toast', role: 'status', textContent: message });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function validateAndSave() {
        const name = ($('template-name').value || '').trim();
        if (!name) { showTemplateError('Please enter a template name.'); return; }
        syncSlotsFromInputs();

        if (templateType === 'week') {
            for (const day of DAYS) {
                const slots = weekSlots[day] || [];
                const result = validateSlots(slots, slots.length ? DAY_LABELS[day] : null);
                if (!result.valid) { showTemplateError(result.message); return; }
            }
        } else {
            const result = validateSlots(daySlots);
            if (!result.valid) { showTemplateError(result.message); return; }
            if (!daySlots.some((s) => s.start && s.end && s.start < s.end)) { showTemplateError('Day template must have at least one time slot.'); return; }
        }

        const payload = getSlotsForSave();
        hideTemplateError();
        const saveBtn = $('template-save-btn');
        const user = auth.currentUser;
        if (!user) { showTemplateError('You must be signed in to save.'); return; }
        if (saveBtn) saveBtn.disabled = true;

        const data = { name, type: payload.type };
        if (payload.type === 'week') data.days = payload.days;
        else data.slots = payload.slots;

        const savePromise = editingTemplateId ? updateDoc(templateDoc(user.uid, editingTemplateId), data) : addDoc(templateCol(user.uid), data);
        savePromise
            .then(() => {
                closeModal();
                showToast(editingTemplateId ? 'Template updated.' : 'Template saved successfully.');
                loadTemplates();
            })
            .catch((err) => {
                console.error('Save template error:', err);
                showTemplateError('Failed to save. Please try again.');
            })
            .finally(() => { if (saveBtn) saveBtn.disabled = false; });
    }

    function deleteTemplate(template) {
        if (!confirm(`Delete template "${template.name || 'Unnamed'}"? This cannot be undone.`)) return;
        const user = auth.currentUser;
        if (!user) return;
        deleteDoc(templateDoc(user.uid, template.id))
            .then(() => { showToast('Template deleted.'); loadTemplates(); })
            .catch((err) => { console.error('Delete template error:', err); showToast('Failed to delete template.'); });
    }

    // === Block dates (calendar) ===
    function getBlockCalendarMonthLabel(date) {
        return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    function renderBlockCalendar() {
        const grid = $('block-calendar-grid');
        const titleEl = $('block-calendar-month-year');
        if (!grid || !blockCalendarMonth) return;
        titleEl.textContent = getBlockCalendarMonthLabel(blockCalendarMonth);
        const year = blockCalendarMonth.getFullYear();
        const month = blockCalendarMonth.getMonth();
        const first = new Date(year, month, 1);
        const last = new Date(year, month + 1, 0);
        const startWeekday = first.getDay();
        const daysInMonth = last.getDate();
        const dayCells = [];
        for (let i = 1 - startWeekday; dayCells.length < 42; i++) {
            const d = new Date(year, month, i);
            dayCells.push({ dateStr: toLocalDateString(d), dayNum: d.getDate(), otherMonth: d.getMonth() !== month });
        }
        const dayBtn = (dateStr, dayNum, otherMonth) => {
            const selected = blockSelectedDates.has(dateStr);
            const cls = 'block-calendar-day' + (otherMonth ? ' other-month' : '') + (selected ? ' selected' : '');
            return `<button type="button" class="${cls}" data-date="${escapeHtml(dateStr)}" aria-label="${escapeHtml(dateStr)}${selected ? ' (blocked)' : ''}" aria-pressed="${selected}"><span class="block-calendar-day-inner"><span class="block-calendar-day-num">${dayNum}</span>${selected ? '<i class="fa fa-check block-calendar-day-check" aria-hidden="true"></i>' : ''}</span></button>`;
        };
        grid.innerHTML = dayCells.map((c) => dayBtn(c.dateStr, c.dayNum, c.otherMonth)).join('');
        grid.querySelectorAll('.block-calendar-day').forEach((btn) => {
            btn.addEventListener('click', () => {
                const dateStr = btn.getAttribute('data-date');
                if (!dateStr) return;
                blockSelectedDates.has(dateStr) ? blockSelectedDates.delete(dateStr) : blockSelectedDates.add(dateStr);
                const selected = blockSelectedDates.has(dateStr);
                btn.classList.toggle('selected', selected);
                btn.setAttribute('aria-pressed', selected);
                const inner = btn.querySelector('.block-calendar-day-inner');
                const check = inner?.querySelector('.block-calendar-day-check');
                if (selected && !check && inner) inner.appendChild(Object.assign(document.createElement('i'), { className: 'fa fa-check block-calendar-day-check', ariaHidden: 'true' }));
                else if (!selected && check) check.remove();
            });
        });
    }

    const blockCalendarPrevMonth = () => { if (blockCalendarMonth) { blockCalendarMonth = new Date(blockCalendarMonth.getFullYear(), blockCalendarMonth.getMonth() - 1, 1); renderBlockCalendar(); } };
    const blockCalendarNextMonth = () => { if (blockCalendarMonth) { blockCalendarMonth = new Date(blockCalendarMonth.getFullYear(), blockCalendarMonth.getMonth() + 1, 1); renderBlockCalendar(); } };

    async function openBlockModal() {
        const errEl = $('block-error-msg');
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        const all = await ensureSchedulesLoaded();
        const blocked = all.filter((s) => s.blocked === true);
        blockSelectedDates = new Set(blocked.map((s) => s.date || s.id || '').filter(Boolean));
        blockPreviouslyBlocked = new Set(blockSelectedDates);
        const now = new Date();
        blockCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        renderBlockCalendar();
        setModalVisible('block-modal-overlay', 'block-modal', true);
        $('block-calendar-prev')?.addEventListener('click', blockCalendarPrevMonth);
        $('block-calendar-next')?.addEventListener('click', blockCalendarNextMonth);
        setTimeout(() => $('block-calendar-prev')?.focus(), 100);
    }

    function closeBlockModal() {
        $('block-calendar-prev')?.removeEventListener('click', blockCalendarPrevMonth);
        $('block-calendar-next')?.removeEventListener('click', blockCalendarNextMonth);
        setModalVisible('block-modal-overlay', 'block-modal', false);
    }

    async function doBlockDates() {
        const errEl = $('block-error-msg');
        const saveBtn = $('block-submit-btn');
        const user = auth.currentUser;
        if (!user) return;
        if (saveBtn) saveBtn.disabled = true;
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }

        try {
            const toAdd = [...blockSelectedDates];
            const toRemove = [...blockPreviouslyBlocked].filter((d) => !blockSelectedDates.has(d));
            for (const dateStr of toAdd) {
                await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, blocked: true });
            }
            for (const dateStr of toRemove) {
                await deleteDoc(scheduleDoc(user.uid, dateStr));
            }
            closeBlockModal();
            const added = toAdd.length;
            const removed = toRemove.length;
            if (added > 0 || removed > 0) {
                const parts = [];
                if (added) parts.push(`${added} date(s) blocked`);
                if (removed) parts.push(`${removed} unblocked`);
                showToast(parts.join('. ') + '. Blocked dates prevent scheduling and are skipped when applying templates.');
            } else {
                showToast('No changes to blocked dates.');
            }
            invalidateSchedulesCache();
            loadBlockedDatesView();
            loadSchedulesView();
            loadWeeklyScheduleView();
        } catch (e) {
            console.error('Block dates error:', e);
            if (errEl) { errEl.textContent = e.message || 'Failed to save blocked dates.'; errEl.classList.remove('is-hidden'); }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function unblockDate(dateStr) {
        const user = auth.currentUser;
        if (!user || !dateStr) return;
        if (!confirm(`Unblock ${formatDisplayDate(dateStr)}? The date will be cleared and can receive templates again.`)) return;
        try {
            await deleteDoc(scheduleDoc(user.uid, dateStr));
            showToast('Date unblocked.');
            invalidateSchedulesCache();
            loadBlockedDatesView();
            loadSchedulesView();
            loadWeeklyScheduleView();
        } catch (e) {
            console.error('Unblock error:', e);
            showToast('Failed to unblock date.');
        }
    }

    // === Edit day modal ===
    function renderEditDaySlots() {
        renderSlotsList('edit-day-slots-list', editDaySlots, renderEditDaySlots, true);
    }

    function syncEditDaySlotsFromInputs() {
        const list = $('edit-day-slots-list');
        list?.querySelectorAll('input[type="time"]').forEach((inp) => {
            const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
            const field = inp.getAttribute('data-slot-field');
            if (!isNaN(idx) && editDaySlots[idx]) editDaySlots[idx][field] = inp.value || '';
        });
    }

    async function openEditDayModal(dateStr) {
        const user = auth.currentUser;
        if (!user || !dateStr) return;
        editDayDateStr = dateStr;
        const doc = await getDoc(scheduleDoc(user.uid, dateStr));
        const data = doc.exists() ? doc.data() : {};
        if (data.blocked === true) return;
        editDaySlots = (data.slots || []).map((s) => ({ start: s.start || '', end: s.end || '', status: s.status || 'available' }));
        if (editDaySlots.length === 0) editDaySlots = [{ start: '', end: '', status: 'available' }];

        $('edit-day-date-display').textContent = formatDisplayDate(dateStr);
        $('edit-day-error-msg').textContent = '';
        $('edit-day-error-msg').classList.add('is-hidden');
        renderEditDaySlots();
        setModalVisible('edit-day-modal-overlay', 'edit-day-modal', true);
        setTimeout(() => $('edit-day-add-slot-btn')?.focus(), 100);
    }

    function closeEditDayModal() {
        editDayDateStr = null;
        editDaySlots = [];
        setModalVisible('edit-day-modal-overlay', 'edit-day-modal', false);
    }

    const showEditDayError = (msg) => setErrorEl('edit-day-error-msg', msg, false);

    function validateEditDaySlots() {
        syncEditDaySlotsFromInputs();
        return validateSlots(editDaySlots);
    }

    async function saveEditDay() {
        const user = auth.currentUser;
        if (!user || !editDayDateStr) return;
        const result = validateEditDaySlots();
        if (!result.valid) { showEditDayError(result.message); return; }
        const minAdvance = getMinAdvanceMinutes();
        let slotsToSave = result.slots.map((s) => {
            const base = { start: s.start, end: s.end, status: s.status || 'available' };
            return ensureSlotExpiry(base, editDayDateStr, minAdvance);
        });
        const beforeCount = slotsToSave.length;
        slotsToSave = slotsToSave.filter((s) => {
            if ((s.status || 'available') === 'booked') return true;
            return !isSlotExpired(s, Date.now()) && !isSlotPastCutoff(editDayDateStr, s.start, minAdvance);
        });
        const removedCount = beforeCount - slotsToSave.length;
        if (slotsToSave.length === 0) {
            if (removedCount > 0) {
                showEditDayError(`All slots are within the minimum advance (${formatMinutesForDisplay(minAdvance)}) or in the past. Add slots that are at least ${formatMinutesForDisplay(minAdvance)} from now.`);
                return;
            }
            if (!confirm('Remove all slots for this date? The date will be removed from your schedule.')) return;
        } else if (removedCount > 0) {
            showToast(`${removedCount} slot(s) skipped (within minimum advance or in the past).`);
        }
        const saveBtn = $('edit-day-save-btn');
        if (saveBtn) saveBtn.disabled = true;
        try {
            if (slotsToSave.length === 0) {
                await deleteDoc(scheduleDoc(user.uid, editDayDateStr));
                closeEditDayModal();
                showToast('Date removed from schedule.');
                invalidateSchedulesCache();
            } else {
                await setDoc(scheduleDoc(user.uid, editDayDateStr), { date: editDayDateStr, slots: slotsToSave });
                closeEditDayModal();
                showToast('Schedule updated for this date.');
            }
            invalidateSchedulesCache();
            loadSchedulesView();
            loadWeeklyScheduleView();
        } catch (e) {
            console.error('Save edit day error:', e);
            showEditDayError(e.message || 'Failed to save.');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    // === Event bindings ===
    document.addEventListener('DOMContentLoaded', () => {
        $('template-create-btn')?.addEventListener('click', () => openModal());
        $('template-modal-close')?.addEventListener('click', closeModal);
        $('template-cancel-btn')?.addEventListener('click', closeModal);
        onOverlayClick('template-modal-overlay', closeModal);
        $('template-save-btn')?.addEventListener('click', validateAndSave);

        $('template-view-close')?.addEventListener('click', closeViewModal);
        $('template-view-close-btn')?.addEventListener('click', closeViewModal);
        onOverlayClick('template-view-overlay', closeViewModal);

        const setTemplateType = (type) => { templateType = type; syncTemplateTypeUI(); toggleWeekDaySections(); };
        document.querySelectorAll('input[name="template-type"]').forEach((radio) => radio.addEventListener('change', () => setTemplateType(radio.value)));
        document.querySelectorAll('.template-type-option').forEach((opt) => opt.addEventListener('click', (e) => { const input = opt.querySelector('input'); if (input && !input.checked) { input.checked = true; setTemplateType(input.value); } }));

        $('template-add-slot-btn')?.addEventListener('click', () => {
            if (!weekSlots[selectedDay]) weekSlots[selectedDay] = [];
            addSlotRow('template-slots-list', weekSlots[selectedDay], renderWeekSlots);
        });
        $('template-day-add-slot-btn')?.addEventListener('click', () => addSlotRow('template-day-slots-list', daySlots, renderDaySlots));
        $('template-copy-week-btn')?.addEventListener('click', copyFromSourceWeek);
        $('template-copy-from-template-btn')?.addEventListener('click', copyFromTemplate);
        document.querySelectorAll('input[name="template-copy-source"]').forEach((r) => r.addEventListener('change', populateCopySourceSelect));
        bindTemplateCopyDropdowns();

        const escapeModals = [
            ['conflict-modal', () => closeConflictModal(true)],
            ['edit-day-modal', closeEditDayModal],
            ['block-modal', closeBlockModal],
            ['template-view-modal', closeViewModal],
            ['apply-modal', closeApplyModal],
            ['booking-settings-modal', () => closeBookingSettingsModal(true)],
            ['template-action-modal', closeTemplateActionModal],
            ['template-modal', closeModal],
        ];
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const pair = escapeModals.find(([id]) => !$(id)?.classList.contains('is-hidden'));
            if (pair) pair[1]();
        });

        $('block-dates-btn')?.addEventListener('click', openBlockModal);
        $('block-modal-close')?.addEventListener('click', closeBlockModal);
        $('block-cancel-btn')?.addEventListener('click', closeBlockModal);
        onOverlayClick('block-modal-overlay', closeBlockModal);
        $('block-submit-btn')?.addEventListener('click', doBlockDates);

        $('schedules-list')?.addEventListener('click', (e) => {
            const editBtn = e.target.closest('.schedules-edit-day-btn');
            if (editBtn?.dataset?.date) openEditDayModal(editBtn.dataset.date);
        });

        $('edit-day-modal-close')?.addEventListener('click', closeEditDayModal);
        $('edit-day-cancel-btn')?.addEventListener('click', closeEditDayModal);
        onOverlayClick('edit-day-modal-overlay', closeEditDayModal);
        $('edit-day-save-btn')?.addEventListener('click', saveEditDay);
        $('edit-day-add-slot-btn')?.addEventListener('click', () => {
            editDaySlots.push({ start: '', end: '', status: 'available' });
            renderEditDaySlots();
        });

        $('template-action-close')?.addEventListener('click', closeTemplateActionModal);
        onOverlayClick('template-action-overlay', closeTemplateActionModal);
        $('template-action-modal')?.addEventListener('click', (e) => e.stopPropagation());
        $('template-action-apply')?.addEventListener('click', () => { const t = currentTemplateAction; if (t) { closeTemplateActionModal(); openApplyModal(t); } });
        $('template-action-view')?.addEventListener('click', () => { const t = currentTemplateAction; if (t) { closeTemplateActionModal(); openViewModal(t); } });
        $('template-action-edit')?.addEventListener('click', () => { const t = currentTemplateAction; if (t) { closeTemplateActionModal(); openModal(t); } });
        $('template-action-delete')?.addEventListener('click', () => { const t = currentTemplateAction; if (t) { closeTemplateActionModal(); deleteTemplate(t); } });

        $('apply-start-date')?.addEventListener('change', () => {
            const startVal = $('apply-start-date')?.value;
            if (startVal) $('apply-end-date').min = startVal;
        });
        $('apply-modal-close')?.addEventListener('click', closeApplyModal);
        $('apply-cancel-btn')?.addEventListener('click', closeApplyModal);
        onOverlayClick('apply-modal-overlay', closeApplyModal);
        $('apply-submit-btn')?.addEventListener('click', doApplyTemplate);

        $('conflict-modal-close')?.addEventListener('click', () => closeConflictModal(true));
        onOverlayClick('conflict-modal-overlay', () => closeConflictModal(true));
        $('conflict-replace-btn')?.addEventListener('click', onConflictReplace);
        $('conflict-cancel-btn')?.addEventListener('click', onConflictCancel);

        function setScheduleViewMode(isGrid) {
            const scrollY = window.scrollY || document.documentElement.scrollTop;
            gridViewActive = isGrid;
            $('schedules-list-filter-row')?.classList.toggle('is-hidden', isGrid);
            $('schedules-grid-filter-row')?.classList.toggle('is-hidden', !isGrid);
            $('weekly-schedule-empty')?.classList.add('is-hidden');
            $('weekly-schedule-grid-wrap')?.classList.toggle('is-hidden', !isGrid);
            $('schedules-view-wrap')?.classList.toggle('is-hidden', isGrid);
            $('schedules-view-empty')?.classList.toggle('is-hidden', isGrid);
            if (!isGrid) { $('schedules-filter').value = 'all'; $('schedules-date-wrap')?.classList.add('is-hidden'); }
            else { $('schedules-grid-filter').value = 'this'; $('schedules-week-wrap')?.classList.add('is-hidden'); }
            (isGrid ? loadWeeklyScheduleView() : loadSchedulesView()).then(() => requestAnimationFrame(() => window.scrollTo(0, scrollY)));
        }

        $('schedules-view-settings-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const dd = $('schedules-view-dropdown');
            const isOpen = !dd?.classList.contains('is-hidden');
            if (!isOpen) syncGridOptionVisibility();
            dd?.classList.toggle('is-hidden', isOpen);
            $('schedules-view-settings-btn')?.setAttribute('aria-expanded', !isOpen);
        });
        document.addEventListener('click', (e) => {
            const btn = $('schedules-view-settings-btn');
            const dd = $('schedules-view-dropdown');
            if (btn?.contains(e.target) || dd?.contains(e.target)) return;
            dd?.classList.add('is-hidden');
            btn?.setAttribute('aria-expanded', 'false');
        });

        document.querySelectorAll('.schedules-view-option').forEach((opt) => {
            opt.addEventListener('click', () => {
                const view = opt.dataset.view;
                $('schedules-view-dropdown')?.classList.add('is-hidden');
                $('schedules-view-settings-btn')?.setAttribute('aria-expanded', 'false');
                if (view === 'settings') {
                    openBookingSettingsModal();
                } else {
                    setScheduleViewMode(view === 'grid');
                }
            });
        });

        $('schedules-filter')?.addEventListener('change', () => {
            $('schedules-date-wrap')?.classList.toggle('is-hidden', $('schedules-filter')?.value !== 'date');
            if ($('schedules-filter')?.value === 'date' && !$('schedules-date-picker')?.value) $('schedules-date-picker').value = getTodayDateString();
            loadSchedulesView();
        });
        $('schedules-date-picker')?.addEventListener('change', loadSchedulesView);

        $('schedules-grid-filter')?.addEventListener('change', () => {
            $('schedules-week-wrap')?.classList.toggle('is-hidden', $('schedules-grid-filter')?.value !== 'specific');
            if ($('schedules-grid-filter')?.value === 'specific' && !$('schedules-week-picker')?.value) {
                const wr = getWeekRangeForFilter('this');
                $('schedules-week-picker').value = wr.start;
            }
            if (gridViewActive) loadWeeklyScheduleView();
        });
        $('schedules-week-picker')?.addEventListener('change', () => {
            if (gridViewActive) loadWeeklyScheduleView();
        });

        function syncGridOptionVisibility() {
            const isExpired = getActiveSlotFilter() === 'expired';
            const gridOpt = $('schedules-view-option-grid');
            if (gridOpt) gridOpt.classList.toggle('is-hidden', isExpired);
        }

        document.querySelectorAll('.schedules-slot-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.schedules-slot-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const isExpired = btn.dataset.slotFilter === 'expired';
                if (isExpired && gridViewActive) {
                    setScheduleViewMode(false);
                }
                syncGridOptionVisibility();
                if (gridViewActive) loadWeeklyScheduleView();
                else loadSchedulesView();
            });
        });

        $('schedules-delete-all-expired-btn')?.addEventListener('click', async () => {
            if (!confirm('Permanently delete all expired slot records? This cannot be undone.')) return;
            const btn = $('schedules-delete-all-expired-btn');
            if (btn) btn.disabled = true;
            try {
                const count = await deleteAllExpiredSlots();
                showToast(count > 0 ? `${count} expired slot(s) deleted.` : 'No expired slots to delete.');
                document.querySelector('.schedules-slot-btn[data-slot-filter="expired"]')?.classList.remove('active');
                $('schedules-slot-all')?.classList.add('active');
                $('schedules-expired-actions')?.classList.add('is-hidden');
                if (gridViewActive) loadWeeklyScheduleView();
                else loadSchedulesView();
            } catch (e) {
                showToast(e.message || 'Failed to delete expired slots.');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        function updateMinAdvanceInputs() {
            const mins = getMinAdvanceMinutes();
            const valInp = $('min-advance-value');
            const unitSel = $('min-advance-unit');
            if (!valInp || !unitSel) return;
            if (mins >= 60 && mins % 60 === 0) {
                valInp.value = String(mins / 60);
                unitSel.value = 'hours';
            } else if (mins >= 60) {
                valInp.value = String(Math.round(mins / 60 * 100) / 100);
                unitSel.value = 'hours';
            } else {
                valInp.value = String(mins);
                unitSel.value = 'minutes';
            }
            syncMinAdvanceInputAttrs();
        }

        function getMinAdvanceFromInputs() {
            const valInp = $('min-advance-value');
            const unitSel = $('min-advance-unit');
            const val = parseFloat(valInp?.value, 10);
            if (isNaN(val) || val <= 0) return null;
            const unit = unitSel?.value || 'minutes';
            if (unit === 'hours' && val > 24) return null;
            if (unit === 'minutes' && val > MIN_ADVANCE_MAX_MINUTES) return null;
            const mins = unit === 'hours' ? Math.round(val * 60) : Math.round(val);
            if (mins < MIN_ADVANCE_MIN || mins > MIN_ADVANCE_MAX_MINUTES) return null;
            return mins;
        }

        function updateCurrentAdvanceDisplay() {
            const el = $('schedules-current-advance');
            const mins = getMinAdvanceMinutes();
            if (el) el.textContent = `Min advance: ${formatMinutesForDisplay(mins)}`;
        }

        function syncMinAdvanceInputAttrs() {
            const valInp = $('min-advance-value');
            const unitSel = $('min-advance-unit');
            if (!valInp || !unitSel) return;
            const isHours = unitSel.value === 'hours';
            valInp.min = isHours ? '0.01' : '1';
            valInp.max = isHours ? '24' : '1440';
            valInp.step = isHours ? '0.01' : '1';
            valInp.placeholder = isHours ? 'e.g. 1.5' : 'e.g. 30';
        }

        function openBookingSettingsModal() {
            updateMinAdvanceInputs();
            syncMinAdvanceInputAttrs();
            $('booking-settings-error')?.classList.add('is-hidden');
            setModalVisible('booking-settings-overlay', 'booking-settings-modal', true);
            setTimeout(() => $('min-advance-value')?.focus(), 100);
        }

        function closeBookingSettingsModal(discardConfirm = false) {
            const inputMins = getMinAdvanceFromInputs();
            const savedMins = getMinAdvanceMinutes();
            const hasChanges = inputMins !== null && inputMins !== savedMins;
            if (discardConfirm && hasChanges && !confirm('Discard unsaved changes?')) return;
            updateMinAdvanceInputs();
            setModalVisible('booking-settings-overlay', 'booking-settings-modal', false);
        }

        async function doSaveBookingSettings() {
            const val = getMinAdvanceFromInputs();
            if (val === null) {
                const errEl = $('booking-settings-error');
                if (errEl) {
                    errEl.textContent = `Enter a value between ${MIN_ADVANCE_MIN} and ${MIN_ADVANCE_MAX_MINUTES} minutes (or 0.01–24 hours).`;
                    errEl.classList.remove('is-hidden');
                }
                return;
            }
            const currentVal = getMinAdvanceMinutes();
            if (val === currentVal) {
                closeBookingSettingsModal();
                return;
            }
            const label = formatMinutesForDisplay(val);
            if (!confirm(`Save booking setting to "${label}"? Slots within this window will be deleted from your schedule and cannot be booked.`)) return;
            const saveBtn = $('booking-settings-save-btn');
            const errEl = $('booking-settings-error');
            if (saveBtn) saveBtn.disabled = true;
            if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
            try {
                await saveVetSettings(val);
                closeBookingSettingsModal();
                updateCurrentAdvanceDisplay();
                invalidateSchedulesCache();
                await recalcExpiryForFutureSlots();
                scheduleNextExpiryRerender(cachedSchedules);
                if (gridViewActive) loadWeeklyScheduleView();
                else loadSchedulesView();
                loadBlockedDatesView();
                showToast(`Booking setting saved. Minimum advance is now ${label}.`);
            } catch (err) {
                if (errEl) { errEl.textContent = err.message || 'Failed to save. Please try again.'; errEl.classList.remove('is-hidden'); }
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        }

        $('min-advance-unit')?.addEventListener('change', syncMinAdvanceInputAttrs);
        $('booking-settings-close')?.addEventListener('click', () => closeBookingSettingsModal(true));
        $('booking-settings-cancel-btn')?.addEventListener('click', () => closeBookingSettingsModal(true));
        onOverlayClick('booking-settings-overlay', () => closeBookingSettingsModal(true));
        $('booking-settings-save-btn')?.addEventListener('click', doSaveBookingSettings);

        async function refreshSchedulesWithCleanup() {
            invalidateSchedulesCache();
            await ensureSchedulesLoaded();
            await markExpiredSlotsInFirebase();
            if (gridViewActive) await loadWeeklyScheduleView();
            else await loadSchedulesView();
            loadBlockedDatesView();
        }

        async function initAppointments() {
            await loadVetSettings();
            updateMinAdvanceInputs();
            updateCurrentAdvanceDisplay();
            loadTemplates();
            await ensureSchedulesLoaded();
            await markExpiredSlotsInFirebase();
            loadBlockedDatesView();
            loadSchedulesView();
            syncGridOptionVisibility();

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') refreshSchedulesWithCleanup();
            });
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
