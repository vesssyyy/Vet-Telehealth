import {
    getDoc,
    setDoc,
    updateDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/**
 * Vet-only leave/end modal flow.
 * Caller injects side effects (leaveTemporary, clear signaling, leaveRoom, etc.).
 */
export function showVetLeaveEndModal(options = {}) {
    const {
        userUid,
        appointmentRef,
        appointmentData,
        videoCallRef,
        updateAssignedSlotStatus,
        getNotesFromForm,
        leaveTemporary,
        clearSignaling,
        leaveRoom,
        formatEndLabel,
    } = options;

    const overlay = document.createElement('div');
    overlay.className = 'video-call-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'video-call-leave-end-title');

    const dialog = document.createElement('div');
    dialog.className = 'video-call-leave-end-dialog';
    dialog.innerHTML = `
        <h2 id="video-call-leave-end-title" class="video-call-leave-end-title">Leave or end call?</h2>
        <p class="video-call-leave-end-desc">Choose how you want to leave this consultation.</p>
        <div class="video-call-leave-end-actions">
            <button type="button" class="video-call-leave-end-btn video-call-leave-only-btn" id="vet-leave-only-btn">
                <i class="fa fa-sign-out" aria-hidden="true"></i>
                <span>Leave only</span>
            </button>
            <button type="button" class="video-call-leave-end-btn video-call-terminate-btn" id="vet-terminate-btn">
                <i class="fa fa-phone" aria-hidden="true"></i>
                <span>Terminate call completely</span>
            </button>
            <button type="button" class="video-call-leave-end-cancel" id="vet-leave-end-cancel">Cancel</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#vet-leave-end-cancel')?.addEventListener('click', close);
    overlay.querySelector('#vet-leave-only-btn')?.addEventListener('click', () => {
        close();
        leaveTemporary?.();
    });

    overlay.querySelector('#vet-terminate-btn')?.addEventListener('click', async () => {
        close();
        const notes = typeof getNotesFromForm === 'function' ? getNotesFromForm() : null;

        if (notes && appointmentRef) {
            await updateDoc(appointmentRef, {
                consultationNotes: notes,
                consultationNotesUpdatedAt: serverTimestamp(),
            }).catch(() => {});
        }

        const endedAt = serverTimestamp();
        await setDoc(videoCallRef, {
            status: 'ended',
            endedBy: userUid,
            endedAt,
            updatedAt: serverTimestamp(),
        }, { merge: true }).catch(() => {});

        await clearSignaling?.();

        if (appointmentRef && appointmentData) {
            try {
                await updateDoc(appointmentRef, {
                    status: 'completed',
                    completedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                    videoSessionEndedAt: endedAt,
                });
                await updateAssignedSlotStatus?.('completed');
            } catch (e) {
                console.warn('Could not mark appointment/slot completed:', e);
            }
        }

        const updatedSnap = await getDoc(videoCallRef);
        const updatedData = updatedSnap.exists() ? updatedSnap.data() : {};
        leaveRoom?.('callEnded=1', {
            showSessionEnded: true,
            endLabel: formatEndLabel?.(updatedData.endedAt) || '—',
            isVet: true,
            consultationNotes: notes,
            appointmentRef,
        });
    });
}

