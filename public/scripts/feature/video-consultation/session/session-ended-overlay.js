import {
    doc,
    getDoc,
    updateDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { escapeHtml } from '../../../core/app/utils.js';
import { generateConsultationPDF } from '../../../core/pdf/consultation-pdf.js';
import {
    CONSULTATION_NOTES_FIELDS,
} from '../utils/notes-fields.js';
import { attachNotesDashTextarea } from '../utils/notes-dash-textarea.js';

/**
 * Full-screen "Session Ended" overlay with optional vet notes + report download.
 */
export async function showSessionEndedOverlay(options = {}) {
    const {
        redirectQuery = '',
        backUrl = '',
        isVet = false,
        startLabel = '—',
        endLabel = '—',
        consultationNotes: notesParam,
        appointmentRef = null,
        appointmentData = null,
        db = null,
        cleanupAndLeaveRoom = null,
    } = options;

    let consultationNotes = notesParam;
    if (isVet && !consultationNotes && appointmentRef) {
        try {
            const snap = await getDoc(appointmentRef);
            consultationNotes = snap.exists() ? snap.data().consultationNotes : null;
        } catch (e) {
            console.warn('Could not fetch consultation notes:', e);
        }
    }

    const notes = consultationNotes && typeof consultationNotes === 'object' ? consultationNotes : {};
    const notesHtml = isVet ? `
        <div class="video-call-session-ended-notes">
            <h3 class="video-call-session-ended-notes-title"><i class="fa fa-file-text-o" aria-hidden="true"></i> Finalize consultation notes</h3>
            <div class="video-call-session-ended-notes-list">
                ${CONSULTATION_NOTES_FIELDS.map(({ key, label, maxLength }) => {
                    const val = (notes[key] || '').trim() || '';
                    return `<div class="video-call-session-ended-notes-row">
                        <label for="session-ended-notes-${key}" class="video-call-session-ended-notes-label">${escapeHtml(label)}</label>
                        <textarea id="session-ended-notes-${key}" class="video-call-session-ended-notes-textarea" rows="2" maxlength="${maxLength}" data-notes-key="${key}" placeholder="—">${escapeHtml(val)}</textarea>
                    </div>`;
                }).join('')}
            </div>
        </div>
    ` : '';

    const overlay = document.createElement('div');
    overlay.className = 'video-call-session-ended-overlay';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-live', 'polite');

    let targetUrl = redirectQuery ? `${backUrl}${backUrl.includes('?') ? '&' : '?'}${redirectQuery.replace(/^\?/, '')}` : backUrl;
    if (!isVet && backUrl.includes('appointment.html')) {
        targetUrl = targetUrl.includes('?') ? `${targetUrl}&tab=history` : `${targetUrl}?tab=history`;
    }

    const buttonText = isVet ? 'Confirm' : 'Go to Appointment History';
    overlay.innerHTML = `
        <div class="video-call-session-ended-card ${isVet ? 'has-notes' : ''}">
            <div class="video-call-session-ended-icon" aria-hidden="true"><i class="fa fa-check-circle" aria-hidden="true"></i></div>
            <h2 class="video-call-session-ended-title">Session Ended</h2>
            <p class="video-call-session-ended-desc">The consultation has ended. You can no longer rejoin this call.</p>
            <div class="video-call-session-ended-times">
                <div class="video-call-session-ended-time-row">
                    <span class="video-call-session-ended-time-label">Started</span>
                    <span class="video-call-session-ended-time-value">${escapeHtml(startLabel)}</span>
                </div>
                <div class="video-call-session-ended-time-row">
                    <span class="video-call-session-ended-time-label">Ended</span>
                    <span class="video-call-session-ended-time-value">${escapeHtml(endLabel)}</span>
                </div>
            </div>
            ${notesHtml}
            <div class="video-call-session-ended-actions" id="session-ended-actions">
                <button type="button" class="video-call-session-ended-btn" id="session-ended-return-btn">${escapeHtml(buttonText)}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const notesListEl = overlay.querySelector('.video-call-session-ended-notes-list');
    function setSessionEndedNotesRowExpanded(rowEl) {
        if (!notesListEl) return;
        notesListEl.querySelectorAll('.video-call-session-ended-notes-row').forEach((r) => {
            r.classList.remove('is-expanded', 'is-collapsed');
            if (r !== rowEl) r.classList.add('is-collapsed');
        });
        if (rowEl) {
            rowEl.classList.add('is-expanded');
            rowEl.classList.remove('is-collapsed');
        }
    }

    const sessionEndedTextareas = overlay.querySelectorAll('.video-call-session-ended-notes-textarea');
    sessionEndedTextareas.forEach((ta) => {
        attachNotesDashTextarea(ta, {
            onFocusExtra: () => setSessionEndedNotesRowExpanded(ta.closest('.video-call-session-ended-notes-row')),
        });
        ta.addEventListener('blur', () => {
            setTimeout(() => {
                const notesSection = overlay.querySelector('.video-call-session-ended-notes');
                if (notesSection && !notesSection.contains(document.activeElement)) {
                    notesListEl?.querySelectorAll('.video-call-session-ended-notes-row').forEach((r) => {
                        r.classList.remove('is-expanded', 'is-collapsed');
                    });
                }
            }, 0);
        });
    });

    const returnBtn = overlay.querySelector('#session-ended-return-btn');
    if (returnBtn) {
        returnBtn.addEventListener('click', async () => {
            if (isVet && appointmentRef) {
                const textareas = overlay.querySelectorAll('.video-call-session-ended-notes-textarea');
                if (textareas.length) {
                    const updatedNotes = {};
                    textareas.forEach((ta) => {
                        const key = ta.dataset.notesKey;
                        if (key) updatedNotes[key] = (ta.value || '').trim();
                    });
                    try {
                        returnBtn.disabled = true;
                        returnBtn.textContent = 'Saving…';
                        await updateDoc(appointmentRef, {
                            consultationNotes: updatedNotes,
                            consultationNotesUpdatedAt: serverTimestamp(),
                        });
                    } catch (e) {
                        console.warn('Could not save final notes:', e);
                    }
                }

                const notesSection = overlay.querySelector('.video-call-session-ended-notes');
                if (notesSection) notesSection.style.display = 'none';
                const actionsEl = overlay.querySelector('#session-ended-actions');
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="video-call-session-ended-btn video-call-session-ended-btn--secondary" id="session-ended-download-report-btn"><i class="fa fa-file-pdf-o" aria-hidden="true"></i> Download Report</button>
                        <button type="button" class="video-call-session-ended-btn" id="session-ended-return-btn-2">Return to Appointment</button>
                    `;
                    const returnBtn2 = actionsEl.querySelector('#session-ended-return-btn-2');
                    if (returnBtn2) returnBtn2.addEventListener('click', () => { window.location.href = targetUrl; });
                    const downloadBtn = actionsEl.querySelector('#session-ended-download-report-btn');
                    if (downloadBtn && appointmentData) {
                        downloadBtn.addEventListener('click', () => {
                            triggerDownloadReport(overlay, appointmentData, startLabel, endLabel, downloadBtn, notes, db);
                        });
                    }
                }
                return;
            }
            window.location.href = targetUrl;
        });
    }

    cleanupAndLeaveRoom?.().catch(() => {});
}

