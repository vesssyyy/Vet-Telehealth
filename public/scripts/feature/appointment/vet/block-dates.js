export function createBlockDatesApi(ctx) {
    const {
        $, auth, escapeHtml, scheduleDoc, setDoc, deleteDoc, toLocalDateString, formatDisplayDate,
        ensureSchedulesLoaded, setModalVisible, showToast, invalidateSchedulesCache,
        loadBlockedDatesView, loadSchedulesView, loadWeeklyScheduleView,
        getBlockCalendarMonth, setBlockCalendarMonth,
        getBlockSelectedDates, setBlockSelectedDates,
        getBlockPreviouslyBlocked, setBlockPreviouslyBlocked
    } = ctx;

    function getBlockCalendarMonthLabel(date) {
        return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    function renderBlockCalendar() {
        const grid = $('block-calendar-grid');
        const titleEl = $('block-calendar-month-year');
        const blockCalendarMonth = getBlockCalendarMonth();
        if (!grid || !blockCalendarMonth) return;
        titleEl.textContent = getBlockCalendarMonthLabel(blockCalendarMonth);
        const year = blockCalendarMonth.getFullYear();
        const month = blockCalendarMonth.getMonth();
        const first = new Date(year, month, 1);
        const startWeekday = first.getDay();
        const dayCells = [];
        for (let i = 1 - startWeekday; dayCells.length < 42; i++) {
            const d = new Date(year, month, i);
            dayCells.push({ dateStr: toLocalDateString(d), dayNum: d.getDate(), otherMonth: d.getMonth() !== month });
        }
        const dayBtn = (dateStr, dayNum, otherMonth) => {
            const selected = getBlockSelectedDates().has(dateStr);
            const cls = 'block-calendar-day' + (otherMonth ? ' other-month' : '') + (selected ? ' selected' : '');
            return `<button type="button" class="${cls}" data-date="${escapeHtml(dateStr)}" aria-label="${escapeHtml(dateStr)}${selected ? ' (blocked)' : ''}" aria-pressed="${selected}"><span class="block-calendar-day-inner"><span class="block-calendar-day-num">${dayNum}</span>${selected ? '<i class="fa fa-check block-calendar-day-check" aria-hidden="true"></i>' : ''}</span></button>`;
        };
        grid.innerHTML = dayCells.map((c) => dayBtn(c.dateStr, c.dayNum, c.otherMonth)).join('');
        grid.querySelectorAll('.block-calendar-day').forEach((btn) => {
            btn.addEventListener('click', () => {
                const dateStr = btn.getAttribute('data-date');
                if (!dateStr) return;
                const selectedDates = getBlockSelectedDates();
                selectedDates.has(dateStr) ? selectedDates.delete(dateStr) : selectedDates.add(dateStr);
                const selected = selectedDates.has(dateStr);
                btn.classList.toggle('selected', selected);
                btn.setAttribute('aria-pressed', selected);
                const inner = btn.querySelector('.block-calendar-day-inner');
                const check = inner?.querySelector('.block-calendar-day-check');
                if (selected && !check && inner) inner.appendChild(Object.assign(document.createElement('i'), { className: 'fa fa-check block-calendar-day-check', ariaHidden: 'true' }));
                else if (!selected && check) check.remove();
            });
        });
    }

    const blockCalendarPrevMonth = () => { if (getBlockCalendarMonth()) { const m = getBlockCalendarMonth(); setBlockCalendarMonth(new Date(m.getFullYear(), m.getMonth() - 1, 1)); renderBlockCalendar(); } };
    const blockCalendarNextMonth = () => { if (getBlockCalendarMonth()) { const m = getBlockCalendarMonth(); setBlockCalendarMonth(new Date(m.getFullYear(), m.getMonth() + 1, 1)); renderBlockCalendar(); } };

    async function openBlockModal() {
        const errEl = $('block-error-msg');
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        const all = await ensureSchedulesLoaded();
        const blocked = all.filter((s) => s.blocked === true);
        setBlockSelectedDates(new Set(blocked.map((s) => s.date || s.id || '').filter(Boolean)));
        setBlockPreviouslyBlocked(new Set(getBlockSelectedDates()));
        const now = new Date();
        setBlockCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
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
            const toAdd = [...getBlockSelectedDates()];
            const toRemove = [...getBlockPreviouslyBlocked()].filter((d) => !getBlockSelectedDates().has(d));
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

    return { getBlockCalendarMonthLabel, renderBlockCalendar, openBlockModal, closeBlockModal, doBlockDates, unblockDate };
}

export function registerBlockDatesEvents(ctx) {
    const { $, onOverlayClick, openBlockModal, closeBlockModal, doBlockDates } = ctx;

    $('block-dates-btn')?.addEventListener('click', openBlockModal);
    $('block-modal-close')?.addEventListener('click', closeBlockModal);
    $('block-cancel-btn')?.addEventListener('click', closeBlockModal);
    onOverlayClick('block-modal-overlay', closeBlockModal);
    $('block-submit-btn')?.addEventListener('click', doBlockDates);
}
