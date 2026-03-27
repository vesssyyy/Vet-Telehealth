export function registerTemplateEvents(ctx) {
    const {
        $, onOverlayClick,
        templateApi,
        getWeekSlots, getSelectedDay, getDaySlots,
        getCurrentTemplateAction, loadTemplates
    } = ctx;

    $('template-create-btn')?.addEventListener('click', () => templateApi.openModal());
    $('template-modal-close')?.addEventListener('click', templateApi.closeModal);
    $('template-cancel-btn')?.addEventListener('click', templateApi.closeModal);
    onOverlayClick('template-modal-overlay', templateApi.closeModal);
    $('template-save-btn')?.addEventListener('click', () => templateApi.validateAndSave(loadTemplates));

    $('template-view-close')?.addEventListener('click', templateApi.closeViewModal);
    $('template-view-close-btn')?.addEventListener('click', templateApi.closeViewModal);
    onOverlayClick('template-view-overlay', templateApi.closeViewModal);

    $('template-add-slot-btn')?.addEventListener('click', () => {
        const weekSlots = getWeekSlots();
        const selectedDay = getSelectedDay();
        if (!weekSlots[selectedDay]) weekSlots[selectedDay] = [];
        templateApi.addSlotRow('template-slots-list', weekSlots[selectedDay], templateApi.renderWeekSlots);
    });
    $('template-day-add-slot-btn')?.addEventListener('click', () => templateApi.addSlotRow('template-day-slots-list', getDaySlots(), templateApi.renderDaySlots));
    $('template-copy-week-btn')?.addEventListener('click', templateApi.copyFromSourceWeek);
    $('template-copy-from-template-btn')?.addEventListener('click', templateApi.copyFromTemplate);
    document.querySelectorAll('input[name="template-copy-source"]').forEach((r) => r.addEventListener('change', templateApi.populateCopySourceSelect));
    templateApi.bindTemplateCopyDropdowns();

    $('template-action-close')?.addEventListener('click', templateApi.closeTemplateActionModal);
    onOverlayClick('template-action-overlay', templateApi.closeTemplateActionModal);
    $('template-action-modal')?.addEventListener('click', (e) => e.stopPropagation());
    $('template-action-apply')?.addEventListener('click', () => { const t = getCurrentTemplateAction(); if (t) { templateApi.closeTemplateActionModal(); templateApi.openApplyModal(t); } });
    $('template-action-view')?.addEventListener('click', () => { const t = getCurrentTemplateAction(); if (t) { templateApi.closeTemplateActionModal(); templateApi.openViewModal(t); } });
    $('template-action-edit')?.addEventListener('click', () => { const t = getCurrentTemplateAction(); if (t) { templateApi.closeTemplateActionModal(); templateApi.openModal(t); } });
    $('template-action-delete')?.addEventListener('click', () => { const t = getCurrentTemplateAction(); if (t) { templateApi.closeTemplateActionModal(); templateApi.deleteTemplate(t, loadTemplates); } });

    $('apply-start-date')?.addEventListener('change', () => {
        const startVal = $('apply-start-date')?.value;
        if (startVal) $('apply-end-date').min = startVal;
    });
    $('apply-modal-close')?.addEventListener('click', templateApi.closeApplyModal);
    $('apply-cancel-btn')?.addEventListener('click', templateApi.closeApplyModal);
    onOverlayClick('apply-modal-overlay', templateApi.closeApplyModal);
    $('apply-submit-btn')?.addEventListener('click', templateApi.doApplyTemplate);

    $('conflict-modal-close')?.addEventListener('click', () => templateApi.closeConflictModal(true));
    onOverlayClick('conflict-modal-overlay', () => templateApi.closeConflictModal(true));
    $('conflict-replace-btn')?.addEventListener('click', templateApi.onConflictReplace);
    $('conflict-cancel-btn')?.addEventListener('click', templateApi.onConflictCancel);
}