async function triggerDownloadReport(overlayEl, aptData, startLabel, endLabel, btnEl, notes, db) {
    try {
        btnEl.disabled = true;
        btnEl.innerHTML = '<i class="fa fa-spinner fa-spin" aria-hidden="true"></i> Generating…';
        const textareas = overlayEl.querySelectorAll('.video-call-session-ended-notes-textarea');
        const consultationNotes = {};
        if (textareas.length) {
            textareas.forEach((ta) => {
                const key = ta.dataset.notesKey;
                if (key) consultationNotes[key] = (ta.value || '').trim();
            });
        } else {
            Object.assign(consultationNotes, notes);
        }

        const ownerId = aptData.ownerId;
        const vetId = aptData.vetId;
        const petId = aptData.petId;
        let ownerProfile = {};
        let vetProfile = {};
        let petData = {};

        if (ownerId) {
            try {
                const snap = await getDoc(doc(db, 'users', ownerId));
                ownerProfile = snap.exists() ? snap.data() : {};
            } catch (e) {
                console.warn('Could not load owner profile:', e);
            }
        }
        if (vetId) {
            try {
                const snap = await getDoc(doc(db, 'users', vetId));
                vetProfile = snap.exists() ? snap.data() : {};
            } catch (e) {
                console.warn('Could not load vet profile:', e);
            }
        }
        if (ownerId && petId) {
            try {
                const snap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
                petData = snap.exists() ? snap.data() : {};
            } catch (e) {
                console.warn('Could not load pet data:', e);
            }
        }

        const dateTimeStr = [startLabel, endLabel].filter(Boolean).join(' – ')
            || [aptData.dateStr, aptData.timeDisplay].filter(Boolean).join(' · ')
            || '—';
        const blob = await generateConsultationPDF({
            owner: { displayName: aptData.ownerName || ownerProfile.displayName, address: ownerProfile.address, email: aptData.ownerEmail || ownerProfile.email },
            vet: { displayName: aptData.vetName || vetProfile.displayName, clinicName: aptData.clinicName || vetProfile.clinicName || vetProfile.clinic, clinicAddress: vetProfile.clinicAddress || vetProfile.address, clinicEmail: vetProfile.clinicEmail || vetProfile.email, licenseNumber: vetProfile.licenseNumber },
            pet: { name: aptData.petName || petData.name, species: petData.species || aptData.petSpecies, breed: petData.breed, age: petData.age, weight: petData.weight, sex: petData.sex },
            appointment: { title: aptData.title, reason: aptData.reason, dateStr: aptData.dateStr, timeDisplay: aptData.timeDisplay, slotStart: aptData.slotStart, slotEnd: aptData.slotEnd },
            consultationNotes,
            consultationDateTime: dateTimeStr,
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Consultation-Summary-${aptData.petName || 'Pet'}-${new Date().toISOString().slice(0, 10)}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        console.error('PDF generation failed:', e);
        btnEl.innerHTML = '<i class="fa fa-exclamation-triangle" aria-hidden="true"></i> Failed';
    } finally {
        btnEl.disabled = false;
        setTimeout(() => {
            btnEl.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> Download Report';
        }, 2000);
    }
}

