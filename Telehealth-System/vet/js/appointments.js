/** Televet Health — Vet Appointments: availability templates (week/day) & schedules */
import { auth, db } from '../../shared/js/firebase-config.js';
import {
    collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc, setDoc,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';

    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const DAY_LABELS = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };

    const $ = (id) => document.getElementById(id);
    const templateCol = (uid) => collection(db, 'users', uid, 'template');
    const templateDoc = (uid, id) => doc(db, 'users', uid, 'template', id);
    const scheduleCol = (uid) => collection(db, 'users', uid, 'schedules');
    const scheduleDoc = (uid, dateStr) => doc(db, 'users', uid, 'schedules', dateStr);

    let selectedDay = 'monday';
    let editingTemplateId = null;
    let cachedTemplates = [];
    let weekSlots = {};
    let daySlots = [];
    let templateType = 'week';

    // --- DOM helpers ---
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    function setModalVisible(overlayId, modalId, visible) {
        const overlay = $(overlayId);
        const modal = $(modalId);
        const hidden = !visible;
        if (overlay) {
            overlay.classList.toggle('is-hidden', hidden);
            overlay.setAttribute('aria-hidden', String(hidden));
        }
        if (modal) {
            modal.classList.toggle('is-hidden', hidden);
            modal.setAttribute('aria-hidden', String(hidden));
        }
    }

    // --- Templates list ---
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
            const typeLabel = t.type === 'week' ? 'Week template' : 'Day template';
            const card = document.createElement('div');
            card.className = 'appointments-template-card';
            card.dataset.templateId = t.id;
            card.innerHTML = `
                <div class="appointments-template-info">
                    <div class="appointments-template-icon"><i class="fa fa-${t.type === 'week' ? 'calendar' : 'clock-o'}" aria-hidden="true"></i></div>
                    <div>
                        <div class="appointments-template-name">${escapeHtml(t.name || 'Unnamed')}</div>
                        <div class="appointments-template-meta">${escapeHtml(typeLabel)}</div>
                    </div>
                </div>
                <div class="appointments-template-actions">
                    <button type="button" class="appointments-template-btn btn-apply" data-action="apply" aria-label="Apply"><i class="fa fa-calendar-check-o" aria-hidden="true"></i> Apply</button>
                    <button type="button" class="appointments-template-btn btn-view" data-action="view" aria-label="View"><i class="fa fa-eye" aria-hidden="true"></i> View</button>
                    <button type="button" class="appointments-template-btn btn-edit" data-action="edit" aria-label="Edit"><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>
                    <button type="button" class="appointments-template-btn btn-delete" data-action="delete" aria-label="Delete"><i class="fa fa-trash-o" aria-hidden="true"></i> Delete</button>
                </div>
            `;
            const actions = { apply: () => openApplyModal(t), view: () => openViewModal(t), edit: () => openModalForEdit(t), delete: () => deleteTemplate(t) };
            card.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => actions[btn.dataset.action]?.()));
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

    // --- Schedules ---
    function getTodayDateString() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    async function loadAllSchedules() {
        const user = auth.currentUser;
        if (!user) return [];
        const snap = await getDocs(scheduleCol(user.uid));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    function filterSchedules(schedules, filterMode, specificDate) {
        if (!schedules?.length) return [];
        const sorted = [...schedules].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        if (filterMode === 'today') return sorted.filter((s) => (s.date || '') === getTodayDateString());
        if (filterMode === 'date' && specificDate) return sorted.filter((s) => (s.date || '') === specificDate);
        return sorted;
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

    function formatDisplayDate(dateStr) {
        if (!dateStr) return '—';
        return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    function formatTime12h(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return timeStr || '—';
        const [h, m] = timeStr.split(':').map(Number);
        if (isNaN(h)) return timeStr;
        const hour = h % 12 || 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        const min = isNaN(m) ? '00' : String(m).padStart(2, '0');
        return `${hour}:${min} ${ampm}`;
    }

    function renderSchedulesView(schedules, slotFilter) {
        const wrap = $('schedules-view-wrap');
        const empty = $('schedules-view-empty');
        const listEl = $('schedules-list');
        if (!wrap || !listEl) return;

        if (!schedules?.length) {
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

        const filter = slotFilter || 'all';
        const renderSlot = (s, dateStr) => {
            const status = s.status || 'available';
            return `<div class="schedules-slot-item" data-status="${status}" data-date="${escapeHtml(dateStr)}" data-start="${escapeHtml(s.start)}"><span class="schedules-slot-indicator ${status}" aria-hidden="true"></span><span class="schedules-slot-time">${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}</span></div>`;
        };

        const blocks = schedules.map((sch) => {
            const dateStr = sch.date || sch.id || '';
            const slots = dedupeSlots(sch.slots || [], dateStr);
            let filtered = filter === 'available' ? slots.filter((s) => (s.status || 'available') === 'available')
                : filter === 'booked' ? slots.filter((s) => s.status === 'booked') : slots;
            if (filter !== 'all' && !filtered.length) return '';
            const slotHtml = filtered.length ? filtered.map((s) => renderSlot(s, dateStr)).join('') : '<p class="schedules-no-slots">None</p>';
            return `<div class="schedules-date-block"><h3 class="schedules-date-title">${escapeHtml(formatDisplayDate(dateStr))}</h3><div class="schedules-slot-list">${slotHtml}</div></div>`;
        }).filter(Boolean).join('');

        listEl.innerHTML = blocks || (filter !== 'all' ? '<p class="schedules-no-slots">No matching slots in this view.</p>' : '');
    }

    async function loadSchedulesView() {
        const filterMode = $('schedules-filter')?.value || 'all';
        const specificDate = $('schedules-date-picker')?.value || '';
        const slotFilter = document.querySelector('.schedules-slot-btn.active')?.dataset?.slotFilter || 'all';
        const all = await loadAllSchedules();
        const filtered = filterSchedules(all, filterMode, specificDate);
        renderSchedulesView(filtered, slotFilter);
    }

    // --- Template modal (create/edit) ---
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

        document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === templateType));
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

    function openModalForEdit(template) {
        openModal(template);
    }

    function closeModal() {
        editingTemplateId = null;
        setModalVisible('template-modal-overlay', 'template-modal', false);
    }

    // --- View modal ---
    function openViewModal(template) {
        const overlay = $('template-view-overlay');
        const modal = $('template-view-modal');
        const titleEl = $('template-view-title');
        const typeEl = $('template-view-type');
        const scheduleEl = $('template-view-schedule');
        if (!overlay || !modal || !titleEl || !typeEl || !scheduleEl) return;

        titleEl.textContent = template.name || 'Unnamed';
        typeEl.textContent = template.type === 'week' ? 'Week template' : 'Day template';
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

    function closeViewModal() {
        setModalVisible('template-view-overlay', 'template-view-modal', false);
    }

    // --- Apply modal ---
    function openApplyModal(template) {
        const overlay = $('apply-modal-overlay');
        const modal = $('apply-modal');
        if (!overlay || !modal) return;

        $('apply-template-name').textContent = template.name || 'Unnamed';
        $('apply-start-date').value = '';
        $('apply-end-date').value = '';
        $('apply-error-msg').textContent = '';
        $('apply-error-msg').classList.add('is-hidden');
        overlay.dataset.templateId = template.id;
        overlay.dataset.templateJson = JSON.stringify(template);
        setModalVisible('apply-modal-overlay', 'apply-modal', true);
        setTimeout(() => $('apply-start-date')?.focus(), 100);
    }

    function closeApplyModal() {
        setModalVisible('apply-modal-overlay', 'apply-modal', false);
    }

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
            loadSchedulesView();
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
            loadSchedulesView();
        } catch (e) {
            if (errEl) { errEl.textContent = e.message || 'Failed to apply template.'; errEl.classList.remove('is-hidden'); }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function onConflictReplace() {
        const overlay = $('conflict-modal-overlay');
        const templateJson = overlay?.dataset?.templateJson;
        const startVal = overlay?.dataset?.startVal;
        const endVal = overlay?.dataset?.endVal;
        const case2Json = overlay?.dataset?.case2Json;
        if (!templateJson || !startVal || !endVal || !case2Json) return;
        const template = JSON.parse(templateJson);
        const replaceDates = JSON.parse(case2Json);
        executeApplyWithOptions(template, startVal, endVal, replaceDates, []);
    }

    function onConflictCancel() {
        const overlay = $('conflict-modal-overlay');
        const templateJson = overlay?.dataset?.templateJson;
        const startVal = overlay?.dataset?.startVal;
        const endVal = overlay?.dataset?.endVal;
        const case2Json = overlay?.dataset?.case2Json;
        if (!templateJson || !startVal || !endVal || !case2Json) return;
        const template = JSON.parse(templateJson);
        const skipDates = JSON.parse(case2Json);
        executeApplyWithOptions(template, startVal, endVal, [], skipDates);
    }

    // --- Date/slot helpers ---
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

    function getSlotsForDateFromTemplate(template, date) {
        const dayName = getWeekdayFromDate(date);
        if (template.type === 'week' && template.days) {
            const slots = template.days[dayName];
            return Array.isArray(slots) ? slots.filter((s) => s.start && s.end && s.start < s.end).map((s) => ({ start: s.start, end: s.end, status: 'available' })) : [];
        }
        if (template.type === 'day' && template.slots) {
            return template.slots.filter((s) => s.start && s.end && s.start < s.end).map((s) => ({ start: s.start, end: s.end, status: 'available' }));
        }
        return [];
    }

    // --- Template conflict handling ---
    function slotsOverlap(slotA, slotB) {
        return slotA.start < slotB.end && slotB.start < slotA.end;
    }

    function getConflictCase(existingSlots, newSlots) {
        if (!existingSlots?.length) return { case: 1 };
        if (!newSlots?.length) return { case: 1 };
        let hasOverlap = false;
        let hasBookedOverlap = false;
        for (const existing of existingSlots) {
            for (const neu of newSlots) {
                if (slotsOverlap(existing, neu)) {
                    hasOverlap = true;
                    if ((existing.status || 'available') === 'booked') {
                        hasBookedOverlap = true;
                        break;
                    }
                }
            }
            if (hasBookedOverlap) break;
        }
        if (hasBookedOverlap) return { case: 3 };
        if (hasOverlap) return { case: 2 };
        return { case: 1 };
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
            const newSlots = getSlotsForDateFromTemplate(template, current);
            if (newSlots.length === 0) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
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

        const replaceDates = new Set(options.replaceDates || []);
        const skipDates = new Set(options.skipDates || []);
        let created = 0;
        const current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            if (skipDates.has(dateStr)) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const newSlots = getSlotsForDateFromTemplate(template, current);
            if (newSlots.length === 0) {
                current.setDate(current.getDate() + 1);
                continue;
            }
            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
            const existingSlots = existingDoc.exists() ? (existingDoc.data().slots || []) : [];
            const conflict = getConflictCase(existingSlots, newSlots);

            let finalSlots;
            if (replaceDates.has(dateStr)) {
                finalSlots = newSlots;
            } else if (conflict.case === 1 && existingSlots.length > 0) {
                finalSlots = mergeSlots(existingSlots, newSlots);
            } else {
                finalSlots = newSlots;
            }
            await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: finalSlots });
            created++;
            current.setDate(current.getDate() + 1);
        }
        return created;
    }

    // --- Slot rendering (unified for week & day) ---
    function createSlotRow(slotsArray, idx, onRemove) {
        const row = document.createElement('div');
        row.className = 'template-slot-row';
        row.innerHTML = `
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" data-slot-index="${idx}" data-slot-field="start" aria-label="Start time">
            </div>
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" data-slot-index="${idx}" data-slot-field="end" aria-label="End time">
            </div>
            <button type="button" class="template-slot-delete" data-slot-index="${idx}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
        `;
        const startInput = row.querySelector('[data-slot-field="start"]');
        const endInput = row.querySelector('[data-slot-field="end"]');
        const deleteBtn = row.querySelector('.template-slot-delete');
        const update = () => {
            slotsArray[idx].start = startInput?.value ?? '';
            slotsArray[idx].end = endInput?.value ?? '';
        };
        startInput?.addEventListener('change', update);
        endInput?.addEventListener('change', update);
        deleteBtn?.addEventListener('click', () => { slotsArray.splice(idx, 1); onRemove(); });
        return row;
    }

    function renderSlotsList(containerId, slotsArray, onRemove) {
        const list = $(containerId);
        if (!list) return;
        list.innerHTML = '';
        if (slotsArray.length === 0) {
            slotsArray.push({ start: '', end: '' });
            list.appendChild(createSlotRow(slotsArray, 0, onRemove));
            return;
        }
        slotsArray.forEach((slot, i) => {
            const row = createSlotRow(slotsArray, i, onRemove);
            row.querySelector('[data-slot-field="start"]').value = slot.start;
            row.querySelector('[data-slot-field="end"]').value = slot.end;
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

    // --- Copy & sync ---
    function toggleWeekDaySections() {
        $('template-week-section')?.classList.toggle('is-hidden', templateType !== 'week');
        $('template-day-section')?.classList.toggle('is-hidden', templateType !== 'day');
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
        const sel = $('template-copy-source-select');
        if (!sel) return;
        const type = getCopySourceType();
        if (type === 'day') {
            const others = DAYS.filter((d) => d !== selectedDay);
            sel.innerHTML = '<option value="">— Select day —</option>' + others.map((d) => `<option value="${d}">${DAY_LABELS[d]}</option>`).join('');
        } else {
            const dayTemplates = cachedTemplates.filter((t) => t.type === 'day');
            sel.innerHTML = '<option value="">— Select template —</option>' + dayTemplates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</option>`).join('');
        }
    }

    function populateCopyFromTemplateSelect() {
        const sel = $('template-copy-from-template');
        if (!sel) return;
        const dayTemplates = cachedTemplates.filter((t) => t.type === 'day' && t.id !== editingTemplateId);
        sel.innerHTML = '<option value="">— Select template —</option>' + dayTemplates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</option>`).join('');
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

    // --- Validation & save ---
    function validateSlotList(slots, dayLabel) {
        const prefix = dayLabel ? dayLabel + ': ' : '';
        const withTimes = slots.filter((s) => s.start && s.end);
        for (const s of withTimes) {
            if (s.start >= s.end) return { valid: false, message: prefix + 'Start time must be before end time.' };
        }
        const validSlots = withTimes.filter((s) => s.start < s.end).sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 1; i < validSlots.length; i++) {
            if (validSlots[i].start < validSlots[i - 1].end) return { valid: false, message: prefix + 'Time slots must not overlap.' };
        }
        return { valid: true };
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

    function showTemplateError(msg) {
        const el = $('template-error-msg');
        if (el) { el.textContent = msg || ''; el.classList.remove('is-hidden'); }
    }

    function hideTemplateError() {
        const el = $('template-error-msg');
        if (el) { el.textContent = ''; el.classList.add('is-hidden'); }
    }

    function showToast(message) {
        document.getElementById('template-success-toast')?.remove();
        const toast = document.createElement('div');
        toast.id = 'template-success-toast';
        toast.className = 'template-success-toast';
        toast.setAttribute('role', 'status');
        toast.textContent = message;
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
                const result = validateSlotList(slots, slots.length ? DAY_LABELS[day] : null);
                if (!result.valid) { showTemplateError(result.message); return; }
            }
        } else {
            const result = validateSlotList(daySlots);
            if (!result.valid) { showTemplateError(result.message); return; }
            if (!daySlots.some((s) => s.start && s.end && s.start < s.end)) {
                showTemplateError('Day template must have at least one time slot.');
                return;
            }
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

    // --- Event bindings ---
    document.addEventListener('DOMContentLoaded', () => {
        $('template-create-btn')?.addEventListener('click', () => openModal());
        $('template-modal-close')?.addEventListener('click', closeModal);
        $('template-cancel-btn')?.addEventListener('click', closeModal);
        $('template-modal-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'template-modal-overlay') closeModal(); });
        $('template-save-btn')?.addEventListener('click', validateAndSave);

        $('template-view-close')?.addEventListener('click', closeViewModal);
        $('template-view-close-btn')?.addEventListener('click', closeViewModal);
        $('template-view-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'template-view-overlay') closeViewModal(); });

        document.querySelectorAll('input[name="template-type"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                templateType = radio.value;
                document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === templateType));
                toggleWeekDaySections();
            });
        });
        document.querySelectorAll('.template-type-option').forEach((opt) => {
            opt.addEventListener('click', (e) => {
                const input = opt.querySelector('input');
                if (input && !input.checked) {
                    input.checked = true;
                    templateType = input.value;
                    document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === templateType));
                    toggleWeekDaySections();
                }
            });
        });

        $('template-add-slot-btn')?.addEventListener('click', () => {
            if (!weekSlots[selectedDay]) weekSlots[selectedDay] = [];
            addSlotRow('template-slots-list', weekSlots[selectedDay], renderWeekSlots);
        });
        $('template-day-add-slot-btn')?.addEventListener('click', () => addSlotRow('template-day-slots-list', daySlots, renderDaySlots));
        $('template-copy-week-btn')?.addEventListener('click', copyFromSourceWeek);
        $('template-copy-from-template-btn')?.addEventListener('click', copyFromTemplate);
        document.querySelectorAll('input[name="template-copy-source"]').forEach((r) => r.addEventListener('change', populateCopySourceSelect));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!$('conflict-modal')?.classList.contains('is-hidden')) closeConflictModal(true);
                else if (!$('template-view-modal')?.classList.contains('is-hidden')) closeViewModal();
                else if (!$('apply-modal')?.classList.contains('is-hidden')) closeApplyModal();
                else if (!$('template-modal')?.classList.contains('is-hidden')) closeModal();
            }
        });

        $('apply-modal-close')?.addEventListener('click', closeApplyModal);
        $('apply-cancel-btn')?.addEventListener('click', closeApplyModal);
        $('apply-modal-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'apply-modal-overlay') closeApplyModal(); });
        $('apply-submit-btn')?.addEventListener('click', doApplyTemplate);

        $('conflict-modal-close')?.addEventListener('click', () => closeConflictModal(true));
        $('conflict-modal-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'conflict-modal-overlay') closeConflictModal(true); });
        $('conflict-replace-btn')?.addEventListener('click', onConflictReplace);
        $('conflict-cancel-btn')?.addEventListener('click', onConflictCancel);

        $('schedules-filter')?.addEventListener('change', () => {
            $('schedules-date-wrap')?.classList.toggle('is-hidden', $('schedules-filter')?.value !== 'date');
            if ($('schedules-filter')?.value === 'date' && !$('schedules-date-picker')?.value) $('schedules-date-picker').value = getTodayDateString();
            loadSchedulesView();
        });
        $('schedules-date-picker')?.addEventListener('change', loadSchedulesView);
        document.querySelectorAll('.schedules-slot-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.schedules-slot-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                loadSchedulesView();
            });
        });

        if (auth.currentUser) {
            loadTemplates();
            loadSchedulesView();
        } else {
            const unsub = auth.onAuthStateChanged((user) => {
                if (user) { loadTemplates(); loadSchedulesView(); unsub(); }
            });
        }
    });
})();