export function createTemplateApi(ctx) {
    const {
        $, auth, DAYS, DAY_LABELS, escapeHtml, typeLabel, formatTime12h,
        setModalVisible, setErrorEl, getTodayDateString,
        templateCol, templateDoc, addDoc, updateDoc, deleteDoc,
        parseLocalDate, toLocalDateString, getSlotsForDateFromTemplate, getConflictCase, mergeSlots,
        ensureSlotExpiry, getMinAdvanceMinutes, scheduleDoc, getDoc, setDoc,
        invalidateSchedulesCache, loadSchedulesView, loadWeeklyScheduleView,
        getEditingTemplateId, setEditingTemplateId,
        getTemplateType, setTemplateType,
        getSelectedDay, setSelectedDay,
        getWeekSlots, setWeekSlots,
        getDaySlots, setDaySlots,
        getCurrentTemplateAction, setCurrentTemplateAction,
        getCachedTemplates
    } = ctx;

    function initWeekSlots() {
        setWeekSlots({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] });
    }

    function toggleWeekDaySections() {
        $('template-week-section')?.classList.toggle('is-hidden', getTemplateType() !== 'week');
        $('template-day-section')?.classList.toggle('is-hidden', getTemplateType() !== 'day');
    }

    function syncTemplateTypeUI() {
        document.querySelectorAll('.template-type-option').forEach((el) => el.classList.toggle('selected', el.querySelector('input')?.value === getTemplateType()));
    }

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
        const weekSlots = getWeekSlots();
        const selectedDay = getSelectedDay();
        if (!weekSlots[selectedDay]) weekSlots[selectedDay] = [];
        renderSlotsList('template-slots-list', weekSlots[selectedDay], renderWeekSlots);
    }

    function renderDaySlots() {
        renderSlotsList('template-day-slots-list', getDaySlots(), renderDaySlots);
    }

    function addSlotRow(containerId, slotsArray, onRemove) {
        slotsArray.push({ start: '', end: '' });
        $(containerId)?.appendChild(createSlotRow(slotsArray, slotsArray.length - 1, onRemove));
    }

    function syncSlotsFromInputs() {
        const templateType = getTemplateType();
        const selectedDay = getSelectedDay();
        const list = templateType === 'week' ? $('template-slots-list') : $('template-day-slots-list');
        const slots = templateType === 'week' ? (getWeekSlots()[selectedDay] || []) : getDaySlots();
        list?.querySelectorAll('input[type="time"]').forEach((inp) => {
            const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
            const field = inp.getAttribute('data-slot-field');
            if (!isNaN(idx) && slots[idx]) slots[idx][field] = inp.value || '';
        });
    }

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
        if (getTemplateType() === 'week') {
            const days = {};
            const weekSlots = getWeekSlots();
            DAYS.forEach((day) => {
                const arr = (weekSlots[day] || []).filter((s) => s.start && s.end && s.start < s.end);
                if (arr.length) days[day] = arr;
            });
            return { type: 'week', days };
        }
        const slots = getDaySlots().filter((s) => s.start && s.end && s.start < s.end);
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

    function renderDaysList() {
        const list = $('template-days-list');
        if (!list) return;
        list.innerHTML = '';
        DAYS.forEach((day) => {
            const label = document.createElement('label');
            label.className = 'template-day-item' + (getSelectedDay() === day ? ' selected' : '');
            label.innerHTML = `<input type="checkbox" ${getSelectedDay() === day ? 'checked' : ''} aria-label="${DAY_LABELS[day]}"><span>${DAY_LABELS[day]}</span>`;
            label.addEventListener('click', (e) => {
                e.preventDefault();
                syncSlotsFromInputs();
                setSelectedDay(day);
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
            const others = DAYS.filter((d) => d !== getSelectedDay());
            items = others.map((d) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${d}">${DAY_LABELS[d]}</button>`).join('');
        } else {
            const dayTemplates = getCachedTemplates().filter((t) => t.type === 'day');
            items = dayTemplates.map((t) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</button>`).join('');
        }
        menu.innerHTML = items || '<span class="vet-template-copy-empty">No options</span>';
        hiddenInput.value = '';
        if (triggerText) triggerText.textContent = 'Copy from';
        menu.querySelectorAll('.vet-template-copy-item').forEach((btn) => {
            btn.onclick = () => {
                hiddenInput.value = btn.dataset.value;
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
        const dayTemplates = getCachedTemplates().filter((t) => t.type === 'day' && t.id !== getEditingTemplateId());
        const items = dayTemplates.map((t) => `<button type="button" class="dropdown-item vet-template-copy-item" role="menuitem" data-value="${escapeHtml(t.id)}">${escapeHtml(t.name || 'Unnamed')}</button>`).join('');
        menu.innerHTML = items || '<span class="vet-template-copy-empty">No templates</span>';
        hiddenInput.value = '';
        if (triggerText) triggerText.textContent = 'Copy from';
        menu.querySelectorAll('.vet-template-copy-item').forEach((btn) => {
            btn.onclick = () => {
                hiddenInput.value = btn.dataset.value;
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
        const weekSlots = getWeekSlots();
        if (type === 'day') {
            const slots = (weekSlots[value] || []).map((s) => ({ start: s.start || '', end: s.end || '' }));
            if (!slots.length) { showToast('Selected day has no slots.'); return; }
            weekSlots[getSelectedDay()] = [...slots];
            $('template-copy-source-select').value = '';
            renderWeekSlots();
            showToast(`Copied ${slots.length} slot(s) from ${DAY_LABELS[value]}.`);
        } else {
            const template = getCachedTemplates().find((t) => t.id === value);
            if (!template || template.type !== 'day' || !Array.isArray(template.slots) || !template.slots.length) {
                showToast('Selected template has no slots.');
                return;
            }
            weekSlots[getSelectedDay()] = template.slots.map((s) => ({ start: s.start || '', end: s.end || '' }));
            $('template-copy-source-select').value = '';
            renderWeekSlots();
            showToast(`Copied ${weekSlots[getSelectedDay()].length} slot(s) from "${template.name || 'template'}".`);
        }
    }

    function copyFromTemplate() {
        const templateId = $('template-copy-from-template')?.value;
        if (!templateId) { showToast('Select a template to copy from.'); return; }
        const template = getCachedTemplates().find((t) => t.id === templateId);
        if (!template || template.type !== 'day' || !Array.isArray(template.slots) || !template.slots.length) {
            showToast('Selected template has no slots.');
            return;
        }
        setDaySlots(template.slots.map((s) => ({ start: s.start || '', end: s.end || '' })));
        $('template-copy-from-template').value = '';
        renderDaySlots();
        showToast(`Copied ${getDaySlots().length} slot(s) from "${template.name || 'template'}".`);
    }

    function openModal(template = null) {
        setEditingTemplateId(template?.id ?? null);
        const overlay = $('template-modal-overlay');
        const modal = $('template-modal');
        if (!overlay || !modal) return;

        $('template-modal-title').textContent = template ? 'Edit template' : 'Create availability template';
        setTemplateType(template?.type || 'week');
        setSelectedDay('monday');
        $('template-name').value = (template?.name || '').trim();
        $('template-type-week').checked = getTemplateType() === 'week';
        $('template-type-day').checked = getTemplateType() === 'day';

        if (getTemplateType() === 'week') {
            initWeekSlots();
            setDaySlots([]);
            if (template?.days) {
                const weekSlots = getWeekSlots();
                DAYS.forEach((day) => { weekSlots[day] = (template.days[day] || []).map((s) => ({ start: s.start || '', end: s.end || '' })); });
            }
        } else {
            setDaySlots((template?.slots || []).map((s) => ({ start: s.start || '', end: s.end || '' })));
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

    function closeModal() { setEditingTemplateId(null); setModalVisible('template-modal-overlay', 'template-modal', false); }

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
    function openTemplateActionModal(template) {
        if (!$('template-action-overlay') || !$('template-action-modal')) return;
        setCurrentTemplateAction(template);
        const iconEl = $('template-action-modal')?.querySelector('.appointments-template-icon i');
        if (iconEl) iconEl.className = `fa fa-${template.type === 'week' ? 'calendar' : 'clock-o'}`;
        $('template-action-name').textContent = template.name || 'Unnamed';
        $('template-action-meta').textContent = typeLabel(template);
        setModalVisible('template-action-overlay', 'template-action-modal', true);
    }
    function closeTemplateActionModal() { setCurrentTemplateAction(null); setModalVisible('template-action-overlay', 'template-action-modal', false); }

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
            if (existingDoc.exists() && existingDoc.data().blocked === true) { current.setDate(current.getDate() + 1); continue; }
            const newSlots = getSlotsForDateFromTemplate(template, current);
            if (newSlots.length === 0) { current.setDate(current.getDate() + 1); continue; }
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
            if (dateStr < today) { current.setDate(current.getDate() + 1); continue; }
            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
            if (existingDoc.exists() && existingDoc.data().blocked === true) { current.setDate(current.getDate() + 1); continue; }
            if (skipDates.has(dateStr)) { current.setDate(current.getDate() + 1); continue; }
            const newSlots = getSlotsForDateFromTemplate(template, current, minAdvance, true);
            if (newSlots.length === 0) { current.setDate(current.getDate() + 1); continue; }
            const existingSlots = (existingDoc.exists() ? (existingDoc.data().slots || []) : []).map((s) => ensureSlotExpiry(s, dateStr));
            const conflict = getConflictCase(existingSlots, newSlots);
            let finalSlots;
            if (replaceDates.has(dateStr)) finalSlots = newSlots;
            else if (conflict.case === 1 && existingSlots.length > 0) finalSlots = mergeSlots(existingSlots, newSlots).map((s) => ensureSlotExpiry(s, dateStr));
            else finalSlots = newSlots;
            await setDoc(scheduleDoc(user.uid, dateStr), { date: dateStr, slots: finalSlots });
            created++;
            current.setDate(current.getDate() + 1);
        }
        return created;
    }
    async function executeApplyWithOptions(template, startVal, endVal, replaceDates, skipDates) {
        const errEl = $('apply-error-msg');
        const saveBtn = $('apply-submit-btn');
        const refreshViews = () => {
            invalidateSchedulesCache();
            loadSchedulesView();
            loadWeeklyScheduleView();
        };
        if (saveBtn) saveBtn.disabled = true;
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        try {
            const count = await applyTemplateToDateRange(template, startVal, endVal, { replaceDates, skipDates });
            closeApplyModal();
            closeConflictModal();
            showToast(`Template applied to ${count} day(s).`);
            refreshViews();
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
            if (analysis.case3.length > 0) throw new Error('Some conflicting time slots already have booked appointments. The template cannot be applied.');
            if (analysis.case2.length > 0) {
                if (saveBtn) saveBtn.disabled = false;
                showConflictModal(analysis, template, startVal, endVal);
                return;
            }
            const count = await applyTemplateToDateRange(template, startVal, endVal);
            closeApplyModal();
            showToast(`Template applied to ${count} day(s).`);
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
    function onConflictReplace() { const d = getConflictOverlayData(); if (!d) return; executeApplyWithOptions(d.template, d.startVal, d.endVal, d.case2, []); }
    function onConflictCancel() { const d = getConflictOverlayData(); if (!d) return; executeApplyWithOptions(d.template, d.startVal, d.endVal, [], d.case2); }

    function validateAndSave(loadTemplates) {
        const name = ($('template-name').value || '').trim();
        if (!name) { showTemplateError('Please enter a template name.'); return; }
        syncSlotsFromInputs();
        if (getTemplateType() === 'week') {
            const weekSlots = getWeekSlots();
            for (const day of DAYS) {
                const slots = weekSlots[day] || [];
                const result = validateSlots(slots, slots.length ? DAY_LABELS[day] : null);
                if (!result.valid) { showTemplateError(result.message); return; }
            }
        } else {
            const result = validateSlots(getDaySlots());
            if (!result.valid) { showTemplateError(result.message); return; }
            if (!getDaySlots().some((s) => s.start && s.end && s.start < s.end)) { showTemplateError('Day template must have at least one time slot.'); return; }
        }
        const payload = getSlotsForSave();
        hideTemplateError();
        const saveBtn = $('template-save-btn');
        const user = auth.currentUser;
        if (!user) { showTemplateError('You must be signed in to save.'); return; }
        if (saveBtn) saveBtn.disabled = true;
        const data = { name, type: payload.type };
        if (payload.type === 'week') data.days = payload.days; else data.slots = payload.slots;
        const savePromise = getEditingTemplateId() ? updateDoc(templateDoc(user.uid, getEditingTemplateId()), data) : addDoc(templateCol(user.uid), data);
        savePromise.then(() => {
            closeModal();
            showToast(getEditingTemplateId() ? 'Template updated.' : 'Template saved successfully.');
            loadTemplates();
        }).catch((err) => {
            console.error('Save template error:', err);
            showTemplateError('Failed to save. Please try again.');
        }).finally(() => { if (saveBtn) saveBtn.disabled = false; });
    }

    function deleteTemplate(template, loadTemplates) {
        if (!confirm(`Delete template "${template.name || 'Unnamed'}"? This cannot be undone.`)) return;
        const user = auth.currentUser;
        if (!user) return;
        deleteDoc(templateDoc(user.uid, template.id))
            .then(() => { showToast('Template deleted.'); loadTemplates(); })
            .catch((err) => { console.error('Delete template error:', err); showToast('Failed to delete template.'); });
    }

    return {
        initWeekSlots, openModal, closeModal, openViewModal, closeViewModal,
        openTemplateActionModal, closeTemplateActionModal, openApplyModal, closeApplyModal,
        showConflictModal, closeConflictModal, executeApplyWithOptions, doApplyTemplate, getConflictOverlayData, onConflictReplace, onConflictCancel,
        analyzeConflictForDateRange, applyTemplateToDateRange,
        createSlotRow, renderSlotsList, renderWeekSlots, renderDaySlots, addSlotRow,
        toggleWeekDaySections, syncTemplateTypeUI, renderDaysList,
        populateCopySourceSelect, populateCopyFromTemplateSelect, bindTemplateCopyDropdowns,
        copyFromSourceWeek, copyFromTemplate, syncSlotsFromInputs, validateSlots, getSlotsForSave,
        showToast,
        validateAndSave,
        deleteTemplate: (t, loadTemplates) => deleteTemplate(t, loadTemplates),
    };
}
