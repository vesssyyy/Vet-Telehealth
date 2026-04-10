/**
 * When removing a pet or deleting an account, block if a visit is ongoing or still upcoming.
 * Aligns with pet-manager removal rules.
 */
import {
    collection,
    getDocs,
    query,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { APPOINTMENTS_COLLECTION } from './constants.js';
import { isUpcoming } from './time.js';

export function appointmentBlocksRemoval(data) {
    const status = (data.status || 'booked').toLowerCase();
    if (status === 'completed' || status === 'cancelled' || status === 'confirmed') return false;
    if (status === 'ongoing') return true;
    return isUpcoming(data);
}

// True if this user cannot delete their account due to appointments as pet owner or vet.
export async function accountHasBlockingAppointments(db, uid) {
    if (!db || !uid) return false;
    const col = collection(db, APPOINTMENTS_COLLECTION);
    const [ownerSnap, vetSnap] = await Promise.all([
        getDocs(query(col, where('ownerId', '==', uid))),
        getDocs(query(col, where('vetId', '==', uid))),
    ]);
    const anyBlocking = (snap) => snap.docs.some((d) => appointmentBlocksRemoval(d.data()));
    return anyBlocking(ownerSnap) || anyBlocking(vetSnap);
}
