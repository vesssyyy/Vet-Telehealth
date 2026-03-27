import {
    getDoc,
    setDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { isVideoSessionEnded } from '../utils/appointment-time.js';

/**
 * Join the Firestore room document.
 * Returns true if joined, false if room/session already ended.
 */
export async function joinVideoCallRoom({
    appointmentRef,
    videoCallRef,
    appointmentData,
    userUid,
    nextSignalingSessionId,
}) {
    const aptSnap = await getDoc(appointmentRef);
    if (aptSnap.exists() && isVideoSessionEnded(aptSnap.data())) return false;

    const snap = await getDoc(videoCallRef);
    const data = snap.exists() ? snap.data() : {};
    if (data.status === 'ended') return false;

    const participants = { ...(data.participants || {}), [userUid]: true };
    const participantIds = Object.keys(participants);

    // Pet owner always initiates offer so role does not depend on join order.
    const offererUid = appointmentData?.ownerId || data.offererUid || participantIds[0];
    const roomPayload = {
        participants,
        status: 'waiting',
        offererUid,
        updatedAt: serverTimestamp(),
    };

    // Preserve existing session if present; assign only on first room creation.
    if (!data.sessionId) {
        roomPayload.sessionId = nextSignalingSessionId();
    }

    await setDoc(videoCallRef, roomPayload, { merge: true });
    const sessionId = data.sessionId || roomPayload.sessionId || nextSignalingSessionId();
    return {
        joined: true,
        sessionId,
    };
}

