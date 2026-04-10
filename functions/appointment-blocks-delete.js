'use strict';

// Keep in sync with public/scripts/feature/appointment/shared/time.js + appointment-blocking.js
const DEFAULT_SLOT_DURATION_MINUTES = 30;

function addMinutesToTime(timeStr, durationMinutes) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
  const h = parseInt(hStr, 10);
  if (isNaN(h)) return null;
  let total = h * 60 + parseInt(mStr, 10) + (durationMinutes || DEFAULT_SLOT_DURATION_MINUTES);
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function getAppointmentSlotEndDate(apt) {
  const dateStr = apt?.date || apt?.dateStr;
  const slotStart = apt?.slotStart || apt?.timeStart;
  if (!dateStr || !slotStart) return null;
  const slotEnd = apt?.slotEnd || apt?.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
  if (!slotEnd) return null;
  const end = new Date(`${dateStr}T${slotEnd}`);
  return isNaN(end.getTime()) ? null : end;
}

function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isUpcoming(appointment) {
  const status = (appointment.status || 'booked').toLowerCase();
  if (status === 'cancelled' || status === 'completed') return false;
  const dateStr = appointment.date || appointment.dateStr || '';
  const today = getTodayDateString();
  if (!dateStr) return true;
  if (dateStr < today) return false;
  if (dateStr > today) return true;
  const endAt = getAppointmentSlotEndDate(appointment);
  if (endAt && Date.now() >= endAt.getTime()) return false;
  return true;
}

function appointmentBlocksRemoval(data) {
  const status = (data.status || 'booked').toLowerCase();
  if (status === 'completed' || status === 'cancelled' || status === 'confirmed') return false;
  if (status === 'ongoing') return true;
  return isUpcoming(data);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function userHasBlockingAppointment(db, uid) {
  const [ownerSnap, vetSnap] = await Promise.all([
    db.collection('appointments').where('ownerId', '==', uid).get(),
    db.collection('appointments').where('vetId', '==', uid).get(),
  ]);
  const anyBlocking = (snap) => snap.docs.some((d) => appointmentBlocksRemoval(d.data()));
  return anyBlocking(ownerSnap) || anyBlocking(vetSnap);
}

module.exports = {
  appointmentBlocksRemoval,
  userHasBlockingAppointment,
};
