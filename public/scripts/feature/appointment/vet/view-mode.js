import { appConfirm } from '../../../core/ui/app-dialog.js';
import { formatDisplayName } from '../../../core/app/utils.js';

export function registerViewModeEvents(ctx) {
    const {
        $, getTodayDateString, getWeekRangeForFilter, getActiveSlotFilter,
        loadSchedulesView, loadWeeklyScheduleView,
        getGridViewActive, setGridViewActive,
        openBookingSettingsModal,
        deleteAllExpiredSlots, showToast
    } = ctx;

    function syncGridOptionVisibility() {
        const isExpired = getActiveSlotFilter() === 'expired';
        const gridOpt = $('schedules-view-option-grid');
        if (gridOpt) gridOpt.classList.toggle('is-hidden', isExpired);
    }

    function setScheduleViewMode(isGrid) {
        const scrollY = window.scrollY || document.documentElement.scrollTop;
        setGridViewActive(isGrid);
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
            if (view === 'settings') openBookingSettingsModal();
            else setScheduleViewMode(view === 'grid');
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
        if (getGridViewActive()) loadWeeklyScheduleView();
    });
    $('schedules-week-picker')?.addEventListener('change', () => {
        if (getGridViewActive()) loadWeeklyScheduleView();
    });

    document.querySelectorAll('.schedules-slot-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.schedules-slot-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            const isExpired = btn.dataset.slotFilter === 'expired';
            if (isExpired && getGridViewActive()) setScheduleViewMode(false);
            syncGridOptionVisibility();
            if (getGridViewActive()) loadWeeklyScheduleView();
            else loadSchedulesView();
        });
    });

    $('schedules-delete-all-expired-btn')?.addEventListener('click', async () => {
        if (!(await appConfirm('Permanently delete all expired slot records? This cannot be undone.', { confirmText: 'Yes', cancelText: 'No' }))) return;
        const btn = $('schedules-delete-all-expired-btn');
        if (btn) btn.disabled = true;
        try {
            const count = await deleteAllExpiredSlots();
            showToast(count > 0 ? `${count} expired slot(s) deleted.` : 'No expired slots to delete.');
            document.querySelector('.schedules-slot-btn[data-slot-filter="expired"]')?.classList.remove('active');
            $('schedules-slot-all')?.classList.add('active');
            $('schedules-expired-actions')?.classList.add('is-hidden');
            if (getGridViewActive()) loadWeeklyScheduleView();
            else loadSchedulesView();
        } catch (e) {
            showToast(e.message || 'Failed to delete expired slots.');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    return { syncGridOptionVisibility };
}

export function createViewRenderingApi(ctx) {
    const {
        $, auth, escapeHtml,
        formatDisplayDate, formatTime12h, formatTimeRangeCompact, parseTimeParts,
        WEEK_START_HOUR, WEEK_END_HOUR, HOUR_HEIGHT, WEEKDAY_LABELS,
        slotEffectiveStatus, dedupeSlots, ensureSlotExpiry, isSlotExpired, getMinAdvanceMinutes,
        ensureSchedulesLoaded, enrichSchedulesWithAppointmentStatus, filterSchedules, getActiveSlotFilter,
        toLocalDateString, getTodayDateString, getGridViewActive, openSlotDetailsModal, openEditDayModal
    } = ctx;

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
            const status = slotEffectiveStatus(s);
            const extraClass = isExpired ? ' schedules-slot-item-expired' : '';
            const hasAppointment = status === 'booked' || status === 'ongoing' || status === 'completed';
            if (hasAppointment) {
                const aptId = (s.appointmentId || '').trim();
                const timeRange = `${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}`;
                const oRaw = (s.ownerName || s.owner || '').trim().slice(0, 80);
                const pRaw = (s.petName || s.pet || '').trim().slice(0, 80);
                const ownerName = escapeHtml(oRaw ? formatDisplayName(oRaw) : '');
                const petName = escapeHtml(pRaw ? formatDisplayName(pRaw) : '');
                const reason = escapeHtml((s.reason || '').slice(0, 400));
                const ownerId = escapeHtml(String(s.ownerId || ''));
                const petId = escapeHtml(String(s.petId || ''));
                const vetId = escapeHtml(String(s.vetId || auth.currentUser?.uid || ''));
                return `<div class="schedules-slot-item schedules-slot-item--booked${extraClass}" data-status="${status}" data-date="${escapeHtml(dateStr)}" data-start="${escapeHtml(s.start)}" data-appointment-id="${escapeHtml(aptId)}" data-owner-name="${ownerName}" data-owner-id="${ownerId}" data-pet-name="${petName}" data-pet-id="${petId}" data-vet-id="${vetId}" data-reason="${reason}" data-time-start="${escapeHtml(s.start || '')}" data-time-end="${escapeHtml(s.end || '')}" data-expired="${isExpired}">
                    <span class="schedules-slot-indicator ${status}" aria-hidden="true"></span>
                    <span class="schedules-slot-time schedules-slot-time--left">${timeRange}</span>
                    <button type="button" class="slot-details-view-btn" data-appointment-id="${escapeHtml(aptId)}" aria-label="View appointment details"><i class="fa fa-eye" aria-hidden="true"></i> View Details</button>
                </div>`;
            }
            return `<div class="schedules-slot-item${extraClass}" data-status="${status}" data-date="${escapeHtml(dateStr)}" data-start="${escapeHtml(s.start)}" data-expired="${isExpired}"><span class="schedules-slot-indicator ${status}" aria-hidden="true"></span><span class="schedules-slot-time">${escapeHtml(formatTime12h(s.start))} – ${escapeHtml(formatTime12h(s.end))}</span></div>`;
        };

        const minAdvance = getMinAdvanceMinutes();
        const blocks = nonBlocked.map((sch) => {
            const dateStr = sch.date || sch.id || '';
            const slots = dedupeSlots((sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance)), dateStr);
            const slotsFilteredByExpiry = slots.filter((s) => {
                const status = slotEffectiveStatus(s);
                if (showExpiredView) return isSlotExpired(s, nowMs);
                if (status === 'booked' || status === 'ongoing' || status === 'completed') return true;
                return !isSlotExpired(s, nowMs);
            });
            const filtered = filter === 'available' ? slotsFilteredByExpiry.filter((s) => slotEffectiveStatus(s) === 'available')
                : filter === 'booked' ? slotsFilteredByExpiry.filter((s) => { const st = slotEffectiveStatus(s); return st === 'booked' || st === 'ongoing'; })
                : filter === 'completed' ? slotsFilteredByExpiry.filter((s) => slotEffectiveStatus(s) === 'completed')
                : filter === 'expired' ? slotsFilteredByExpiry.filter((s) => isSlotExpired(s, nowMs))
                : slotsFilteredByExpiry;
            if (!filtered.length) return '';
            const slotHtml = filtered.map((s) => renderSlot(s, dateStr, filter === 'expired')).join('');
            const todayStr = getTodayDateString();
            const isPastCalendarDate = dateStr && todayStr && dateStr < todayStr;
            const showEditDay = filter !== 'booked' && filter !== 'completed' && filter !== 'expired'
                && !(filter === 'all' && isPastCalendarDate);
            const editDayBtn = showEditDay ? `<button type="button" class="schedules-edit-day-btn" data-date="${escapeHtml(dateStr)}" aria-label="Edit this day"><i class="fa fa-pencil" aria-hidden="true"></i> Edit day</button>` : '';
            return `<div class="schedules-date-block" data-date="${escapeHtml(dateStr)}">
                <div class="schedules-schedule-header">
                    <h3 class="schedules-date-title">${escapeHtml(formatDisplayDate(dateStr))}</h3>
                    ${editDayBtn}
                </div>
                <div class="schedules-slot-list">${slotHtml}</div>
            </div>`;
        }).filter(Boolean).join('');

        if (!blocks) {
            wrap.classList.add('is-hidden');
            empty?.classList.remove('is-hidden');
            const p = empty?.querySelector('p');
            const hint = empty?.querySelector('.schedules-view-empty-hint');
            if (p) p.textContent = filter === 'all' ? 'No slots to display' : 'No matching slots';
            if (hint) hint.textContent = filter === 'all'
                ? 'Try a different date filter, or apply a template to generate new slots.'
                : 'Try a different slot filter, or change the date filter to see other schedules.';
            listEl.innerHTML = '';
        } else {
            wrap.classList.remove('is-hidden');
            empty?.classList.add('is-hidden');
            listEl.innerHTML = blocks;
        }
        $('schedules-expired-actions')?.classList.toggle('is-hidden', filter !== 'expired');
    }

    async function loadSchedulesView() {
        const filterMode = $('schedules-filter')?.value || 'all';
        const specificDate = $('schedules-date-picker')?.value || '';
        const slotFilter = getActiveSlotFilter();
        const all = await ensureSchedulesLoaded();
        const filtered = filterSchedules(all, filterMode, specificDate);
        const enriched = await enrichSchedulesWithAppointmentStatus(filtered);
        renderSchedulesView(enriched, slotFilter);
    }

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

        if (!gridEl) return;

        const totalHours = WEEK_END_HOUR - WEEK_START_HOUR;
        const totalRows = totalHours;
        const startFmt = weekRange.startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const endFmt = weekRange.endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

        const filter = slotFilter || 'all';
        const filtered = filter === 'available' ? weekSlots.filter((x) => slotEffectiveStatus(x.slot) === 'available')
            : filter === 'booked' ? weekSlots.filter((x) => { const st = slotEffectiveStatus(x.slot); return st === 'booked' || st === 'ongoing'; })
            : filter === 'completed' ? weekSlots.filter((x) => slotEffectiveStatus(x.slot) === 'completed')
            : filter === 'expired' ? weekSlots.filter((x) => x.isExpired)
            : weekSlots;

        const weekDisplayText = `${startFmt} – ${endFmt}`;
        const weekDisplayEl = $('weekly-schedule-week-display');
        if (weekDisplayEl) weekDisplayEl.textContent = `Viewing week: ${weekDisplayText}`;
        if (labelEl) labelEl.textContent = weekDisplayText;

        const todayStr = getTodayDateString();

        if (getGridViewActive()) {
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
            const status = slotEffectiveStatus(slot);
            const dayIdx = getDateStrDayIndex(dateStr);
            const startMins = parseTimeToMinutes(slot.start);
            const startHour = Math.floor(startMins / 60);
            const minsIntoHour = startMins - (startHour * 60);
            const hourRow = Math.max(0, Math.min(startHour - WEEK_START_HOUR, totalRows - 1));
            const top = minsToPxWithinHour(minsIntoHour);
            const durationPx = timeToDurationPx(slot.start, slot.end);
            const height = Math.max(minsToPxWithinHour(30), durationPx);
            const oSrc = String(slot.ownerName || slot.owner || '').trim();
            const pSrc = String(slot.petName || slot.pet || '').trim();
            const ownerName = oSrc ? formatDisplayName(oSrc) : 'Owner Name';
            const petName = pSrc ? formatDisplayName(pSrc) : 'Pet Name';
            const isPlaceholder = !slot.ownerName && !slot.owner && !slot.petName && !slot.pet;

            const cell = gridEl.querySelector(`.slot-cell[data-day="${dayIdx}"][data-hour="${hourRow}"]`);
            if (!cell) return;

            const extendsBelow = top + height > HOUR_HEIGHT;
            if (extendsBelow) cell.classList.add('has-extending-event');

            const eventEl = document.createElement('div');
            eventEl.className = `weekly-schedule-event status-${status}`;
            eventEl.style.top = `${top}px`;
            eventEl.style.height = `${Math.max(0, height - 2)}px`;
            const hasAppointment = status === 'booked' || status === 'ongoing' || status === 'completed';
            if (hasAppointment) {
                const aptId = (slot.appointmentId || '').trim();
                eventEl.dataset.dateStr = dateStr;
                eventEl.dataset.ownerId = slot.ownerId || '';
                eventEl.dataset.petId = slot.petId || '';
                eventEl.dataset.vetId = slot.vetId || auth.currentUser?.uid || '';
                eventEl.dataset.ownerName = (oSrc ? formatDisplayName(oSrc) : '').slice(0, 80);
                eventEl.dataset.petName = (pSrc ? formatDisplayName(pSrc) : '').slice(0, 80);
                eventEl.dataset.reason = (slot.reason || '').slice(0, 400);
                eventEl.dataset.timeStart = slot.start || '';
                eventEl.dataset.timeEnd = slot.end || '';
                eventEl.setAttribute('role', 'button');
                eventEl.setAttribute('tabindex', '0');
                eventEl.setAttribute('aria-label', `View appointment: ${escapeHtml(petName)} with ${escapeHtml(ownerName)}`);
                eventEl.innerHTML = `
                    <span class="weekly-schedule-event-name ${isPlaceholder ? 'weekly-schedule-event-placeholder' : ''}">${escapeHtml(ownerName)}</span>
                    <span class="weekly-schedule-event-pet ${isPlaceholder ? 'weekly-schedule-event-placeholder' : ''}">${escapeHtml(petName)}</span>
                    <span class="weekly-schedule-event-btn slot-details-view-btn"><i class="fa fa-eye" aria-hidden="true"></i> View details</span>
                `;
                const openDetails = () => {
                    const slotData = {
                        dateStr: eventEl.dataset.dateStr || '',
                        ownerId: eventEl.dataset.ownerId || '',
                        petId: eventEl.dataset.petId || '',
                        vetId: eventEl.dataset.vetId || '',
                        ownerName: eventEl.dataset.ownerName || '',
                        petName: eventEl.dataset.petName || '',
                        reason: eventEl.dataset.reason || '',
                        timeStart: eventEl.dataset.timeStart || '',
                        timeEnd: eventEl.dataset.timeEnd || '',
                    };
                    openSlotDetailsModal(aptId || '', slotData);
                };
                eventEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openDetails();
                });
                eventEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openDetails();
                    }
                });
            } else {
                const slotLabel = status === 'expired' ? 'Expired' : status === 'available' ? 'Available' : status;
                const hideEditPastAll = filter === 'all' && todayStr && dateStr < todayStr;
                const editBtnHtml = hideEditPastAll
                    ? ''
                    : `<button type="button" class="weekly-schedule-event-btn" data-date="${escapeHtml(dateStr)}" aria-label="Edit this day"><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>`;
                eventEl.innerHTML = `
                    <span class="weekly-schedule-event-name">${escapeHtml(slotLabel)}</span>
                    <span class="weekly-schedule-event-pet weekly-schedule-event-time">${escapeHtml(formatTimeRangeCompact(slot.start, slot.end))}</span>
                    ${editBtnHtml}
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
        const enrichedAll = await enrichSchedulesWithAppointmentStatus(all);
        const weekSlots = [];
        const nowMs = Date.now();
        const showExpired = getActiveSlotFilter() === 'expired';
        const minAdvance = getMinAdvanceMinutes();

        const current = new Date(weekRange.startDate);
        const endDay = new Date(weekRange.endDate);
        while (current <= endDay) {
            const dateStr = toLocalDateString(current);
            const sch = enrichedAll.find((s) => (s.date || s.id) === dateStr);
            if (sch && sch.blocked !== true && Array.isArray(sch.slots)) {
                const daySlots = dedupeSlots((sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance)), dateStr);
                daySlots.forEach((slot) => {
                    const slotStatus = slotEffectiveStatus(slot);
                    if (showExpired) {
                        if (slotStatus === 'available' && isSlotExpired(slot, nowMs)) weekSlots.push({ dateStr, slot, isExpired: true });
                    } else {
                        if (slotStatus === 'booked' || slotStatus === 'ongoing' || slotStatus === 'completed') weekSlots.push({ dateStr, slot });
                        else if (!isSlotExpired(slot, nowMs)) weekSlots.push({ dateStr, slot });
                    }
                });
            }
            current.setDate(current.getDate() + 1);
        }

        renderWeeklyScheduleGridFixed(weekSlots, weekRange, slotFilter);
    }

    return { renderSchedulesView, loadSchedulesView, getWeekRangeForFilter, renderWeeklyScheduleGridFixed, loadWeeklyScheduleView };
}
