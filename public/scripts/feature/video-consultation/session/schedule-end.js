import {
    getDoc,
    setDoc,
    updateDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    getAppointmentSlotEndDate,
    isVideoSessionEnded,
} from '../utils/appointment-time.js';

function videoRoomStillOccupiedFromSnapshot(roomData) {
    if (!roomData || typeof roomData !== 'object') return false;
    if (String(roomData.status || '').toLowerCase() === 'ended') return false;
    const p = roomData.participants;
    if (!p || typeof p !== 'object') return false;
    return Object.keys(p).some((k) => p[k]);
}

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
        if (!slotEndAt || Date.now() < slotEndAt.getTime()) return false;

        let roomSnap;
        try {
            roomSnap = await getDoc(videoCallRef);
        } catch (e) {
            console.warn('Schedule end: could not read video room', e);
            return false;
        }
        const roomData = roomSnap.exists() ? roomSnap.data() : {};
        if (videoRoomStillOccupiedFromSnapshot(roomData)) return false;

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
        const endDate = getAppointmentSlotEndDate(getAppointmentData?.());
        if (!endDate) return;

        const run = () => {
            finalizeConsultationForScheduleEnd().catch((e) => console.warn('Schedule end finalize:', e));
        };

        const ms = endDate.getTime() - Date.now();
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
            if (Date.now() >= endDate.getTime()) run();
        }, 15000);
    }

    return {
        clearScheduleEndWatchers,
        performScheduleEndCompletion,
        finalizeConsultationForScheduleEnd,
        armScheduleEndCompletion,
    };
}

