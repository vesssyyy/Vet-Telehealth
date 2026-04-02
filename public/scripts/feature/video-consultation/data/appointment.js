import { getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/** Firestore may return string or DocumentReference-like id fields. */
export function idFromFirestoreField(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
    return String(value).trim();
}

/**
 * Load and normalize appointment data for VC access checks.
 */
export async function loadVideoCallAppointmentContext({ appointmentRef, userUid }) {
    const aptSnap = await getDoc(appointmentRef);
    if (!aptSnap.exists()) {
        return { ok: false, reason: 'not_found' };
    }

    const appointmentData = { ...aptSnap.data() };
    appointmentData.ownerId = idFromFirestoreField(appointmentData.ownerId);
    appointmentData.vetId = idFromFirestoreField(appointmentData.vetId);
    appointmentData.petId = idFromFirestoreField(appointmentData.petId);

    const { vetId, ownerId } = appointmentData;
    if (userUid !== vetId && userUid !== ownerId) {
        return { ok: false, reason: 'forbidden', appointmentData };
    }

    return {
        ok: true,
        appointmentData,
        isVet: userUid === vetId,
        isPetOwner: userUid === ownerId,
    };
}

