import { appAlertError, appConfirm } from '../../../core/ui/app-dialog.js';
import { getAppointmentSharedMediaKind } from '../../../core/app/appointment-media-kind.js';
import { escapeHtml, formatDisplayName } from '../../../core/app/utils.js';
import { buildDetailsAttachedSkinAnalysisHtml, wireDetailsAttachedSkinThumbnails } from '../shared/details-attached-skin-html.js';
import { enrichAppointmentAttachedSkinFromHistory } from '../../skin-disease/skin-analysis-repository.js';
import { markAppointmentNotificationsSeen } from '../../../core/notifications/appointment-notifications.js';

export function registerModalEvents(ctx) {
    const {
        $, onOverlayClick, detailsApi, editDayApi, currentDetailsAptRef,
        downloadConsultationReportForAppointment, editDaySlotsRef,
        auth, db, collection, query, where, getDocs,
        formatDisplayDate, formatTime12h,
    } = ctx;

    $('details-modal-close')?.addEventListener('click', detailsApi.closeSlotDetailsModal);
    onOverlayClick('details-modal-overlay', detailsApi.closeSlotDetailsModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && detailsApi.detailsOverlay()?.classList.contains('is-open')) detailsApi.closeSlotDetailsModal();
    });
    $('details-message-btn')?.addEventListener('click', () => {
        const currentDetailsApt = currentDetailsAptRef();
        const ownerId = currentDetailsApt?.ownerId || currentDetailsApt?.ownerID || '';
        const petId = currentDetailsApt?.petId || currentDetailsApt?.petID || '';
        if (!ownerId || !petId) return;
        detailsApi.closeSlotDetailsModal();
        const params = new URLSearchParams({ ownerId, petId });
        if (currentDetailsApt?.id) params.set('appointmentId', currentDetailsApt.id);
        if (currentDetailsApt?.ownerName) params.set('ownerName', currentDetailsApt.ownerName);
        if (currentDetailsApt?.petName) params.set('petName', currentDetailsApt.petName);
        const messagesUrl = `messages.html?${params.toString()}`;
        if (!window.__spaNavigate || !window.__spaNavigate(messagesUrl)) window.location.href = messagesUrl;
    });
    $('details-download-pdf-btn')?.addEventListener('click', () => {
        const currentDetailsApt = currentDetailsAptRef();
        if (!currentDetailsApt?.id) return;
        downloadConsultationReportForAppointment(currentDetailsApt.id, $('details-download-pdf-btn'));
    });
    $('details-join-btn')?.addEventListener('click', () => {
        const currentDetailsApt = currentDetailsAptRef();
        if (!currentDetailsApt || $('details-join-btn')?.disabled) return;
        window.location.href = `video-call.html?appointmentId=${currentDetailsApt.id}`;
    });

    // Past records modal
    (function initPastRecordsModal() {
        const overlayId = 'past-records-overlay';
        const modalId = 'past-records-modal';
        const overlayEl = () => $(overlayId);
        const modalEl = () => $(modalId);

        const setPastRecordsVisible = (visible) => {
            const overlay = overlayEl();
            const modal = modalEl();
            const hidden = !visible;
            if (!visible && overlay && document.activeElement && overlay.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            if (overlay) {
                overlay.classList.toggle('is-hidden', hidden);
                overlay.setAttribute('aria-hidden', String(hidden));
            }
            if (modal) {
                modal.classList.toggle('is-hidden', hidden);
                modal.setAttribute('aria-hidden', String(hidden));
                if (visible) modal.focus();
            }
            document.body.style.overflow = visible ? 'hidden' : (detailsApi.detailsOverlay()?.classList.contains('is-open') ? 'hidden' : '');
        };

        const close = () => setPastRecordsVisible(false);

        $('past-records-close')?.addEventListener('click', close);
        onOverlayClick(overlayId, close);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modalEl()?.classList.contains('is-hidden')) {
                close();
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

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

        function isCompletedAppointment(apt) {
            const st = String(apt?.status || '').toLowerCase();
            return st === 'completed';
        }

        function timeDisplayForRow(apt) {
            const dateStr = String(apt?.dateStr || apt?.date || '').trim();
            const timeDisplay = String(apt?.timeDisplay || '').trim();
            if (timeDisplay) {
                // `timeDisplay` often already contains a human-friendly date+time string
                // (e.g. "Apr 13, 2026 at 5:35 PM - 5:45 PM"). Avoid duplicating date labels.
                return timeDisplay.replace(/\s*[–—]\s*/g, ' - ');
            }
            if (apt?.slotStart && apt?.slotEnd) {
                const datePart = dateStr
                    ? new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                    : '';
                return [datePart, `at ${formatTime12h(apt.slotStart)} - ${formatTime12h(apt.slotEnd)}`].filter(Boolean).join(' ');
            }
            if (apt?.slotStart) {
                const datePart = dateStr
                    ? new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                    : '';
                return [datePart, `at ${formatTime12h(apt.slotStart)}`].filter(Boolean).join(' ');
            }
            return dateStr ? formatDisplayDate(dateStr) : '—';
        }

        async function loadAndRender() {
            const subtitleEl = $('past-records-subtitle');
            const emptyEl = $('past-records-empty');
            const tbody = $('past-records-table-body');
            const tableWrap = $('past-records-table-wrap');
            const btn = $('details-past-records-btn');
            if (tbody) tbody.innerHTML = '';
            if (emptyEl) emptyEl.classList.add('is-hidden');
            if (tableWrap) tableWrap.classList.remove('is-hidden');

            const prevBtnHtml = btn?.innerHTML;
            const setBtnBusy = (busy) => {
                if (!btn) return;
                btn.disabled = busy;
                if (busy) btn.innerHTML = '<i class="fa fa-spinner fa-spin" aria-hidden="true"></i> Loading…';
                else if (prevBtnHtml != null) btn.innerHTML = prevBtnHtml;
            };

            try {
                setBtnBusy(true);
                if (subtitleEl) subtitleEl.textContent = 'Loading…';
                const current = currentDetailsAptRef?.() || null;
                const ownerId = String(current?.ownerId || current?.ownerID || '').trim();
                const petId = String(current?.petId || current?.petID || '').trim();
                const petName = String(current?.petName || '').trim();
                const currentAppointmentId = String(current?.id || '').trim();

                if (subtitleEl) subtitleEl.textContent = petName ? `Pet: ${formatDisplayName(petName)}` : 'Pet: —';
                if (!ownerId || !petId) {
                    if (emptyEl) emptyEl.classList.remove('is-hidden');
                    if (tableWrap) tableWrap.classList.add('is-hidden');
                    return;
                }

                if (!auth?.currentUser) {
                    if (emptyEl) emptyEl.classList.remove('is-hidden');
                    if (tableWrap) tableWrap.classList.add('is-hidden');
                    return;
                }

                // IMPORTANT: query must only target docs vets are allowed to read.
                // If we query all owner appointments, Firestore will reject the query because it could include non-completed docs.
                const q = query(
                    collection(db, 'appointments'),
                    where('ownerId', '==', ownerId),
                    where('status', '==', 'completed'),
                );
                const snap = await getDocs(q);
                const appts = snap.docs
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter((a) => String(a.petId || a.petID || '').trim() === petId)
                    .filter((a) => String(a.id || '').trim() !== currentAppointmentId);

                appts.sort((a, b) => {
                    const aMs = appointmentCreatedAtFieldToMs(a.createdAt);
                    const bMs = appointmentCreatedAtFieldToMs(b.createdAt);
                    if (aMs !== bMs) return (bMs || 0) - (aMs || 0);
                    const ad = String(a.dateStr || a.date || '');
                    const bd = String(b.dateStr || b.date || '');
                    if (ad !== bd) return bd.localeCompare(ad);
                    const at = String(a.slotStart || '');
                    const bt = String(b.slotStart || '');
                    return bt.localeCompare(at);
                });

                if (!tbody) return;
                if (!appts.length) {
                    if (emptyEl) emptyEl.classList.remove('is-hidden');
                    if (tableWrap) tableWrap.classList.add('is-hidden');
                    return;
                }

                appts.forEach((apt) => {
                    const tr = document.createElement('tr');
                    const title = String((apt.title || '').trim() || (apt.reason || '').trim() || 'Consultation');
                    const vet = String((apt.vetName || apt.vet || '').trim() || '—');
                    const dt = timeDisplayForRow(apt);

                    const downloadBtn = document.createElement('button');
                    downloadBtn.type = 'button';
                    downloadBtn.className = 'past-records-download-btn';
                    downloadBtn.setAttribute('aria-label', 'Download consultation PDF');
                    downloadBtn.innerHTML = '<i class="fa fa-arrow-down" aria-hidden="true"></i>';
                    downloadBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!apt.id) return;
                        downloadConsultationReportForAppointment(apt.id, downloadBtn);
                    });

                    tr.innerHTML = `
                        <td class="past-records-td-title">${escapeHtml(title)}</td>
                        <td class="past-records-td-vet">${escapeHtml(vet)}</td>
                        <td class="past-records-td-datetime">${escapeHtml(dt)}</td>
                    `;
                    const tdDl = document.createElement('td');
                    tdDl.className = 'past-records-td-download';
                    tdDl.appendChild(downloadBtn);
                    tr.appendChild(tdDl);
                    tbody.appendChild(tr);
                });
            } catch (err) {
                console.error('Past records load failed:', err);
                if (subtitleEl) subtitleEl.textContent = 'Past records';
                await appAlertError('Could not load past records. Please try again.');
            } finally {
                setBtnBusy(false);
            }
        }

        $('details-past-records-btn')?.addEventListener('click', async () => {
            setPastRecordsVisible(true);
            await loadAndRender();
        });
    })();

    // Details media lightbox (click to enlarge, no new tab)
    (function initDetailsMediaLightbox() {
        const lb = $('details-media-lightbox');
        const lbImg = lb?.querySelector('.details-media-lightbox-img');
        const lbVideo = lb?.querySelector('.details-media-lightbox-video');
        const lbIframe = lb?.querySelector('.details-media-lightbox-iframe');
        const closeBtn = lb?.querySelector('.details-media-lightbox-close');
        const backdrop = lb?.querySelector('.details-media-lightbox-backdrop');
        const listEl = $('details-shared-images-list');

    const closeLB = () => {
        if (!lb) return;
        if (lbVideo) {
            lbVideo.pause();
            lbVideo.removeAttribute('src');
            lbVideo.load?.();
        }
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = (detailsApi.detailsOverlay()?.classList.contains('is-open') ? 'hidden' : '');
        setTimeout(() => {
            if (lbImg) { lbImg.src = ''; lbImg.classList.remove('is-hidden'); }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
            if (lbVideo) { lbVideo.classList.add('is-hidden'); }
        }, 280);
    };
        const openLB = (url, kind) => {
            if (!lb) return;
            if (lbVideo) {
                lbVideo.pause();
                lbVideo.removeAttribute('src');
            }
            if (kind === 'image') {
                if (lbImg) {
                    lbImg.style.opacity = '0';
                    lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
                    lbImg.src = url;
                    lbImg.classList.remove('is-hidden');
                }
                if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
                if (lbVideo) { lbVideo.classList.add('is-hidden'); }
            } else if (kind === 'video') {
                if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
                if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
                if (lbVideo) {
                    lbVideo.autoplay = false;
                    lbVideo.removeAttribute('autoplay');
                    lbVideo.src = url;
                    lbVideo.classList.remove('is-hidden');
                    try { lbVideo.load(); } catch (_) {}
                    lbVideo.pause();
                    lbVideo.addEventListener('loadedmetadata', () => {
                        lbVideo.pause();
                        try { lbVideo.currentTime = 0; } catch (_) {}
                    }, { once: true });
                }
            } else {
                if (lbIframe) { lbIframe.src = url; lbIframe.classList.remove('is-hidden'); }
                if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
                if (lbVideo) { lbVideo.classList.add('is-hidden'); }
            }
            lb.classList.remove('is-hidden');
            lb.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        };

        closeBtn?.addEventListener('click', closeLB);
        backdrop?.addEventListener('click', closeLB);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) {
                closeLB();
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        listEl?.addEventListener('click', (e) => {
            const btn = e.target.closest('.details-shared-image-link, .details-shared-file-link, .details-shared-video-link');
            if (!btn?.dataset?.url) return;
            e.preventDefault();
            const kind = btn.dataset.mediaKind || (btn.dataset.isImage === 'true' ? 'image' : 'pdf');
            openLB(btn.dataset.url, kind);
        });
        const skinInner = $('details-attached-skin-inner');
        skinInner?.addEventListener('click', (e) => {
            const thumbBtn = e.target.closest('.details-attached-skin-img-btn');
            const url = thumbBtn?.dataset?.skinFullImageUrl || thumbBtn?.querySelector('.details-attached-skin-thumb')?.src;
            if (!url) return;
            e.preventDefault();
            openLB(url, 'image');
        });
    })();

    $('edit-day-modal-close')?.addEventListener('click', editDayApi.closeEditDayModal);
    $('edit-day-cancel-btn')?.addEventListener('click', editDayApi.closeEditDayModal);
    onOverlayClick('edit-day-modal-overlay', editDayApi.closeEditDayModal);
    $('edit-day-save-btn')?.addEventListener('click', editDayApi.saveEditDay);
    $('edit-day-add-slot-btn')?.addEventListener('click', () => {
        editDaySlotsRef().push({ start: '', end: '', status: 'available' });
        editDayApi.renderEditDaySlots();
    });

    $('schedules-list')?.addEventListener('click', (e) => {
        const viewDetailsBtn = e.target.closest('.slot-details-view-btn');
        if (viewDetailsBtn) {
            const row = viewDetailsBtn.closest('.schedules-slot-item--booked');
            const slotData = row ? {
                dateStr: row.dataset.date || '',
                ownerId: row.dataset.ownerId || '',
                petId: row.dataset.petId || '',
                vetId: row.dataset.vetId || '',
                ownerName: row.dataset.ownerName || '',
                petName: row.dataset.petName || '',
                reason: row.dataset.reason || '',
                timeStart: row.dataset.timeStart || '',
                timeEnd: row.dataset.timeEnd || '',
            } : null;
            const aptId = (viewDetailsBtn.dataset.appointmentId || '').trim();
            if (aptId) markAppointmentNotificationsSeen(aptId).catch(() => {});
            detailsApi.openSlotDetailsModal(aptId, slotData);
            return;
        }
        const editBtn = e.target.closest('.schedules-edit-day-btn');
        if (editBtn?.dataset?.date) editDayApi.openEditDayModal(editBtn.dataset.date);
    });
}

