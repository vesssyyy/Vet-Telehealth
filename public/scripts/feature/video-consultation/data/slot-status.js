import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { normalizeTimeString } from '../utils/time.js';

/**
 * Update a vet schedule slot's status for the current appointment.
 * Matches by appointmentId or by slot start time.
 */
export async function updateAssignedSlotStatus({
    db,
    appointmentId,
    appointmentData,
    nextStatus,
    allowedCurrentStatuses = null,
}) {
    if (!appointmentData?.vetId) return;

    const dateStr = appointmentData.dateStr || appointmentData.date || '';
    const slotStart = appointmentData.slotStart || appointmentData.timeStart || '';
    if (!dateStr || !slotStart) return;

    const scheduleRef = doc(db, 'users', appointmentData.vetId, 'schedules', dateStr);
    const scheduleSnap = await getDoc(scheduleRef);
    if (!scheduleSnap.exists()) return;

    const slots = scheduleSnap.data().slots || [];
    const normalizedSlotStart = normalizeTimeString(slotStart);
    const updatedSlots = slots.map((slot) => {
        const matchById = String(slot.appointmentId || '') === String(appointmentId);
        const matchBySlot = normalizedSlotStart && normalizeTimeString(slot.start) === normalizedSlotStart;
        const currentStatus = slot.status || 'booked';
        const canUpdate = !allowedCurrentStatuses || allowedCurrentStatuses.includes(currentStatus);
        if (canUpdate && (matchById || matchBySlot)) {
            return { ...slot, status: nextStatus };
        }
        return slot;
    });

    await setDoc(scheduleRef, { date: dateStr, slots: updatedSlots });
}

