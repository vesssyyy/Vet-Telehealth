// Vet schedule slot tallies for dashboard (read-only; matches appointments schedule list semantics).
import { db } from '../../../core/firebase/firebase-config.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { normalizeTimeString } from '../../video-consultation/utils/time.js';
import { getAppointmentSlotEndDate, isVideoSessionEnded } from '../../video-consultation/utils/appointment-time.js';

const DEFAULT_MIN_ADVANCE_MINUTES = 30;

export const SCHEDULE_DONUT_COLORS = {
    avail: '#22c55e',
    booked: '#f97316',
    completed: '#2563eb',
    expired: '#dc2626',
    empty: '#e5e7eb',
};

function appointmentDoc(id) {
    return doc(db, 'appointments', id);
}

function computeExpiryTimeMs(dateStr, slotStart, minAdvanceMinutes) {
    const [h, m] = (slotStart || '').split(':').map(Number);
    const slotMins = (h || 0) * 60 + (m || 0);
    const d = new Date(dateStr + 'T00:00:00');
    d.setMinutes(d.getMinutes() + slotMins - (minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES));
    return d.getTime();
}

function isSlotExpired(slot, nowMs) {
    const status = slot.status || 'available';
    if (status === 'booked' || status === 'ongoing' || status === 'completed') return false;
    if (status === 'expired') return true;
    const expiry = slot.expiryTime != null ? Number(slot.expiryTime) : null;
    if (expiry == null) return false;
    return nowMs >= expiry;
}

function ensureSlotExpiry(slot, dateStr, minAdvanceMinutes) {
    const mins = minAdvanceMinutes ?? DEFAULT_MIN_ADVANCE_MINUTES;
    if (slot.expiryTime != null) return slot;
    return { ...slot, expiryTime: computeExpiryTimeMs(dateStr, slot.start, mins) };
}