export function createEditDayApi(ctx) {
    const {
        $, auth, scheduleDoc, getDoc, deleteDoc, setDoc,
        formatDisplayDate, setModalVisible, renderSlotsList, validateSlots, setErrorEl,
        getMinAdvanceMinutes, ensureSlotExpiry, isSlotExpired, isSlotPastCutoff, formatMinutesForDisplay,
        showToast, invalidateSchedulesCache, loadSchedulesView, loadWeeklyScheduleView,
        getEditDayDateStr, setEditDayDateStr, getEditDaySlots, setEditDaySlots
    } = ctx;

    function renderEditDaySlots() {
        renderSlotsList('edit-day-slots-list', getEditDaySlots(), renderEditDaySlots, true);
    }

    function syncEditDaySlotsFromInputs() {
        const list = $('edit-day-slots-list');
        list?.querySelectorAll('input[type="time"]').forEach((inp) => {
            const idx = parseInt(inp.getAttribute('data-slot-index'), 10);
            const field = inp.getAttribute('data-slot-field');
            const slots = getEditDaySlots();
            if (!isNaN(idx) && slots[idx]) slots[idx][field] = inp.value || '';
        });
    }

    async function openEditDayModal(dateStr) {
        const user = auth.currentUser;
        if (!user || !dateStr) return;
        setEditDayDateStr(dateStr);
        const snap = await getDoc(scheduleDoc(user.uid, dateStr));
        const data = snap.exists() ? snap.data() : {};
        if (data.blocked === true) return;
        let slots = (data.slots || []).map((s) => ({ start: s.start || '', end: s.end || '', status: s.status || 'available' }));
        if (slots.length === 0) slots = [{ start: '', end: '', status: 'available' }];
        setEditDaySlots(slots);

        $('edit-day-date-display').textContent = formatDisplayDate(dateStr);
        $('edit-day-error-msg').textContent = '';
        $('edit-day-error-msg').classList.add('is-hidden');
        renderEditDaySlots();
        setModalVisible('edit-day-modal-overlay', 'edit-day-modal', true);
        setTimeout(() => $('edit-day-add-slot-btn')?.focus(), 100);
    }

    function closeEditDayModal() {
        setEditDayDateStr(null);
        setEditDaySlots([]);
        setModalVisible('edit-day-modal-overlay', 'edit-day-modal', false);
    }

    const showEditDayError = (msg) => setErrorEl('edit-day-error-msg', msg, false);

    function validateEditDaySlots() {
        syncEditDaySlotsFromInputs();
        return validateSlots(getEditDaySlots());
    }

    async function saveEditDay() {
        const user = auth.currentUser;
        const editDayDateStr = getEditDayDateStr();
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
            const st = s.status || 'available';
            if (st === 'booked' || st === 'ongoing' || st === 'completed') return true;
            return !isSlotExpired(s, Date.now()) && !isSlotPastCutoff(editDayDateStr, s.start, minAdvance);
        });
        const removedCount = beforeCount - slotsToSave.length;
        if (slotsToSave.length === 0) {
            if (removedCount > 0) {
                showEditDayError(`All slots are within the minimum advance (${formatMinutesForDisplay(minAdvance)}) or in the past. Add slots that are at least ${formatMinutesForDisplay(minAdvance)} from now.`);
                return;
            }
            if (!(await appConfirm('Remove all slots for this date? The date will be removed from your schedule.', { confirmText: 'Yes', cancelText: 'No' }))) return;
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

    return { renderEditDaySlots, openEditDayModal, closeEditDayModal, saveEditDay };
}

