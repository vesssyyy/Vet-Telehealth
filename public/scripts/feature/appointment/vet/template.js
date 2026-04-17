import { appConfirm } from '../../../core/ui/app-dialog.js';

export function registerTemplateEvents(ctx) {
    const {
        $, onOverlayClick,
        templateApi,
        getWeekSlots, getSelectedDay, getDaySlots,
        getCurrentTemplateAction, loadTemplates
    } = ctx;

    $('template-create-btn')?.addEventListener('click', () => templateApi.openModal());
    $('template-modal-close')?.addEventListener('click', () => {
        const panel = $('template-interval-panel');
        if (panel && !panel.classList.contains('is-hidden')) templateApi.closeGenerateIntervalModal();
        else templateApi.closeModal();
    });
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
    $('template-generate-interval-btn')?.addEventListener('click', () => templateApi.openGenerateIntervalModal('week'));
    $('template-day-generate-interval-btn')?.addEventListener('click', () => templateApi.openGenerateIntervalModal('day'));
    $('template-copy-week-btn')?.addEventListener('click', templateApi.copyFromSourceWeek);
    $('template-copy-from-template-btn')?.addEventListener('click', templateApi.copyFromTemplate);
    document.querySelectorAll('input[name="template-copy-source"]').forEach((r) => r.addEventListener('change', templateApi.populateCopySourceSelect));
    templateApi.bindTemplateCopyDropdowns();

    $('template-interval-cancel-btn')?.addEventListener('click', templateApi.closeGenerateIntervalModal);
    $('template-interval-add-skip-btn')?.addEventListener('click', templateApi.addGenerateIntervalSkipRow);
    $('template-interval-generate-btn')?.addEventListener('click', templateApi.generateIntervalSlots);

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

    $('apply-preview-close')?.addEventListener('click', templateApi.closeApplyPreviewModal);
    $('apply-preview-back-btn')?.addEventListener('click', templateApi.closeApplyPreviewModal);
    onOverlayClick('apply-preview-overlay', templateApi.closeApplyPreviewModal);
    $('apply-preview-confirm-btn')?.addEventListener('click', templateApi.confirmApplyPreview);

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

    // === Generate interval helpers ===
    function parseTimeToMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [hRaw, mRaw] = timeStr.split(':');
        const h = Number(hRaw);
        const m = Number(mRaw);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return h * 60 + m;
    }

    function minutesToTimeStr(mins) {
        const m = Math.max(0, Math.floor(mins));
        const h = Math.floor(m / 60) % 24;
        const mm = m % 60;
        return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }

    function rangesOverlap(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    function normalizeAndMergeRanges(ranges) {
        const clean = (ranges || [])
            .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start < r.end)
            .map((r) => ({ start: Math.floor(r.start), end: Math.floor(r.end) }))
            .sort((x, y) => x.start - y.start);
        if (!clean.length) return [];
        const merged = [clean[0]];
        for (let i = 1; i < clean.length; i++) {
            const last = merged[merged.length - 1];
            const cur = clean[i];
            if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
            else merged.push(cur);
        }
        return merged;
    }

    function firstOverlappingRange(ranges, target) {
        for (const r of ranges || []) {
            if (rangesOverlap(r, target)) return r;
        }
        return null;
    }

    function nextSkipEndForCandidate(skipRanges, candidate) {
        let maxEnd = null;
        for (const r of skipRanges || []) {
            if (rangesOverlap(r, candidate)) {
                maxEnd = maxEnd == null ? r.end : Math.max(maxEnd, r.end);
            }
        }
        return maxEnd;
    }

    function generateSlotsFromInterval(rangeStartMin, rangeEndMin, intervalMin, idleMin, skipRanges) {
        const skips = normalizeAndMergeRanges(skipRanges);
        const slots = [];
        let cur = rangeStartMin;
        const step = intervalMin + idleMin;

        while (cur + intervalMin <= rangeEndMin) {
            // If current start is inside a skip range, jump to skip end.
            const inside = firstOverlappingRange(skips, { start: cur, end: cur + 1 });
            if (inside && cur < inside.end) {
                cur = inside.end;
                continue;
            }

            const end = cur + intervalMin;
            if (end > rangeEndMin) break;

            const candidate = { start: cur, end };
            const skipEnd = nextSkipEndForCandidate(skips, candidate);
            if (skipEnd != null) {
                // Respect skip windows by jumping to the end of the overlapping skip range(s).
                cur = Math.max(skipEnd, cur + step);
                continue;
            }

            slots.push({ start: minutesToTimeStr(cur), end: minutesToTimeStr(end) });
            cur = end + idleMin;
            if (slots.length > 2000) break; // safety guard
        }

        // Ensure chronological unique + non-overlapping output (defensive)
        const sorted = slots
            .filter((s) => s.start && s.end && s.start < s.end)
            .sort((a, b) => a.start.localeCompare(b.start));
        const deduped = [];
        const seen = new Set();
        for (const s of sorted) {
            const key = `${s.start}|${s.end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const prev = deduped[deduped.length - 1];
            if (prev && s.start < prev.end) continue;
            deduped.push(s);
        }
        return deduped;
    }

    function initWeekSlots() {
        setWeekSlots({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] });
    }

    // === Generate interval modal ===
    function getIntervalEls() {
        return {
            panel: $('template-interval-panel'),
            start: $('template-interval-start'),
            end: $('template-interval-end'),
            interval: $('template-interval-minutes'),
            idle: $('template-idle-minutes'),
            skipList: $('template-interval-skip-list'),
            error: $('template-interval-error'),
            generateBtn: $('template-interval-generate-btn'),
        };
    }

    function clearIntervalError() {
        setErrorEl('template-interval-error', '', true);
    }

    function showIntervalError(msg) {
        setErrorEl('template-interval-error', msg, false);
    }

    function buildSkipRowDom(initial = {}) {
        const row = document.createElement('div');
        row.className = 'template-interval-skip-row';
        row.innerHTML = `
            <div class="template-interval-skip-time">
                <label>Start <input type="time" class="template-interval-skip-start" aria-label="Skip range start"></label>
                <label>End <input type="time" class="template-interval-skip-end" aria-label="Skip range end"></label>
            </div>
            <button type="button" class="template-interval-remove-skip-btn" aria-label="Remove skip range"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
        `;
        const start = row.querySelector('.template-interval-skip-start');
        const end = row.querySelector('.template-interval-skip-end');
        if (start) start.value = initial.start || '';
        if (end) end.value = initial.end || '';
        row.querySelector('.template-interval-remove-skip-btn')?.addEventListener('click', () => row.remove());
        return row;
    }

    function addGenerateIntervalSkipRow() {
        const { skipList } = getIntervalEls();
        if (!skipList) return;
        skipList.appendChild(buildSkipRowDom());
    }

    function openGenerateIntervalModal(targetType) {
        const els = getIntervalEls();
        const modal = $('template-modal');
        const mainView = $('template-modal-main-view');
        const mainFooter = $('template-modal-footer-main');
        const intervalFooter = $('template-modal-footer-interval');
        const titleEl = $('template-modal-title');
        if (!els.panel || !modal || !mainView) return;

        if (titleEl) {
            modal.dataset.titleBeforeInterval = titleEl.textContent || '';
            titleEl.innerHTML = '<i class="fa fa-magic" aria-hidden="true"></i> Generate time slots';
        }

        els.panel.dataset.targetType = targetType === 'day' ? 'day' : 'week';
        els.panel.dataset.targetDay = getSelectedDay() || 'monday';

        // Prefill from current slots if present.
        const currentSlots = (targetType === 'day'
            ? (getDaySlots() || [])
            : ((getWeekSlots()?.[getSelectedDay()] || [])));
        const withTimes = currentSlots
            .filter((s) => s && s.start && s.end && s.start < s.end)
            .slice()
            .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
        if (els.start) els.start.value = withTimes[0]?.start || '';
        if (els.end) els.end.value = withTimes[withTimes.length - 1]?.end || '';
        // No predefined/default numeric values; user must input explicitly.
        if (els.interval) els.interval.value = '';
        if (els.idle) els.idle.value = '';
        if (els.skipList) els.skipList.innerHTML = '';

        clearIntervalError();
        mainView.classList.add('is-hidden');
        els.panel.classList.remove('is-hidden');
        els.panel.setAttribute('aria-hidden', 'false');
        mainFooter?.classList.add('is-hidden');
        intervalFooter?.classList.remove('is-hidden');
        intervalFooter?.setAttribute('aria-hidden', 'false');
        setTimeout(() => els.start?.focus?.(), 80);
    }

    function closeGenerateIntervalModal() {
        const els = getIntervalEls();
        const modal = $('template-modal');
        const mainView = $('template-modal-main-view');
        const mainFooter = $('template-modal-footer-main');
        const intervalFooter = $('template-modal-footer-interval');
        const titleEl = $('template-modal-title');
        const wasIntervalVisible = !!(els.panel && !els.panel.classList.contains('is-hidden'));
        clearIntervalError();
        if (els.panel) {
            els.panel.classList.add('is-hidden');
            els.panel.setAttribute('aria-hidden', 'true');
        }
        mainView?.classList.remove('is-hidden');
        mainFooter?.classList.remove('is-hidden');
        intervalFooter?.classList.add('is-hidden');
        intervalFooter?.setAttribute('aria-hidden', 'true');
        if (wasIntervalVisible && titleEl && modal?.dataset?.titleBeforeInterval != null) {
            titleEl.textContent = modal.dataset.titleBeforeInterval;
            delete modal.dataset.titleBeforeInterval;
        }
    }

    function readSkipRangesMinutes() {
        const { skipList } = getIntervalEls();
        const ranges = [];
        skipList?.querySelectorAll('.template-interval-skip-row').forEach((row) => {
            const s = row.querySelector('.template-interval-skip-start')?.value || '';
            const e = row.querySelector('.template-interval-skip-end')?.value || '';
            if (!s && !e) return;
            const sm = parseTimeToMinutes(s);
            const em = parseTimeToMinutes(e);
            ranges.push({ start: sm, end: em });
        });
        return ranges;
    }

    function generateIntervalSlots() {
        const els = getIntervalEls();
        const panel = els.panel;
        if (!panel) return;

        clearIntervalError();

        const startStr = els.start?.value || '';
        const endStr = els.end?.value || '';
        const intervalMin = Number(els.interval?.value);
        const idleMin = Number(els.idle?.value);
        const rangeStartMin = parseTimeToMinutes(startStr);
        const rangeEndMin = parseTimeToMinutes(endStr);

        if (rangeStartMin == null || rangeEndMin == null) {
            showIntervalError('Please select a valid start and end time.');
            return;
        }
        if (rangeStartMin >= rangeEndMin) {
            showIntervalError('Time range start must be before end.');
            return;
        }
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            showIntervalError('Consultation interval must be at least 1 minute.');
            return;
        }
        if (!Number.isFinite(idleMin) || idleMin < 0) {
            showIntervalError('Idle time must be 0 or more minutes.');
            return;
        }

        const rawSkips = readSkipRangesMinutes();
        for (const r of rawSkips) {
            if (r.start == null || r.end == null) {
                showIntervalError('Skip ranges must have valid start and end times.');
                return;
            }
            if (r.start >= r.end) {
                showIntervalError('Each skip range start must be before end.');
                return;
            }
        }

        const generated = generateSlotsFromInterval(
            rangeStartMin,
            rangeEndMin,
            Math.floor(intervalMin),
            Math.floor(idleMin),
            rawSkips,
        );
        if (!generated.length) {
            showIntervalError('No slots generated. Adjust the range/interval/skip settings.');
            return;
        }

        const targetType = panel.dataset.targetType || 'week';
        const targetDay = panel.dataset.targetDay || getSelectedDay() || 'monday';
        const newSlots = generated.map((s) => ({ start: s.start, end: s.end }));

        if (targetType === 'day') {
            setDaySlots(newSlots);
            renderDaySlots();
        } else {
            const weekSlots = getWeekSlots();
            if (!weekSlots[targetDay]) weekSlots[targetDay] = [];
            weekSlots[targetDay] = newSlots;
            renderWeekSlots();
        }

        closeGenerateIntervalModal();
        showToast(`Generated ${generated.length} slot(s).`);
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
        const st = slot?.status || 'available';
        const isProtectedSlot = isEditDay && (st === 'booked' || st === 'ongoing' || st === 'completed');
        const disabled = isProtectedSlot ? ' disabled' : '';
        const iconTitle = st === 'completed' ? 'Completed' : st === 'ongoing' ? 'Ongoing' : 'Booked';
        const protectAria = st === 'completed'
            ? 'Completed consultations cannot be removed'
            : st === 'ongoing'
            ? 'Ongoing appointments cannot be removed'
            : 'Booked slots cannot be removed';
        const statusIcon = isProtectedSlot
            ? `<span class="template-slot-status-icon template-slot-status-booked" title="${iconTitle}"><i class="fa fa-calendar-check-o" aria-hidden="true"></i></span>`
            : '<span class="template-slot-status-icon" aria-hidden="true"></span>';
        const deleteBtnHtml = isProtectedSlot
            ? `<button type="button" class="template-slot-delete" data-slot-index="${idx}" disabled aria-label="${protectAria}"><i class="fa fa-trash-o" aria-hidden="true"></i></button>`
            : `<button type="button" class="template-slot-delete" data-slot-index="${idx}" aria-label="Delete slot"><i class="fa fa-trash-o" aria-hidden="true"></i></button>`;
        const row = document.createElement('div');
        row.className = 'template-slot-row' + (isProtectedSlot ? ' template-slot-row-booked' : '');
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
        if (!isProtectedSlot && deleteBtn) deleteBtn.addEventListener('click', () => { slotsArray.splice(idx, 1); onRemove(); });
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

    function showTemplateError(msg) {
        const weekId = 'template-week-error-msg';
        const dayId = 'template-day-error-msg';
        const activeId = getTemplateType() === 'day' ? dayId : weekId;
        const inactiveId = getTemplateType() === 'day' ? weekId : dayId;
        setErrorEl(inactiveId, '', true);
        setErrorEl(activeId, msg, false);
    }

    function hideTemplateError() {
        setErrorEl('template-week-error-msg', '', true);
        setErrorEl('template-day-error-msg', '', true);
    }

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
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'template-day-item' + (getSelectedDay() === day ? ' selected' : '');
            btn.setAttribute('aria-label', DAY_LABELS[day]);
            btn.setAttribute('aria-pressed', String(getSelectedDay() === day));
            btn.innerHTML = `<span>${DAY_LABELS[day]}</span>`;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                syncSlotsFromInputs();
                setSelectedDay(day);
                renderDaysList();
                renderWeekSlots();
                populateCopySourceSelect();
            });
            list.appendChild(btn);
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
        closeGenerateIntervalModal();
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

    function closeModal() {
        closeGenerateIntervalModal();
        setEditingTemplateId(null);
        setModalVisible('template-modal-overlay', 'template-modal', false);
    }

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

    function closeApplyPreviewModal() {
        setModalVisible('apply-preview-overlay', 'apply-preview-modal', false);
        setErrorEl('apply-preview-error', '', true);
        // Return to apply modal so vet can adjust dates quickly.
        setModalVisible('apply-modal-overlay', 'apply-modal', true);
    }

    function formatPreviewDate(dateStr) {
        if (!dateStr) return '—';
        return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
            month: 'long',
            day: 'numeric',
        });
    }

    function formatPreviewWeekday(dateStr) {
        if (!dateStr) return '—';
        return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'long',
        });
    }

    function renderApplyPreviewList(previewDays) {
        const list = $('apply-preview-list');
        if (!list) return;
        list.innerHTML = '';
        (previewDays || []).forEach((d) => {
            const wrap = document.createElement('div');
            wrap.className = 'apply-preview-day';
            const slots = (d.slots || []);
            const slotsHtml = slots
                .map((s) => `<div class="apply-preview-slot"><i class="fa fa-clock-o" aria-hidden="true"></i> ${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}</div>`)
                .join('');
            const note = d.mode === 'replace'
                ? '<p class="apply-preview-note"><i class="fa fa-refresh" aria-hidden="true"></i> This day will be replaced.</p>'
                : '';
            wrap.innerHTML = `
                <p class="apply-preview-date">${escapeHtml(formatPreviewDate(d.dateStr))}</p>
                <p class="apply-preview-weekday">${escapeHtml(formatPreviewWeekday(d.dateStr))}</p>
                <div class="apply-preview-slots">${slotsHtml || '<span class="apply-preview-note">No slots.</span>'}</div>
                ${note}
            `;
            list.appendChild(wrap);
        });
    }

    async function buildApplyPreview(template, startDate, endDate, options = {}) {
        const user = auth.currentUser;
        if (!user) throw new Error('Not signed in');
        const start = parseLocalDate(startDate);
        const end = parseLocalDate(endDate);
        if (start > end) throw new Error('Start date must be before or equal to end date');

        const overlaps = (a, b) => (a?.start || '') < (b?.end || '') && (b?.start || '') < (a?.end || '');

        const today = getTodayDateString();
        const replaceDates = new Set(options.replaceDates || []);
        const skipDates = new Set(options.skipDates || []);
        const minAdvance = getMinAdvanceMinutes();

        const preview = [];
        const current = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            if (dateStr < today) { current.setDate(current.getDate() + 1); continue; }
            if (skipDates.has(dateStr)) { current.setDate(current.getDate() + 1); continue; }

            const existingDoc = await getDoc(scheduleDoc(user.uid, dateStr));
            if (existingDoc.exists() && existingDoc.data().blocked === true) { current.setDate(current.getDate() + 1); continue; }

            const newSlots = getSlotsForDateFromTemplate(template, current, minAdvance, true);
            if (!newSlots.length) { current.setDate(current.getDate() + 1); continue; }

            const existingSlots = (existingDoc.exists() ? (existingDoc.data().slots || []) : []).map((s) => ensureSlotExpiry(s, dateStr));
            const conflict = getConflictCase(existingSlots, newSlots);

            // NOTE: Case 3 (booked overlap) is handled before preview (we never show preview then).
            let mode = 'add';
            let addedSlots = [];
            if (replaceDates.has(dateStr)) {
                mode = 'replace';
                addedSlots = newSlots;
            } else if (conflict.case === 1 && existingSlots.length > 0) {
                // Merge only adds non-overlapping template slots.
                addedSlots = (newSlots || []).filter((n) => !(existingSlots || []).some((e) => overlaps(e, n)));
            } else {
                addedSlots = newSlots;
            }

            if (addedSlots.length) {
                preview.push({
                    dateStr,
                    mode,
                    slots: addedSlots
                        .map((s) => ({ start: s.start, end: s.end }))
                        .filter((s) => s.start && s.end && s.start < s.end)
                        .sort((a, b) => (a.start || '').localeCompare(b.start || '')),
                });
            }

            current.setDate(current.getDate() + 1);
        }

        return preview;
    }

    function openApplyPreviewModal(template, startVal, endVal, replaceDates, skipDates, previewDays) {
        const overlay = $('apply-preview-overlay');
        if (!overlay) return;
        overlay.dataset.templateJson = JSON.stringify(template);
        overlay.dataset.startVal = startVal;
        overlay.dataset.endVal = endVal;
        overlay.dataset.replaceDatesJson = JSON.stringify(replaceDates || []);
        overlay.dataset.skipDatesJson = JSON.stringify(skipDates || []);
        renderApplyPreviewList(previewDays || []);
        setErrorEl('apply-preview-error', '', true);
        setModalVisible('apply-modal-overlay', 'apply-modal', false);
        setModalVisible('apply-preview-overlay', 'apply-preview-modal', true);
        setTimeout(() => $('apply-preview-confirm-btn')?.focus?.(), 80);
    }

    async function openApplyPreviewForOptions(template, startVal, endVal, replaceDates, skipDates) {
        const errEl = $('apply-error-msg');
        try {
            const preview = await buildApplyPreview(template, startVal, endVal, { replaceDates, skipDates });
            if (!preview.length) {
                if (errEl) {
                    errEl.textContent = 'No available slots would be created for this date range (blocked dates and minimum advance may skip all slots).';
                    errEl.classList.remove('is-hidden');
                }
                return;
            }
            openApplyPreviewModal(template, startVal, endVal, replaceDates, skipDates, preview);
        } catch (e) {
            if (errEl) {
                errEl.textContent = e?.message || 'Failed to build preview.';
                errEl.classList.remove('is-hidden');
            }
        }
    }

    function getApplyPreviewOverlayData() {
        const o = $('apply-preview-overlay');
        const { templateJson, startVal, endVal, replaceDatesJson, skipDatesJson } = o?.dataset || {};
        if (!templateJson || !startVal || !endVal) return null;
        return {
            template: JSON.parse(templateJson),
            startVal,
            endVal,
            replaceDates: replaceDatesJson ? JSON.parse(replaceDatesJson) : [],
            skipDates: skipDatesJson ? JSON.parse(skipDatesJson) : [],
        };
    }

    async function confirmApplyPreview() {
        const d = getApplyPreviewOverlayData();
        if (!d) return;
        const confirmBtn = $('apply-preview-confirm-btn');
        const backBtn = $('apply-preview-back-btn');
        if (confirmBtn) confirmBtn.disabled = true;
        if (backBtn) backBtn.disabled = true;
        try {
            // Close preview first so user sees immediate progress feedback/toast, and we avoid double-submit.
            setModalVisible('apply-preview-overlay', 'apply-preview-modal', false);
            await executeApplyWithOptions(d.template, d.startVal, d.endVal, d.replaceDates, d.skipDates);
        } finally {
            if (confirmBtn) confirmBtn.disabled = false;
            if (backBtn) backBtn.disabled = false;
        }
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
            setModalVisible('apply-preview-overlay', 'apply-preview-modal', false);
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
            // No conflicts: show preview first, then apply on confirm.
            await openApplyPreviewForOptions(template, startVal, endVal, [], []);
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
    async function onConflictReplace() {
        const d = getConflictOverlayData();
        if (!d) return;
        // Replacement decision shown first; then preview + confirm.
        setModalVisible('conflict-modal-overlay', 'conflict-modal', false);
        await openApplyPreviewForOptions(d.template, d.startVal, d.endVal, d.case2, []);
    }
    async function onConflictCancel() {
        const d = getConflictOverlayData();
        if (!d) return;
        // Skip conflicting days; then preview + confirm.
        setModalVisible('conflict-modal-overlay', 'conflict-modal', false);
        await openApplyPreviewForOptions(d.template, d.startVal, d.endVal, [], d.case2);
    }

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
            // Require at least one valid slot somewhere in the week.
            const hasAnyValidSlot = DAYS.some((day) => (weekSlots[day] || []).some((s) => s.start && s.end && s.start < s.end));
            if (!hasAnyValidSlot) { showTemplateError('Week template must have at least one time slot.'); return; }
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

    async function deleteTemplate(template, loadTemplates) {
        if (!(await appConfirm(`Delete template "${template.name || 'Unnamed'}"? This cannot be undone.`, { confirmText: 'Yes', cancelText: 'No' }))) return;
        const user = auth.currentUser;
        if (!user) return;
        deleteDoc(templateDoc(user.uid, template.id))
            .then(() => { showToast('Template deleted.'); loadTemplates(); })
            .catch((err) => { console.error('Delete template error:', err); showToast('Failed to delete template.'); });
    }

    return {
        initWeekSlots, openModal, closeModal, openViewModal, closeViewModal,
        openTemplateActionModal, closeTemplateActionModal, openApplyModal, closeApplyModal,
        openApplyPreviewModal, closeApplyPreviewModal, confirmApplyPreview,
        showConflictModal, closeConflictModal, executeApplyWithOptions, doApplyTemplate, getConflictOverlayData, onConflictReplace, onConflictCancel,
        analyzeConflictForDateRange, applyTemplateToDateRange,
        createSlotRow, renderSlotsList, renderWeekSlots, renderDaySlots, addSlotRow,
        openGenerateIntervalModal, closeGenerateIntervalModal, addGenerateIntervalSkipRow, generateIntervalSlots,
        toggleWeekDaySections, syncTemplateTypeUI, renderDaysList,
        populateCopySourceSelect, populateCopyFromTemplateSelect, bindTemplateCopyDropdowns,
        copyFromSourceWeek, copyFromTemplate, syncSlotsFromInputs, validateSlots, getSlotsForSave,
        showToast,
        validateAndSave,
        deleteTemplate: (t, loadTemplates) => deleteTemplate(t, loadTemplates),
    };
}