function dedupeSlots(slots, dateStr) {
    const seen = new Set();
    return slots.filter((s) => {
        const key = `${dateStr}|${s.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function slotEffectiveStatus(s) {
    return (s && s.__displayStatus) || (s && s.status) || 'available';
}

function cloneSchedulesShallow(schedules) {
    return (schedules || []).map((sch) => ({
        ...sch,
        slots: (sch.slots || []).map((slot) => ({ ...slot })),
    }));
}

function isAptCompletedInFirestore(aptData) {
    if (!aptData || typeof aptData !== 'object') return false;
    if (isVideoSessionEnded(aptData)) return true;
    return String(aptData.status || '').toLowerCase() === 'completed';
}

function isPastAppointmentSlotEndForDisplay(aptData) {
    const endAt = getAppointmentSlotEndDate(aptData);
    return !!(endAt && Date.now() >= endAt.getTime());
}

async function resolveAppointmentFromScheduleSlot(vetId, dateStr, slotStart) {
    const safeVetId = String(vetId || '').trim();
    const safeDate = String(dateStr || '').trim();
    const safeStart = normalizeTimeString(String(slotStart || '').trim());
    if (!safeVetId || !safeDate || !safeStart) return null;
    try {
        const qPrimary = query(
            collection(db, 'appointments'),
            where('vetId', '==', safeVetId),
            where('dateStr', '==', safeDate),
            where('slotStart', '==', safeStart),
        );
        const snapPrimary = await getDocs(qPrimary);
        if (!snapPrimary.empty) {
            const first = snapPrimary.docs[0];
            return { id: first.id, ...first.data() };
        }
        const qFallback = query(
            collection(db, 'appointments'),
            where('vetId', '==', safeVetId),
            where('date', '==', safeDate),
            where('slotStart', '==', safeStart),
        );
        const snapFallback = await getDocs(qFallback);
        if (!snapFallback.empty) {
            const first = snapFallback.docs[0];
            return { id: first.id, ...first.data() };
        }
    } catch (_) {
        // ignore
    }
    return null;
}

// Sets __displayStatus on slots from appointment docs (same rules as scheduling enrich; no Firestore writes).
async function enrichSchedulesWithAppointmentStatusReadOnly(schedules, vetUid) {
    const cloned = cloneSchedulesShallow(schedules);
    const ids = new Set();
    const unresolvedSlots = [];
    cloned.forEach((sch) => {
        (sch.slots || []).forEach((s) => {
            const st = s.status || 'available';
            const aid = (s.appointmentId || '').trim();
            if (st !== 'booked' && st !== 'ongoing') return;
            if (aid) {
                ids.add(aid);
                return;
            }
            unresolvedSlots.push({
                vetId: s.vetId || vetUid || '',
                dateStr: sch.date || sch.id || '',
                slotStart: s.start || '',
            });
        });
    });
    if (!ids.size && !unresolvedSlots.length) return cloned;

    const aptMap = new Map();
    await Promise.all(
        [...ids].map(async (id) => {
            try {
                const snap = await getDoc(appointmentDoc(id));
                if (snap.exists()) aptMap.set(id, snap.data());
            } catch (_) {
                // ignore
            }
        }),
    );
    await Promise.all(
        unresolvedSlots.map(async (slot) => {
            const key = `${slot.vetId}|${slot.dateStr}|${normalizeTimeString(slot.slotStart)}`;
            if (aptMap.has(key)) return;
            const resolved = await resolveAppointmentFromScheduleSlot(slot.vetId, slot.dateStr, slot.slotStart);
            if (resolved?.id) {
                aptMap.set(key, resolved);
                aptMap.set(resolved.id, resolved);
            }
        }),
    );

    cloned.forEach((sch) => {
        const dateStr = sch.date || sch.id || '';
        (sch.slots || []).forEach((s) => {
            const st = s.status || 'available';
            const aid = (s.appointmentId || '').trim();
            if (!aid || (st !== 'booked' && st !== 'ongoing')) return;
            const data = aptMap.get(aid);
            if (isAptCompletedInFirestore(data)) {
                s.__displayStatus = 'completed';
            } else if (data && isPastAppointmentSlotEndForDisplay(data)) {
                s.__displayStatus = 'completed';
            }
        });
    });
    cloned.forEach((sch) => {
        const dateStr = sch.date || sch.id || '';
        (sch.slots || []).forEach((s) => {
            const st = s.status || 'available';
            const aid = (s.appointmentId || '').trim();
            if (aid || (st !== 'booked' && st !== 'ongoing')) return;
            const key = `${s.vetId || vetUid || ''}|${dateStr}|${normalizeTimeString(s.start || '')}`;
            const data = aptMap.get(key);
            if (!data) return;
            if (isAptCompletedInFirestore(data) || isPastAppointmentSlotEndForDisplay(data)) {
                s.__displayStatus = 'completed';
            }
        });
    });
    return cloned;
}

async function loadVetMinAdvanceMinutes(uid) {
    if (!uid) return DEFAULT_MIN_ADVANCE_MINUTES;
    try {
        const ref = doc(db, 'users', uid, 'vetSettings', 'scheduling');
        const snap = await getDoc(ref);
        if (snap.exists()) {
            const m = snap.data()?.minAdvanceBookingMinutes;
            if (typeof m === 'number' && Number.isFinite(m) && m >= 1) return m;
        }
    } catch (_) {
        // ignore
    }
    return DEFAULT_MIN_ADVANCE_MINUTES;
}

async function loadAllSchedulesForVet(uid) {
    if (!uid) return [];
    const snap = await getDocs(collection(db, 'users', uid, 'schedules'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// @returns {Promise<{ avail: number, booked: number, completed: number, expired: number, total: number }>}
export async function fetchVetScheduleSlotCounts(vetUid) {
    const empty = { avail: 0, booked: 0, completed: 0, expired: 0, total: 0 };
    if (!vetUid) return empty;

    const minAdvance = await loadVetMinAdvanceMinutes(vetUid);
    const raw = await loadAllSchedulesForVet(vetUid);
    const nonBlocked = raw.filter((s) => s.blocked !== true);

    const prepared = nonBlocked.map((sch) => {
        const dateStr = sch.date || sch.id || '';
        return {
            ...sch,
            slots: dedupeSlots(
                (sch.slots || []).map((s) => ensureSlotExpiry(s, dateStr, minAdvance)),
                dateStr,
            ),
        };
    });

    const enriched = await enrichSchedulesWithAppointmentStatusReadOnly(prepared, vetUid);
    const nowMs = Date.now();
    const counts = { avail: 0, booked: 0, completed: 0, expired: 0 };

    for (const sch of enriched) {
        for (const slot of sch.slots || []) {
            const st = slotEffectiveStatus(slot);
            if (st === 'completed') counts.completed += 1;
            else if (st === 'booked' || st === 'ongoing') counts.booked += 1;
            else if (isSlotExpired(slot, nowMs)) counts.expired += 1;
            else if (st === 'available') counts.avail += 1;
            else counts.expired += 1;
        }
    }

    counts.total = counts.avail + counts.booked + counts.completed + counts.expired;
    return counts;
}

/**
 * Non-zero segments in donut draw order (matches conic-gradient clockwise from top).
 * @param {{ avail: number, booked: number, completed: number, expired: number, total: number }} counts
 * @returns {{ key: string, label: string, count: number }[]}
 */
function getScheduleDonutSegments(counts) {
    const { avail, booked, completed, expired, total } = counts;
    if (total <= 0) return [];
    const rows = [
        { key: 'avail', label: 'Avail', count: avail },
        { key: 'booked', label: 'Booked', count: booked },
        { key: 'completed', label: 'Completed', count: completed },
        { key: 'expired', label: 'Expired', count: expired },
    ];
    return rows.filter((r) => r.count > 0);
}

// @param {{ avail: number, booked: number, completed: number, expired: number, total: number }} counts
export function buildScheduleDonutConicGradient(counts) {
    const segments = getScheduleDonutSegments(counts);
    const total = counts.total;
    if (total <= 0 || !segments.length) {
        return `conic-gradient(from -90deg at 50% 50%, ${SCHEDULE_DONUT_COLORS.empty} 0deg 360deg)`;
    }
    let cur = 0;
    const parts = [];
    segments.forEach((s, i) => {
        const isLast = i === segments.length - 1;
        const end = isLast ? 360 : cur + (s.count / total) * 360;
        const color = SCHEDULE_DONUT_COLORS[s.key];
        parts.push(`${color} ${cur}deg ${end}deg`);
        cur = end;
    });
    return `conic-gradient(from -90deg at 50% 50%, ${parts.join(', ')})`;
}

/**
 * Angle in degrees: 0 at top, increasing clockwise (same as `conic-gradient(from -90deg …)`).
 * @param {number} angleDeg
 * @param {{ avail: number, booked: number, completed: number, expired: number, total: number }} counts
 * @returns {{ key: string, label: string, count: number, percent: number } | null}
 */
export function getScheduleDonutSegmentAtAngle(angleDeg, counts) {
    const segments = getScheduleDonutSegments(counts);
    const total = counts.total;
    if (!segments.length || total <= 0) return null;
    const norm = ((angleDeg % 360) + 360) % 360;
    let cum = 0;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const isLast = i === segments.length - 1;
        const spanDeg = isLast ? 360 - cum : (s.count / total) * 360;
        const nextCum = cum + spanDeg;
        if (!isLast) {
            if (norm >= cum && norm < nextCum) {
                return {
                    key: s.key,
                    label: s.label,
                    count: s.count,
                    percent: (s.count / total) * 100,
                };
            }
        } else {
            return {
                key: s.key,
                label: s.label,
                count: s.count,
                percent: (s.count / total) * 100,
            };
        }
        cum = nextCum;
    }
    return null;
}
