/** Televet Health — Vet Appointments: availability template creation (week / day) */
import { auth, db } from '../../shared/js/firebase-config.js';
import {
    collection,
    doc,
    getDocs,
    addDoc,
    updateDoc,
    deleteDoc,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';

    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const DAY_LABELS = { monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday' };

    const $ = (id) => document.getElementById(id);
    const templateCol = (uid) => collection(db, 'users', uid, 'template');
    const templateDoc = (uid, templateId) => doc(db, 'users', uid, 'template', templateId);

    let selectedDay = 'monday';
    let editingTemplateId = null;
    let weekSlots = {}; // { monday: [{ start, end }], ... }
    let daySlots = []; // [{ start, end }, ...]
    let templateType = 'week';

    function showEmpty(show) {
        const list = $('appointments-templates-list');
        const empty = $('appointments-empty');
        if (list) list.classList.toggle('is-hidden', show);
        if (empty) empty.classList.toggle('is-hidden', !show);
    }

    function renderTemplatesList(templates) {
        const list = $('appointments-templates-list');
        if (!list) return;
        list.innerHTML = '';
        if (!templates || templates.length === 0) {
            showEmpty(true);
            return;
        }
        showEmpty(false);
        templates.forEach((t) => {
            const card = document.createElement('div');
            card.className = 'appointments-template-card';
            const typeLabel = t.type === 'week' ? 'Week template' : 'Day template';
            card.innerHTML = `
                <div class="appointments-template-info">
                    <div class="appointments-template-icon"><i class="fa fa-${t.type === 'week' ? 'calendar' : 'clock-o'}" aria-hidden="true"></i></div>
                    <div>
                        <div class="appointments-template-name">${escapeHtml(t.name || 'Unnamed')}</div>
                        <div class="appointments-template-meta">${escapeHtml(typeLabel)}</div>
                    </div>
                </div>
                <div class="appointments-template-actions">
                    <button type="button" class="appointments-template-btn btn-view" data-action="view" aria-label="View"><i class="fa fa-eye" aria-hidden="true"></i> View</button>
                    <button type="button" class="appointments-template-btn btn-edit" data-action="edit" aria-label="Edit"><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>
                    <button type="button" class="appointments-template-btn btn-delete" data-action="delete" aria-label="Delete"><i class="fa fa-trash-o" aria-hidden="true"></i> Delete</button>
                </div>
            `;
            card.dataset.templateId = t.id;
            const viewBtn = card.querySelector('[data-action="view"]');
            const editBtn = card.querySelector('[data-action="edit"]');
            const deleteBtn = card.querySelector('[data-action="delete"]');
            viewBtn?.addEventListener('click', () => openViewModal(t));
            editBtn?.addEventListener('click', () => openModalForEdit(t));
            deleteBtn?.addEventListener('click', () => deleteTemplate(t));
            list.appendChild(card);
        });
    }

    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    function loadTemplates() {
        const user = auth.currentUser;
        if (!user) return Promise.resolve([]);
        return getDocs(templateCol(user.uid)).then((snap) => {
            const templates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            renderTemplatesList(templates);
            return templates;
        }).catch((err) => {
            console.error('Load templates error:', err);
            showEmpty(true);
            return [];
        });
    }

    function openModal() {
        editingTemplateId = null;
        const overlay = $('template-modal-overlay');
        const modal = $('template-modal');
        const titleEl = $('template-modal-title');
        if (!overlay || !modal) return;
        if (titleEl) titleEl.textContent = 'Create availability template';
        templateType = 'week';
        selectedDay = 'monday';
        weekSlots = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
        daySlots = [];
        $('template-name').value = '';
        $('template-type-week').checked = true;
        $('template-type-day').checked = false;
        document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === 'week'));
        toggleWeekDaySections();
        renderDaysList();
        renderWeekSlots();
        renderDaySlots();
        updateDayHeading();
        hideTemplateError();
        overlay.classList.remove('is-hidden');
        overlay.setAttribute('aria-hidden', 'false');
        modal.classList.remove('is-hidden');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => $('template-name')?.focus(), 100);
    }

    function openModalForEdit(template) {
        editingTemplateId = template.id;
        const overlay = $('template-modal-overlay');
        const modal = $('template-modal');
        const titleEl = $('template-modal-title');
        if (!overlay || !modal) return;
        if (titleEl) titleEl.textContent = 'Edit template';
        templateType = template.type || 'week';
        $('template-name').value = (template.name || '').trim();
        $('template-type-week').checked = templateType === 'week';
        $('template-type-day').checked = templateType === 'day';
        document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === templateType));
        if (templateType === 'week') {
            weekSlots = {};
            DAYS.forEach((day) => {
                weekSlots[day] = Array.isArray(template.days?.[day]) ? template.days[day].map((s) => ({ start: s.start || '', end: s.end || '' })) : [];
            });
            daySlots = [];
        } else {
            daySlots = Array.isArray(template.slots) ? template.slots.map((s) => ({ start: s.start || '', end: s.end || '' })) : [];
            weekSlots = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
        }
        selectedDay = 'monday';
        toggleWeekDaySections();
        renderDaysList();
        renderWeekSlots();
        renderDaySlots();
        updateDayHeading();
        hideTemplateError();
        overlay.classList.remove('is-hidden');
        overlay.setAttribute('aria-hidden', 'false');
        modal.classList.remove('is-hidden');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => $('template-name')?.focus(), 100);
    }

    function closeModal() {
        editingTemplateId = null;
        const overlay = $('template-modal-overlay');
        const modal = $('template-modal');
        if (overlay) { overlay.classList.add('is-hidden'); overlay.setAttribute('aria-hidden', 'true'); }
        if (modal) { modal.classList.add('is-hidden'); modal.setAttribute('aria-hidden', 'true'); }
    }

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
                if (!slots || slots.length === 0) return `<div class="template-view-day"><span class="template-view-day-name">${DAY_LABELS[day]}</span><p>Day off</p></div>`;
                const list = slots.map((s) => `${escapeHtml(s.start)} – ${escapeHtml(s.end)}`).join('</li><li>');
                return `<div class="template-view-day"><span class="template-view-day-name">${DAY_LABELS[day]}</span><ul class="template-view-slots"><li>${list}</li></ul></div>`;
            }).join('');
        } else if (template.type === 'day' && template.slots) {
            const list = template.slots.map((s) => `${escapeHtml(s.start)} – ${escapeHtml(s.end)}`).join('</li><li>');
            scheduleEl.innerHTML = list ? `<ul class="template-view-slots"><li>${list}</li></ul>` : '<p>No slots</p>';
        } else {
            scheduleEl.innerHTML = '<p>No schedule</p>';
        }
        overlay.classList.remove('is-hidden');
        overlay.setAttribute('aria-hidden', 'false');
        modal.classList.remove('is-hidden');
        modal.setAttribute('aria-hidden', 'false');
    }

    function closeViewModal() {
        const overlay = $('template-view-overlay');
        const modal = $('template-view-modal');
        if (overlay) { overlay.classList.add('is-hidden'); overlay.setAttribute('aria-hidden', 'true'); }
        if (modal) { modal.classList.add('is-hidden'); modal.setAttribute('aria-hidden', 'true'); }
    }

    function deleteTemplate(template) {
        if (!confirm(`Delete template "${template.name || 'Unnamed'}"? This cannot be undone.`)) return;
        const user = auth.currentUser;
        if (!user) return;
        deleteDoc(templateDoc(user.uid, template.id))
            .then(() => {
                showToast('Template deleted.');
                loadTemplates();
            })
            .catch((err) => {
                console.error('Delete template error:', err);
                showToast('Failed to delete template.');
            });
    }

    function toggleWeekDaySections() {
        const weekSec = $('template-week-section');
        const daySec = $('template-day-section');
        if (weekSec) weekSec.classList.toggle('is-hidden', templateType !== 'week');
        if (daySec) daySec.classList.toggle('is-hidden', templateType !== 'day');
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
                updateDayHeading();
            });
            list.appendChild(label);
        });
    }

    function updateDayHeading() {
        const h = $('template-day-heading');
        if (h) h.textContent = (DAY_LABELS[selectedDay] || selectedDay) + ' availability';
    }

    function addSlotRow(containerId, slotsArray, onRemove) {
        const container = $(containerId);
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'template-slot-row';
        const idx = slotsArray.length;
        slotsArray.push({ start: '', end: '' });
        row.innerHTML = `
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" placeholder="--:--" data-slot-index="${idx}" data-slot-field="start" aria-label="Start time">
            </div>
            <div class="template-slot-time-wrap">
                <i class="fa fa-clock-o" aria-hidden="true"></i>
                <input type="time" placeholder="--:--" data-slot-index="${idx}" data-slot-field="end" aria-label="End time">
            </div>
            <button type="button" class="template-slot-delete" data-slot-index="${idx}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
        `;
        const startInput = row.querySelector('[data-slot-field="start"]');
        const endInput = row.querySelector('[data-slot-field="end"]');
        const deleteBtn = row.querySelector('.template-slot-delete');
        const updateData = () => {
            slotsArray[idx].start = startInput?.value ?? '';
            slotsArray[idx].end = endInput?.value ?? '';
        };
        startInput?.addEventListener('change', updateData);
        endInput?.addEventListener('change', updateData);
        deleteBtn?.addEventListener('click', () => {
            slotsArray.splice(idx, 1);
            onRemove();
        });
        container.appendChild(row);
    }

    function renderWeekSlots() {
        const list = $('template-slots-list');
        if (!list) return;
        const slots = weekSlots[selectedDay] || [];
        list.innerHTML = '';
        if (slots.length === 0) {
            addSlotRow('template-slots-list', weekSlots[selectedDay], renderWeekSlots);
            return;
        }
        slots.forEach((_, i) => {
            const container = list;
            const row = document.createElement('div');
            row.className = 'template-slot-row';
            row.innerHTML = `
                <div class="template-slot-time-wrap">
                    <i class="fa fa-clock-o" aria-hidden="true"></i>
                    <input type="time" value="${escapeHtml(slots[i].start)}" data-slot-index="${i}" data-slot-field="start" aria-label="Start time">
                </div>
                <div class="template-slot-time-wrap">
                    <i class="fa fa-clock-o" aria-hidden="true"></i>
                    <input type="time" value="${escapeHtml(slots[i].end)}" data-slot-index="${i}" data-slot-field="end" aria-label="End time">
                </div>
                <button type="button" class="template-slot-delete" data-slot-index="${i}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
            `;
            const startInput = row.querySelector('[data-slot-field="start"]');
            const endInput = row.querySelector('[data-slot-field="end"]');
            const deleteBtn = row.querySelector('.template-slot-delete');
            const updateData = () => {
                slots[i].start = startInput?.value ?? '';
                slots[i].end = endInput?.value ?? '';
            };
            startInput?.addEventListener('change', updateData);
            endInput?.addEventListener('change', updateData);
            deleteBtn?.addEventListener('click', () => {
                slots.splice(i, 1);
                renderWeekSlots();
            });
            list.appendChild(row);
        });
    }

    function renderDaySlots() {
        const list = $('template-day-slots-list');
        if (!list) return;
        list.innerHTML = '';
        if (daySlots.length === 0) {
            addSlotRow('template-day-slots-list', daySlots, renderDaySlots);
            return;
        }
        daySlots.forEach((_, i) => {
            const container = list;
            const row = document.createElement('div');
            row.className = 'template-slot-row';
            row.innerHTML = `
                <div class="template-slot-time-wrap">
                    <i class="fa fa-clock-o" aria-hidden="true"></i>
                    <input type="time" value="${escapeHtml(daySlots[i].start)}" data-slot-index="${i}" data-slot-field="start" aria-label="Start time">
                </div>
                <div class="template-slot-time-wrap">
                    <i class="fa fa-clock-o" aria-hidden="true"></i>
                    <input type="time" value="${escapeHtml(daySlots[i].end)}" data-slot-index="${i}" data-slot-field="end" aria-label="End time">
                </div>
                <button type="button" class="template-slot-delete" data-slot-index="${i}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
            `;
            const startInput = row.querySelector('[data-slot-field="start"]');
            const endInput = row.querySelector('[data-slot-field="end"]');
            const deleteBtn = row.querySelector('.template-slot-delete');
            const updateData = () => {
                daySlots[i].start = startInput?.value ?? '';
                daySlots[i].end = endInput?.value ?? '';
            };
            startInput?.addEventListener('change', updateData);
            endInput?.addEventListener('change', updateData);
            deleteBtn?.addEventListener('click', () => {
                daySlots.splice(i, 1);
                renderDaySlots();
            });
            list.appendChild(row);
        });
    }

    function syncSlotsFromInputs() {
        if (templateType === 'week') {
            const list = $('template-slots-list');
            if (list) {
                const inputs = list.querySelectorAll('input[type="time"]');
                const slots = weekSlots[selectedDay] || [];
                inputs.forEach((inp) => {
                    const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
                    const field = inp.getAttribute('data-slot-field');
                    if (!isNaN(idx) && slots[idx]) slots[idx][field] = inp.value || '';
                });
            }
        } else {
            const list = $('template-day-slots-list');
            if (list) {
                const inputs = list.querySelectorAll('input[type="time"]');
                inputs.forEach((inp) => {
                    const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
                    const field = inp.getAttribute('data-slot-field');
                    if (!isNaN(idx) && daySlots[idx]) daySlots[idx][field] = inp.value || '';
                });
            }
        }
    }

    /** Returns { valid, message } for a list of slots. Ensures start < end and no overlaps. */
    function validateSlotList(slots, dayLabel) {
        const prefix = dayLabel ? dayLabel + ': ' : '';
        const withTimes = slots.filter((s) => s.start && s.end);
        for (const s of withTimes) {
            if (s.start >= s.end) {
                return { valid: false, message: prefix + 'Start time must be before end time (e.g. 9:00–8:00 is invalid).' };
            }
        }
        const validSlots = withTimes.filter((s) => s.start < s.end).sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 1; i < validSlots.length; i++) {
            if (validSlots[i].start < validSlots[i - 1].end) {
                return { valid: false, message: prefix + 'Time slots must not overlap.' };
            }
        }
        return { valid: true };
    }

    function getSlotsForSave() {
        syncSlotsFromInputs();
        if (templateType === 'week') {
            const days = {};
            DAYS.forEach((day) => {
                const arr = (weekSlots[day] || []).filter((s) => (s.start && s.end) && s.start < s.end);
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
        const existing = document.getElementById('template-success-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'template-success-toast';
        toast.className = 'template-success-toast';
        toast.setAttribute('role', 'status');
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function validateAndSave() {
        const name = (($('template-name').value || '').trim());
        if (!name) {
            showTemplateError('Please enter a template name.');
            return;
        }
        syncSlotsFromInputs();
        if (templateType === 'week') {
            for (const day of DAYS) {
                const slots = weekSlots[day] || [];
                const label = DAY_LABELS[day];
                const result = validateSlotList(slots, slots.length ? label : null);
                if (!result.valid) {
                    showTemplateError(result.message);
                    return;
                }
            }
        } else {
            const result = validateSlotList(daySlots);
            if (!result.valid) {
                showTemplateError(result.message);
                return;
            }
            const hasValidSlot = daySlots.some((s) => s.start && s.end && s.start < s.end);
            if (!hasValidSlot) {
                showTemplateError('Day template must have at least one time slot.');
                return;
            }
        }
        const payload = getSlotsForSave();
        hideTemplateError();
        const saveBtn = $('template-save-btn');
        if (saveBtn) saveBtn.disabled = true;
        const user = auth.currentUser;
        if (!user) {
            showTemplateError('You must be signed in to save.');
            if (saveBtn) saveBtn.disabled = false;
            return;
        }
        const data = {
            name,
            type: payload.type,
        };
        if (payload.type === 'week') data.days = payload.days;
        else data.slots = payload.slots;

        const savePromise = editingTemplateId
            ? updateDoc(templateDoc(user.uid, editingTemplateId), data)
            : addDoc(templateCol(user.uid), data);

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

    document.addEventListener('DOMContentLoaded', () => {
        $('template-create-btn')?.addEventListener('click', openModal);
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
        $('template-day-add-slot-btn')?.addEventListener('click', () => {
            addSlotRow('template-day-slots-list', daySlots, renderDaySlots);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const viewModal = $('template-view-modal');
                const editModal = $('template-modal');
                if (viewModal && !viewModal.classList.contains('is-hidden')) closeViewModal();
                else if (editModal && !editModal.classList.contains('is-hidden')) closeModal();
            }
        });

        if (auth.currentUser) loadTemplates();
        else {
            const unsub = auth.onAuthStateChanged((user) => {
                if (user) { loadTemplates(); unsub(); }
            });
        }
    });
})();