export function createDetailsApi(ctx) {
    const {
        $, auth, db, doc, getDoc, appointmentDoc,
        formatDisplayDate, formatTime12h,
        getJoinAvailableLabel, isConsultationPdfAvailable, canRejoinVideoConsultation, isVideoJoinClosed,
        setCurrentDetailsApt, resolveAppointmentFromSlotData
    } = ctx;
    const setCurrent = (apt) => {
        if (typeof setCurrentDetailsApt === 'function') setCurrentDetailsApt(apt || null);
    };


    let detailsJoinCheckTimer = null;

    const detailsOverlay = () => $('details-modal-overlay');
    const detailsModalEl = () => $('details-modal');

    function setDetailsModalVisible(visible) {
        const overlay = detailsOverlay();
        const modal = detailsModalEl();
        if (!visible && overlay && document.activeElement && overlay.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        if (overlay) {
            overlay.classList.toggle('is-open', visible);
            overlay.setAttribute('aria-hidden', String(!visible));
        }
        document.body.style.overflow = visible ? 'hidden' : '';
        if (visible && modal) modal.focus();
    }

    function updateDetailsJoinButton(apt, videoCall) {
        const joinBtn = $('details-join-btn');
        const pdfBtn = $('details-download-pdf-btn');
        if (pdfBtn && apt) {
            const showPdf = isConsultationPdfAvailable(apt, videoCall);
            pdfBtn.classList.toggle('is-hidden', !showPdf);
            pdfBtn.toggleAttribute('hidden', !showPdf);
        }
        if (!joinBtn || !apt) return;
        const closed = isVideoJoinClosed(apt, videoCall);
        const canJoin = canRejoinVideoConsultation(apt, videoCall);
        joinBtn.disabled = !canJoin;
        joinBtn.setAttribute('aria-disabled', joinBtn.disabled ? 'true' : 'false');
        const label = getJoinAvailableLabel(apt, videoCall);
        joinBtn.title = label;
        joinBtn.innerHTML = `<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">${label}</span>`;
        joinBtn.classList.toggle('is-past', closed);
        joinBtn.classList.toggle('is-session-ended', closed);
    }

    function closeSlotDetailsModal() {
        if (detailsJoinCheckTimer) {
            clearInterval(detailsJoinCheckTimer);
            detailsJoinCheckTimer = null;
        }
        setDetailsModalVisible(false);
    }

    function formatPetAge(age) {
        if (age == null || age === '') return '—';
        const n = Number(age);
        return isNaN(n) ? String(age) : n === 1 ? '1 Year' : n + ' Years';
    }

    function formatPetWeight(weight) {
        if (weight == null || weight === '') return '—';
        const n = Number(weight);
        return isNaN(n) ? String(weight) : n + ' kg';
    }

    function fillDetailsModalFromApt(apt) {
        setCurrent(apt || null);
        const titleEl = $('details-title');
        const ownerNameEl = $('details-owner-name');
        const ownerImg = $('details-owner-img');
        const ownerFallback = $('details-owner-avatar-fallback');
        const petNameEl = $('details-pet-name');
        const petAgeEl = $('details-pet-age');
        const petWeightEl = $('details-pet-weight');
        const petSpeciesEl = $('details-pet-species');
        const petImg = $('details-pet-img');
        const petFallback = $('details-pet-avatar-fallback');
        const petWrap = $('details-pet-avatar-wrap');
        const dateEl = $('details-date');
        const timeEl = $('details-time');
        const concernEl = $('details-concern');
        const idEl = $('details-appointment-id');

        if (titleEl) {
            titleEl.textContent = (apt.title && apt.title.trim()) ? apt.title.trim() : '—';
            titleEl.classList.toggle('is-empty', !(apt.title && apt.title.trim()));
        }
        const ownerDisplay = (apt.ownerName || apt.owner || '').toString().trim();
        if (ownerNameEl) ownerNameEl.textContent = ownerDisplay ? formatDisplayName(ownerDisplay) : '—';
        if (ownerImg) {
            ownerImg.style.display = 'none';
            ownerImg.setAttribute('aria-hidden', 'true');
            ownerImg.src = '';
            ownerImg.style.opacity = '';
            ownerImg.alt = ownerDisplay ? formatDisplayName(ownerDisplay) : 'Owner';
        }
        if (ownerFallback) ownerFallback.classList.add('visible');
        if (apt.ownerId) {
            getDoc(doc(db, 'users', apt.ownerId)).then((ownerSnap) => {
                if (ownerSnap.exists() && ownerSnap.data()?.photoURL && ownerImg) {
                    ownerImg.style.opacity = '0';
                    ownerImg.style.transition = 'opacity 0.35s ease';
                    ownerImg.onload = () => {
                        requestAnimationFrame(() => { ownerImg.style.opacity = '1'; });
                        ownerImg.setAttribute('aria-hidden', 'false');
                        if (ownerFallback) ownerFallback.classList.remove('visible');
                    };
                    ownerImg.onerror = () => {
                        ownerImg.setAttribute('aria-hidden', 'true');
                        ownerImg.style.display = 'none';
                        if (ownerFallback) ownerFallback.classList.add('visible');
                    };
                    ownerImg.src = ownerSnap.data().photoURL;
                    ownerImg.style.display = '';
                }
            }).catch(() => {});
        }

        const sp = (apt.petSpecies || '').trim();
        const petNameRaw = (apt.petName || '').toString().trim();
        const petName = petNameRaw ? formatDisplayName(petNameRaw) : '—';
        const speciesDisplay = sp ? sp.charAt(0).toUpperCase() + sp.slice(1).toLowerCase() : '—';
        if (petNameEl) petNameEl.textContent = petName;
        if (petSpeciesEl) petSpeciesEl.textContent = speciesDisplay;
        if (petAgeEl) petAgeEl.textContent = '—';
        if (petWeightEl) petWeightEl.textContent = '—';
        if (petImg) {
            petImg.style.display = 'none';
            petImg.setAttribute('aria-hidden', 'true');
            petImg.src = '';
            petImg.style.opacity = '';
            petImg.alt = petName !== '—' ? String(petName) : 'Pet';
        }
        if (petFallback) {
            petFallback.classList.add('visible');
            petFallback.setAttribute('aria-hidden', 'false');
            petFallback.innerHTML = (sp || '').toLowerCase() === 'cat' ? '<i class="fa-solid fa-cat" aria-hidden="true"></i>' : '<i class="fa fa-paw" aria-hidden="true"></i>';
        }
        if (petWrap) petWrap.classList.toggle('details-pet-avatar-wrap--cat', (sp || '').toLowerCase() === 'cat');
        if (apt.ownerId && apt.petId) {
            getDoc(doc(db, 'users', apt.ownerId, 'pets', apt.petId)).then((petSnap) => {
                if (petSnap.exists()) {
                    const pet = petSnap.data();
                    if (petAgeEl) petAgeEl.textContent = formatPetAge(pet.age);
                    if (petWeightEl) petWeightEl.textContent = formatPetWeight(pet.weight);
                    const pSp = (pet.species || apt.petSpecies || '').trim();
                    if (petSpeciesEl) petSpeciesEl.textContent = pSp ? pSp.charAt(0).toUpperCase() + pSp.slice(1).toLowerCase() : '—';
                    if (pet.imageUrl && petImg) {
                        petImg.style.opacity = '0';
                        petImg.style.transition = 'opacity 0.35s ease';
                        petImg.onload = () => {
                            requestAnimationFrame(() => { petImg.style.opacity = '1'; });
                            petImg.setAttribute('aria-hidden', 'false');
                            if (petFallback) petFallback.classList.remove('visible');
                        };
                        petImg.onerror = () => {
                            petImg.setAttribute('aria-hidden', 'true');
                            petImg.style.display = 'none';
                            if (petFallback) petFallback.classList.add('visible');
                        };
                        petImg.src = pet.imageUrl;
                        petImg.style.display = '';
                    }
                    if (petFallback && (pet.species || '').toLowerCase() === 'cat') petFallback.innerHTML = '<i class="fa-solid fa-cat" aria-hidden="true"></i>';
                }
            }).catch(() => {});
        }

        if (dateEl) dateEl.textContent = apt.dateStr ? formatDisplayDate(apt.dateStr) : (apt.date ? formatDisplayDate(apt.date) : '—');
        if (timeEl) {
            let timeOnly = '—';
            if (apt.slotStart && apt.slotEnd) timeOnly = `${formatTime12h(apt.slotStart)} – ${formatTime12h(apt.slotEnd)}`;
            else if (apt.slotStart) timeOnly = formatTime12h(apt.slotStart);
            else if (apt.timeDisplay) {
                const s = String(apt.timeDisplay).trim();
                const atIdx = s.lastIndexOf(' at ');
                timeOnly = atIdx !== -1 ? s.slice(atIdx + 4).replace(/\s*[–—]\s*/g, ' – ') : s;
            }
            timeEl.textContent = timeOnly;
        }
        if (concernEl) concernEl.textContent = (apt.reason && apt.reason.trim()) ? apt.reason.trim() : '—';
        if (idEl) idEl.textContent = apt.id || '—';

        const skinWrap = $('details-attached-skin');
        const skinInner = $('details-attached-skin-inner');
        if (skinWrap && skinInner) {
            const s = apt.attachedSkinAnalysis;
            if (s && s.imageUrl) {
                skinWrap.classList.remove('is-hidden');
                skinInner.innerHTML = buildDetailsAttachedSkinAnalysisHtml(s);
                wireDetailsAttachedSkinThumbnails(skinInner);
            } else {
                skinWrap.classList.add('is-hidden');
                skinInner.innerHTML = '';
            }
        }

        const placeholderEl = $('details-shared-images-placeholder');
        const listEl = $('details-shared-images-list');
        const mediaUrls = apt.mediaUrls && Array.isArray(apt.mediaUrls) ? apt.mediaUrls : [];
        if (placeholderEl) placeholderEl.classList.toggle('is-hidden', mediaUrls.length > 0);
        if (listEl) {
            listEl.classList.toggle('is-hidden', mediaUrls.length === 0);
            listEl.innerHTML = '';
            mediaUrls.forEach((url, idx) => {
                const kind = getAppointmentSharedMediaKind(url);
                const item = document.createElement('div');
                item.className = 'details-shared-image-item';
                if (kind === 'pdf') {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'details-shared-file-link';
                    btn.dataset.url = url;
                    btn.dataset.mediaKind = 'pdf';
                    btn.dataset.isImage = 'false';
                    btn.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> View document ' + (idx + 1);
                    item.appendChild(btn);
                } else if (kind === 'video') {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'details-shared-video-link';
                    btn.dataset.url = url;
                    btn.dataset.mediaKind = 'video';
                    const vid = document.createElement('video');
                    vid.className = 'details-shared-video-thumb';
                    vid.muted = true;
                    vid.playsInline = true;
                    vid.setAttribute('playsinline', '');
                    vid.preload = 'metadata';
                    vid.autoplay = false;
                    vid.setAttribute('aria-label', `Shared video ${idx + 1}`);
                    vid.src = url;
                    const onThumbReady = () => {
                        vid.pause();
                        try { vid.currentTime = 0; } catch (_) {}
                        vid.classList.add('is-loaded');
                    };
                    vid.addEventListener('loadeddata', onThumbReady, { once: true });
                    const badge = document.createElement('span');
                    badge.className = 'details-shared-video-play-badge';
                    badge.setAttribute('aria-hidden', 'true');
                    badge.innerHTML = '<i class="fa fa-play-circle"></i>';
                    btn.appendChild(vid);
                    btn.appendChild(badge);
                    item.appendChild(btn);
                } else {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'details-shared-image-link';
                    btn.dataset.url = url;
                    btn.dataset.mediaKind = 'image';
                    btn.dataset.isImage = 'true';
                    const img = document.createElement('img');
                    img.alt = `Shared image ${idx + 1}`;
                    img.className = 'details-shared-image-thumb';
                    img.loading = 'lazy';
                    img.onload = () => img.classList.add('is-loaded');
                    img.src = url;
                    btn.appendChild(img);
                    item.appendChild(btn);
                }
                listEl.appendChild(item);
            });
        }
        const joinBtn = $('details-join-btn');
        const pdfBtn = $('details-download-pdf-btn');
        if (pdfBtn) {
            pdfBtn.classList.add('is-hidden');
            pdfBtn.setAttribute('hidden', '');
        }
        if (joinBtn) {
            joinBtn.classList.add('is-loading-video-status');
            joinBtn.disabled = true;
            joinBtn.setAttribute('aria-disabled', 'true');
            joinBtn.title = 'Checking call status…';
            joinBtn.innerHTML = '<i class="fa fa-video-camera" aria-hidden="true"></i><span class="details-join-btn-text">Loading…</span>';
            joinBtn.classList.add('is-past');
        }
        getDoc(doc(db, 'appointments', apt.id, 'videoCall', 'room')).then((videoSnap) => {
            joinBtn?.classList.remove('is-loading-video-status');
            updateDetailsJoinButton(apt, videoSnap.exists() ? videoSnap.data() : null);
        }).catch(() => {
            joinBtn?.classList.remove('is-loading-video-status');
            updateDetailsJoinButton(apt, null);
        });
        if (detailsJoinCheckTimer) clearInterval(detailsJoinCheckTimer);
        detailsJoinCheckTimer = setInterval(() => {
            if (detailsOverlay()?.classList.contains('is-open')) {
                getDoc(doc(db, 'appointments', apt.id, 'videoCall', 'room')).then((videoSnap) => {
                    updateDetailsJoinButton(apt, videoSnap.exists() ? videoSnap.data() : null);
                }).catch(() => updateDetailsJoinButton(apt, null));
            }
        }, 30000);
    }

    function fillDetailsModalFromSlotData(appointmentId, slotData) {
        const timeDisplay = (slotData.timeStart && slotData.timeEnd)
            ? `${formatTime12h(slotData.timeStart)} – ${formatTime12h(slotData.timeEnd)}`
            : '—';
        fillDetailsModalFromApt({
            id: appointmentId,
            title: null,
            ownerId: slotData.ownerId || '',
            petId: slotData.petId || '',
            vetId: slotData.vetId || auth.currentUser?.uid || '',
            ownerName: slotData.ownerName || '—',
            owner: slotData.ownerName || '—',
            petName: slotData.petName || '—',
            petSpecies: '',
            reason: slotData.reason || '—',
            dateStr: slotData.dateStr,
            date: slotData.dateStr,
            slotStart: slotData.timeStart,
            slotEnd: slotData.timeEnd,
            timeDisplay,
        });
    }

    async function openSlotDetailsModal(appointmentId, slotDataFromRow) {
        const aptId = String(appointmentId || '').trim();
        if (!aptId) {
            if (slotDataFromRow) {
                if (typeof resolveAppointmentFromSlotData === 'function') {
                    try {
                        const resolved = await resolveAppointmentFromSlotData(slotDataFromRow);
                        if (resolved) {
                            fillDetailsModalFromApt(await enrichAppointmentAttachedSkinFromHistory(resolved));
                            setDetailsModalVisible(true);
                            return;
                        }
                    } catch (err) {
                        console.warn('Resolve appointment from slot data failed:', err);
                    }
                }
                fillDetailsModalFromSlotData('—', slotDataFromRow);
                setDetailsModalVisible(true);
            }
            return;
        }
        const overlay = detailsOverlay();
        const modal = detailsModalEl();
        if (!overlay || !modal) return;
        try {
            const snap = await getDoc(appointmentDoc(aptId));
            if (!snap.exists()) {
                if (slotDataFromRow) {
                    if (typeof resolveAppointmentFromSlotData === 'function') {
                        try {
                            const resolved = await resolveAppointmentFromSlotData(slotDataFromRow);
                            if (resolved) {
                                fillDetailsModalFromApt(await enrichAppointmentAttachedSkinFromHistory(resolved));
                                setDetailsModalVisible(true);
                                return;
                            }
                        } catch (err) {
                            console.warn('Resolve appointment from slot data failed:', err);
                        }
                    }
                    fillDetailsModalFromSlotData(aptId, slotDataFromRow);
                    setDetailsModalVisible(true);
                } else {
                    await appAlertError('Appointment not found.');
                }
                return;
            }
            const apt = { id: snap.id, ...snap.data() };
            fillDetailsModalFromApt(await enrichAppointmentAttachedSkinFromHistory(apt));
            setDetailsModalVisible(true);
        } catch (err) {
            console.error('Load appointment error:', err);
            if (slotDataFromRow) {
                fillDetailsModalFromSlotData(aptId, slotDataFromRow);
                setDetailsModalVisible(true);
            } else {
                await appAlertError('Could not load appointment details. Please try again.');
            }
        }
    }

    return {
        detailsOverlay,
        setDetailsModalVisible,
        updateDetailsJoinButton,
        closeSlotDetailsModal,
        fillDetailsModalFromApt: (apt) => fillDetailsModalFromApt(apt),
        fillDetailsModalFromSlotData: (appointmentId, slotData) => fillDetailsModalFromSlotData(appointmentId, slotData),
        openSlotDetailsModal: (appointmentId, slotDataFromRow) => openSlotDetailsModal(appointmentId, slotDataFromRow),
    };
}

export function createBookingSettingsApi(ctx) {
    const {
        $, setModalVisible, onOverlayClick,
        getMinAdvanceMinutes,
        getConsultationPriceCentavosTest,
        getConsultationPriceCentavosLive,
        formatMinutesForDisplay,
        MIN_ADVANCE_MIN, MIN_ADVANCE_MAX_MINUTES,
        MIN_CONSULTATION_PRICE_CENTAVOS_LIVE,
        MIN_CONSULTATION_PRICE_CENTAVOS_TEST,
        saveVetSettings, invalidateSchedulesCache, recalcExpiryForFutureSlots,
        scheduleNextExpiryRerender, getCachedSchedules,
        getGridViewActive, loadWeeklyScheduleView, loadSchedulesView, loadBlockedDatesView,
        showToast
    } = ctx;

    function formatPhpFromCentavos(centavos) {
        const n = Math.floor(Number(centavos) || 0);
        return `PHP ${(n / 100).toFixed(2)}`;
    }

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

    function parsePhpInputToCentavos(id) {
        const inp = $(id);
        if (!inp) return null;
        const raw = String(inp.value || '').trim().replace(/,/g, '');
        const php = parseFloat(raw);
        if (!Number.isFinite(php) || php <= 0) return null;
        const centavos = Math.round(php * 100);
        if (!Number.isFinite(centavos) || centavos < 1) return null;
        return centavos;
    }

    function updateConsultationPriceInputs() {
        const testInp = $('consultation-price-test-php');
        const liveInp = $('consultation-price-live-php');
        if (testInp) testInp.value = (getConsultationPriceCentavosTest() / 100).toFixed(2);
        if (liveInp) liveInp.value = (getConsultationPriceCentavosLive() / 100).toFixed(2);
    }

    function updateCurrentConsultationFeeDisplay() {
        const el = $('schedules-current-fee');
        if (el) {
            el.textContent = `Testing (card) ${formatPhpFromCentavos(getConsultationPriceCentavosTest())} · Live (QRPh) ${formatPhpFromCentavos(getConsultationPriceCentavosLive())}`;
        }
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
        updateConsultationPriceInputs();
        syncMinAdvanceInputAttrs();
        $('booking-settings-error')?.classList.add('is-hidden');
        setModalVisible('booking-settings-overlay', 'booking-settings-modal', true);
        setTimeout(() => $('min-advance-value')?.focus(), 100);
    }

    async function closeBookingSettingsModal(discardConfirm = false) {
        const inputMins = getMinAdvanceFromInputs();
        const savedMins = getMinAdvanceMinutes();
        const inputTest = parsePhpInputToCentavos('consultation-price-test-php');
        const inputLive = parsePhpInputToCentavos('consultation-price-live-php');
        const savedTest = getConsultationPriceCentavosTest();
        const savedLive = getConsultationPriceCentavosLive();
        const advanceChanged = inputMins !== null && inputMins !== savedMins;
        const testChanged = inputTest !== null && inputTest !== savedTest;
        const liveChanged = inputLive !== null && inputLive !== savedLive;
        if (discardConfirm && (advanceChanged || testChanged || liveChanged) && !(await appConfirm('Discard unsaved changes?', { confirmText: 'Yes', cancelText: 'No' }))) return;
        updateMinAdvanceInputs();
        updateConsultationPriceInputs();
        setModalVisible('booking-settings-overlay', 'booking-settings-modal', false);
    }

    async function doSaveBookingSettings() {
        const val = getMinAdvanceFromInputs();
        const priceTest = parsePhpInputToCentavos('consultation-price-test-php');
        const priceLive = parsePhpInputToCentavos('consultation-price-live-php');
        const errEl = $('booking-settings-error');
        if (val === null) {
            if (errEl) {
                errEl.textContent = `Enter a value between ${MIN_ADVANCE_MIN} and ${MIN_ADVANCE_MAX_MINUTES} minutes (or 0.01–24 hours).`;
                errEl.classList.remove('is-hidden');
            }
            return;
        }
        if (priceTest === null || priceLive === null) {
            if (errEl) {
                errEl.textContent = 'Enter valid PHP amounts for both Testing (card) and Live (QRPh).';
                errEl.classList.remove('is-hidden');
            }
            return;
        }
        if (priceTest < MIN_CONSULTATION_PRICE_CENTAVOS_TEST) {
            if (errEl) {
                errEl.textContent = `Testing (card) minimum is ${formatPhpFromCentavos(MIN_CONSULTATION_PRICE_CENTAVOS_TEST)}.`;
                errEl.classList.remove('is-hidden');
            }
            return;
        }
        if (priceLive < MIN_CONSULTATION_PRICE_CENTAVOS_LIVE) {
            if (errEl) {
                errEl.textContent = `Live (QRPh) minimum is ${formatPhpFromCentavos(MIN_CONSULTATION_PRICE_CENTAVOS_LIVE)}.`;
                errEl.classList.remove('is-hidden');
            }
            return;
        }
        const currentAdvance = getMinAdvanceMinutes();
        const currentTest = getConsultationPriceCentavosTest();
        const currentLive = getConsultationPriceCentavosLive();
        if (val === currentAdvance && priceTest === currentTest && priceLive === currentLive) {
            await closeBookingSettingsModal();
            return;
        }
        const label = formatMinutesForDisplay(val);
        const feeSummary = `Testing (card) ${formatPhpFromCentavos(priceTest)}, Live (QRPh) ${formatPhpFromCentavos(priceLive)}`;
        let confirmMsg;
        const feesChanged = priceTest !== currentTest || priceLive !== currentLive;
        if (val !== currentAdvance && feesChanged) {
            confirmMsg = `Save minimum advance as "${label}" and fees (${feeSummary})? Changing the advance window will remove soon-to-book slots from your schedule.`;
        } else if (val !== currentAdvance) {
            confirmMsg = `Save booking setting to "${label}"? Slots within this window will be deleted from your schedule and cannot be booked.`;
        } else {
            confirmMsg = `Save fees (${feeSummary})?`;
        }
        if (!(await appConfirm(confirmMsg, { confirmText: 'Yes', cancelText: 'No' }))) return;
        const saveBtn = $('booking-settings-save-btn');
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        if (saveBtn) saveBtn.disabled = true;
        try {
            await saveVetSettings({
                minAdvanceBookingMinutes: val,
                consultationPriceCentavosTest: priceTest,
                consultationPriceCentavosLive: priceLive,
            });
            await closeBookingSettingsModal();
            updateCurrentAdvanceDisplay();
            updateCurrentConsultationFeeDisplay();
            if (val !== currentAdvance) {
                invalidateSchedulesCache();
                await recalcExpiryForFutureSlots();
                scheduleNextExpiryRerender(getCachedSchedules());
                if (getGridViewActive()) loadWeeklyScheduleView();
                else loadSchedulesView();
                loadBlockedDatesView();
            }
            const parts = [];
            if (val !== currentAdvance) parts.push(`minimum advance is now ${label}`);
            if (feesChanged) parts.push(feeSummary);
            showToast(parts.length ? `Saved. ${parts.join('; ')}.` : 'Settings saved.');
        } catch (err) {
            if (errEl) { errEl.textContent = err.message || 'Failed to save. Please try again.'; errEl.classList.remove('is-hidden'); }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function bindBookingSettingsEvents() {
        $('min-advance-unit')?.addEventListener('change', syncMinAdvanceInputAttrs);
        $('booking-settings-close')?.addEventListener('click', () => closeBookingSettingsModal(true));
        $('booking-settings-cancel-btn')?.addEventListener('click', () => closeBookingSettingsModal(true));
        onOverlayClick('booking-settings-overlay', () => closeBookingSettingsModal(true));
        $('booking-settings-save-btn')?.addEventListener('click', doSaveBookingSettings);
    }

    return {
        updateMinAdvanceInputs,
        updateConsultationPriceInputs,
        updateCurrentAdvanceDisplay,
        updateCurrentConsultationFeeDisplay,
        openBookingSettingsModal,
        closeBookingSettingsModal,
        bindBookingSettingsEvents,
    };
}
