'use strict';

const DEFAULT_SLOT_DURATION_MINUTES = 30;
// Only scan this many days back (YYYY-MM-DD string range on appointments.dateStr).
const LOOKBACK_DAYS = 120;
const QUERY_PAGE_SIZE = 200;

function normalizeTimeString(value) {
  if (!value || typeof value !== 'string') return '';
  const [hoursText, minutesText] = value.trim().split(':');
  const hours = parseInt(hoursText, 10);
  const minutes = minutesText != null ? parseInt(minutesText, 10) : 0;
  if (Number.isNaN(hours)) return '';
  return `${String(hours).padStart(2, '0')}:${String(Number.isNaN(minutes) ? 0 : minutes).padStart(2, '0')}`;
}

function addMinutesToTime(timeStr, durationMinutes) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const [hStr, mStr = '0'] = String(timeStr).trim().split(':');
  const h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return null;
  let total = h * 60 + parseInt(mStr, 10) + (durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES);
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Calendar YYYY-MM-DD in the slot offset (same interpretation as slot end parsing).
function ymdForInstantInIsoOffset(utcMillis, isoOffset) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(isoOffset || '').trim());
  if (!m) {
    return new Date(utcMillis).toISOString().slice(0, 10);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const offMs = sign * (parseInt(m[2], 10, 10) * 3600000 + parseInt(m[3], 10, 10) * 60000);
  const d = new Date(utcMillis + offMs);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function slotEndUtcMillis(data, isoOffset) {
  const dateStr = data.dateStr || data.date;
  const slotStart = data.slotStart || data.timeStart;
  if (!dateStr || !slotStart) return null;
  const slotEnd = data.slotEnd || data.timeEnd || addMinutesToTime(slotStart, DEFAULT_SLOT_DURATION_MINUTES);
  const t = normalizeTimeString(slotEnd);
  if (!t) return null;
  const offset = /^([+-])(\d{2}):(\d{2})$/.test(String(isoOffset || '').trim()) ? String(isoOffset).trim() : '+08:00';
  const iso = `${dateStr}T${t}:00${offset}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function idFromFirestoreField(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.path === 'string') {
    const parts = v.path.split('/');
    return parts[parts.length - 1] || null;
  }
  return String(v);
}

function appointmentNeedsAutoEnd(data, nowMs, isoOffset) {
  const st = String(data.status || 'booked').toLowerCase();
  if (st === 'completed' || st === 'cancelled') return false;
  if (data.videoSessionEndedAt != null) return false;
  const endMs = slotEndUtcMillis(data, isoOffset);
  if (endMs == null) return false;
  return nowMs >= endMs;
}

// True if the video room still has someone connected (past slot end should not force-complete).
function videoRoomStillOccupied(roomData) {
  if (!roomData || typeof roomData !== 'object') return false;
  if (String(roomData.status || '').toLowerCase() === 'ended') return false;
  const p = roomData.participants;
  if (!p || typeof p !== 'object') return false;
  return Object.keys(p).some((k) => p[k]);
}

async function markScheduleSlotCompleted(db, vetId, dateStr, appointmentId, slotStart) {
  if (!vetId || !dateStr || !appointmentId) return;
  const scheduleRef = db.collection('users').doc(vetId).collection('schedules').doc(dateStr);
  const normalizedSlotStart = normalizeTimeString(slotStart || '');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(scheduleRef);
    if (!snap.exists) return;
    const slots = snap.data().slots || [];
    const norm = (s) => normalizeTimeString(String(s || ''));
    const updated = slots.map((slot) => {
      const matchById = String(slot.appointmentId || '') === String(appointmentId);
      const matchBySlot = normalizedSlotStart && norm(slot.start) === normalizedSlotStart;
      const cur = slot.status || 'booked';
      if ((matchById || matchBySlot) && (cur === 'booked' || cur === 'ongoing')) {
        return { ...slot, status: 'completed' };
      }
      return slot;
    });
    tx.set(scheduleRef, { date: dateStr, slots: updated }, { merge: true });
  });
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {typeof import('firebase-admin')} admin
 * @param {*} logger - firebase-functions/logger
 * @param {string} isoOffset - e.g. +08:00 for Asia/Manila wall times stored without Z
 */
async function runAutoEndPastConsultations(db, admin, logger, isoOffset) {
  const FieldValue = admin.firestore.FieldValue;
  const nowMs = Date.now();
  const maxDateStr = ymdForInstantInIsoOffset(nowMs, isoOffset);
  const minDateStr = ymdForInstantInIsoOffset(nowMs - LOOKBACK_DAYS * 86400000, isoOffset);

  let lastDoc = null;
  let examined = 0;
  let completed = 0;
  let errors = 0;

  for (;;) {
    let q = db
      .collection('appointments')
      .where('dateStr', '>=', minDateStr)
      .where('dateStr', '<=', maxDateStr)
      .orderBy('dateStr', 'asc')
      .limit(QUERY_PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      examined += 1;
      const data = doc.data();
      if (!appointmentNeedsAutoEnd(data, nowMs, isoOffset)) continue;

      const appointmentId = doc.id;
      const vetId = idFromFirestoreField(data.vetId);
      const dateStr = data.dateStr || data.date || '';
      const slotStart = data.slotStart || data.timeStart || '';

      try {
        const aptRef = db.collection('appointments').doc(appointmentId);
        const fresh = await aptRef.get();
        if (!fresh.exists) continue;
        const live = fresh.data();
        if (!appointmentNeedsAutoEnd(live, nowMs, isoOffset)) continue;

        const roomRef = aptRef.collection('videoCall').doc('room');
        const roomSnap = await roomRef.get();
        const roomData = roomSnap.exists ? roomSnap.data() : {};
        // End time already verified above; require empty room before terminating → history/completed.
        if (videoRoomStillOccupied(roomData)) continue;

        await aptRef.update({
          status: 'completed',
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          videoSessionEndedAt: FieldValue.serverTimestamp(),
          consultationNotesAutoFinalizedAt: FieldValue.serverTimestamp(),
        });

        await roomRef.set(
          {
            status: 'ended',
            endedBy: 'schedule',
            endedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (vetId && dateStr) {
          await markScheduleSlotCompleted(db, vetId, dateStr, appointmentId, slotStart);
        }

        completed += 1;
        logger.info('scheduledAutoEndPastConsultations: completed appointment', { appointmentId });
      } catch (e) {
        errors += 1;
        logger.error('scheduledAutoEndPastConsultations: failed', {
          appointmentId,
          message: e && e.message,
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < QUERY_PAGE_SIZE) break;
  }

  logger.info('scheduledAutoEndPastConsultations: run finished', {
    examined,
    completed,
    errors,
    minDateStr,
    maxDateStr,
  });
}

function makeSchedule({
  onSchedule,
  db,
  admin,
  logger,
  appointmentSlotIsoOffset,
}) {
  const scheduledAutoEndPastConsultations = onSchedule(
    {
      schedule: 'every 1 minutes',
      timeZone: 'Asia/Manila',
      memory: '256MiB',
      timeoutSeconds: 300,
    },
    async () => {
      await runAutoEndPastConsultations(db, admin, logger, appointmentSlotIsoOffset.value());
    },
  );

  return { scheduledAutoEndPastConsultations, runAutoEndPastConsultations };
}

module.exports = { makeSchedule, runAutoEndPastConsultations };

