import { appAlertError, appConfirm } from '../../../core/ui/app-dialog.js';

export function registerModalEvents(ctx) {
    const {
        $, onOverlayClick, detailsApi, editDayApi, currentDetailsAptRef,
        downloadConsultationReportForAppointment, editDaySlotsRef
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
        window.location.href = `messages.html?${params.toString()}`;
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

    /* Details media lightbox (click to enlarge, no new tab) */
    (function initDetailsMediaLightbox() {
        const lb = $('details-media-lightbox');
        const lbImg = lb?.querySelector('.details-media-lightbox-img');
        const lbIframe = lb?.querySelector('.details-media-lightbox-iframe');
        const closeBtn = lb?.querySelector('.details-media-lightbox-close');
        const backdrop = lb?.querySelector('.details-media-lightbox-backdrop');
        const listEl = $('details-shared-images-list');

    const closeLB = () => {
        if (!lb) return;
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = (detailsApi.detailsOverlay()?.classList.contains('is-open') ? 'hidden' : '');
        setTimeout(() => {
            if (lbImg) { lbImg.src = ''; lbImg.classList.remove('is-hidden'); }
            if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
        }, 280);
    };
        const openLB = (url, isImage) => {
            if (!lb) return;
            if (isImage) {
                if (lbImg) {
                    lbImg.style.opacity = '0';
                    lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
                    lbImg.src = url;
                    lbImg.classList.remove('is-hidden');
                }
                if (lbIframe) { lbIframe.src = ''; lbIframe.classList.add('is-hidden'); }
            } else {
                if (lbIframe) { lbIframe.src = url; lbIframe.classList.remove('is-hidden'); }
                if (lbImg) { lbImg.src = ''; lbImg.classList.add('is-hidden'); }
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
            const btn = e.target.closest('.details-shared-image-link, .details-shared-file-link');
            if (!btn?.dataset?.url) return;
            e.preventDefault();
            openLB(btn.dataset.url, btn.dataset.isImage === 'true');
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
            detailsApi.openSlotDetailsModal((viewDetailsBtn.dataset.appointmentId || '').trim(), slotData);
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
        if (ownerNameEl) ownerNameEl.textContent = apt.ownerName || apt.owner || '—';
        if (ownerImg) { ownerImg.style.display = 'none'; ownerImg.src = ''; ownerImg.style.opacity = ''; ownerImg.alt = apt.ownerName || 'Owner'; }
        if (ownerFallback) ownerFallback.classList.add('visible');
        if (apt.ownerId) {
            getDoc(doc(db, 'users', apt.ownerId)).then((ownerSnap) => {
                if (ownerSnap.exists() && ownerSnap.data()?.photoURL && ownerImg) {
                    ownerImg.style.opacity = '0';
                    ownerImg.style.transition = 'opacity 0.35s ease';
                    ownerImg.onload = () => {
                        requestAnimationFrame(() => { ownerImg.style.opacity = '1'; });
                        if (ownerFallback) ownerFallback.classList.remove('visible');
                    };
                    ownerImg.src = ownerSnap.data().photoURL;
                    ownerImg.style.display = '';
                }
            }).catch(() => {});
        }

        const sp = (apt.petSpecies || '').trim();
        const petName = apt.petName || '—';
        const speciesDisplay = sp ? sp.charAt(0).toUpperCase() + sp.slice(1).toLowerCase() : '—';
        if (petNameEl) petNameEl.textContent = petName;
        if (petSpeciesEl) petSpeciesEl.textContent = speciesDisplay;
        if (petAgeEl) petAgeEl.textContent = '—';
        if (petWeightEl) petWeightEl.textContent = '—';
        if (petImg) {
            petImg.style.display = 'none';
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
                            if (petFallback) petFallback.classList.remove('visible');
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

        const placeholderEl = $('details-shared-images-placeholder');
        const listEl = $('details-shared-images-list');
        const mediaUrls = apt.mediaUrls && Array.isArray(apt.mediaUrls) ? apt.mediaUrls : [];
        if (placeholderEl) placeholderEl.classList.toggle('is-hidden', mediaUrls.length > 0);
        if (listEl) {
            listEl.classList.toggle('is-hidden', mediaUrls.length === 0);
            listEl.innerHTML = '';
            mediaUrls.forEach((url, idx) => {
                const isPdf = /\.pdf(\?|$)/i.test(url) || (typeof url === 'string' && url.toLowerCase().includes('pdf'));
                const isImage = !isPdf;
                const item = document.createElement('div');
                item.className = 'details-shared-image-item';
                if (isImage) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'details-shared-image-link';
                    btn.dataset.url = url;
                    btn.dataset.isImage = 'true';
                    const img = document.createElement('img');
                    img.alt = `Shared image ${idx + 1}`;
                    img.className = 'details-shared-image-thumb';
                    img.loading = 'lazy';
                    img.onload = () => img.classList.add('is-loaded');
                    img.src = url;
                    btn.appendChild(img);
                    item.appendChild(btn);
                } else {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'details-shared-file-link';
                    btn.dataset.url = url;
                    btn.dataset.isImage = 'false';
                    btn.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> View document ' + (idx + 1);
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
                            fillDetailsModalFromApt(resolved);
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
                                fillDetailsModalFromApt(resolved);
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
            fillDetailsModalFromApt(apt);
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
        getMinAdvanceMinutes, formatMinutesForDisplay,
        MIN_ADVANCE_MIN, MIN_ADVANCE_MAX_MINUTES,
        saveVetSettings, invalidateSchedulesCache, recalcExpiryForFutureSlots,
        scheduleNextExpiryRerender, getCachedSchedules,
        getGridViewActive, loadWeeklyScheduleView, loadSchedulesView, loadBlockedDatesView,
        showToast
    } = ctx;

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

    async function closeBookingSettingsModal(discardConfirm = false) {
        const inputMins = getMinAdvanceFromInputs();
        const savedMins = getMinAdvanceMinutes();
        const hasChanges = inputMins !== null && inputMins !== savedMins;
        if (discardConfirm && hasChanges && !(await appConfirm('Discard unsaved changes?', { confirmText: 'Yes', cancelText: 'No' }))) return;
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
            await closeBookingSettingsModal();
            return;
        }
        const label = formatMinutesForDisplay(val);
        if (!(await appConfirm(`Save booking setting to "${label}"? Slots within this window will be deleted from your schedule and cannot be booked.`, { confirmText: 'Yes', cancelText: 'No' }))) return;
        const saveBtn = $('booking-settings-save-btn');
        const errEl = $('booking-settings-error');
        if (saveBtn) saveBtn.disabled = true;
        if (errEl) { errEl.textContent = ''; errEl.classList.add('is-hidden'); }
        try {
            await saveVetSettings(val);
            await closeBookingSettingsModal();
            updateCurrentAdvanceDisplay();
            invalidateSchedulesCache();
            await recalcExpiryForFutureSlots();
            scheduleNextExpiryRerender(getCachedSchedules());
            if (getGridViewActive()) loadWeeklyScheduleView();
            else loadSchedulesView();
            loadBlockedDatesView();
            showToast(`Booking setting saved. Minimum advance is now ${label}.`);
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
        updateCurrentAdvanceDisplay,
        openBookingSettingsModal,
        closeBookingSettingsModal,
        bindBookingSettingsEvents,
    };
}
