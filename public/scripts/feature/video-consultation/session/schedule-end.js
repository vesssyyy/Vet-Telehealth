import {
    getDoc,
    setDoc,
    updateDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    getAppointmentSlotEndDate,
    getAppointmentGraceEndDate,
    isVideoSessionEnded,
} from '../utils/appointment-time.js';

/**
 * Schedule-end completion controller.
 * Extracted from video-call core without changing behavior.
 */
export function createScheduleEndController(options = {}) {
    const {
        appointmentRef,
        videoCallRef,
        getAppointmentData,
        getSessionEndedHandled,
        setSessionEndedHandled,
        isVet,
        getNotesFromForm,
        updateAssignedSlotStatus,
        clearSignaling,
        leaveRoom,
        formatEndLabel,
    } = options;

    let scheduleEndTimerId = null;
    let scheduleEndPollId = null;

    function clearScheduleEndWatchers() {
        if (scheduleEndTimerId) {
            clearTimeout(scheduleEndTimerId);
            scheduleEndTimerId = null;
        }
        if (scheduleEndPollId) {
            clearInterval(scheduleEndPollId);
            scheduleEndPollId = null;
        }
    }

    async function performScheduleEndCompletion(params = {}) {
        const { showSessionEndedOverlay = true } = params;
        if (getSessionEndedHandled()) return false;

        let aptSnap;
        try {
            aptSnap = await getDoc(appointmentRef);
        } catch (e) {
            console.warn('Schedule end: could not read appointment', e);
            return false;
        }
        if (!aptSnap.exists()) return false;
        const apt = aptSnap.data();
        if (isVideoSessionEnded(apt)) return false;

        const slotEndAt = getAppointmentSlotEndDate(apt);
        const graceEndAt = getAppointmentGraceEndDate(apt);
        if (!slotEndAt || !graceEndAt) return false;
        // Do not auto-end until scheduled end + grace window.
        if (Date.now() < graceEndAt.getTime()) return false;

        // Past grace: end the session even if participants are still in the room (both clients
        // react to videoCall.status === 'ended'). Previously we waited for an empty room, so the
        // grace timer never completed while the call was active.

        setSessionEndedHandled(true);
        clearScheduleEndWatchers();

        const endedAt = serverTimestamp();
        const vetNotes = isVet && typeof getNotesFromForm === 'function' ? getNotesFromForm() : null;

        const aptUpdate = {
            status: 'completed',
            completedAt: endedAt,
            updatedAt: endedAt,
            videoSessionEndedAt: endedAt,
            consultationNotesAutoFinalizedAt: endedAt,
        };
        if (isVet && vetNotes && typeof vetNotes === 'object') {
            aptUpdate.consultationNotes = vetNotes;
            aptUpdate.consultationNotesUpdatedAt = endedAt;
        }

        try {
            await updateDoc(appointmentRef, aptUpdate);
        } catch (e) {
            console.warn('Schedule end: could not complete appointment:', e);
            setSessionEndedHandled(false);
            armScheduleEndCompletion();
            return false;
        }

        await setDoc(videoCallRef, {
            status: 'ended',
            endedBy: 'schedule',
            endedAt,
            updatedAt: serverTimestamp(),
        }, { merge: true }).catch((e) => console.warn('Schedule end: videoCall room:', e));

        await clearSignaling?.();

        try {
            await updateAssignedSlotStatus?.('completed', ['booked', 'ongoing']);
        } catch (e) {
            console.warn('Schedule end: slot status:', e);
        }

        if (showSessionEndedOverlay) {
            const updatedSnap = await getDoc(videoCallRef);
            const updatedData = updatedSnap.exists() ? updatedSnap.data() : {};
            leaveRoom?.('callEnded=1', {
                showSessionEnded: true,
                endLabel: formatEndLabel?.(updatedData.endedAt) || '—',
                isVet,
                consultationNotes: isVet ? vetNotes : undefined,
                appointmentRef,
            });
        }
        return true;
    }

    async function finalizeConsultationForScheduleEnd() {
        await performScheduleEndCompletion({ showSessionEndedOverlay: true });
    }

    function armScheduleEndCompletion() {
        clearScheduleEndWatchers();
        const graceEndDate = getAppointmentGraceEndDate(getAppointmentData?.());
        if (!graceEndDate) return;

        const run = () => {
            finalizeConsultationForScheduleEnd().catch((e) => console.warn('Schedule end finalize:', e));
        };

        const ms = graceEndDate.getTime() - Date.now();
        if (ms <= 0) {
            run();
            return;
        }
        scheduleEndTimerId = setTimeout(run, ms);
        scheduleEndPollId = setInterval(() => {
            if (getSessionEndedHandled()) {
                clearScheduleEndWatchers();
                return;
            }
            if (Date.now() >= graceEndDate.getTime()) run();
        }, 15000);
    }

    return {
        clearScheduleEndWatchers,
        performScheduleEndCompletion,
        finalizeConsultationForScheduleEnd,
        armScheduleEndCompletion,
    };
}

