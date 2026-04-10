import {
    collection,
    getDocs,
    writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

// Remove ICE candidate docs under appointments/{id}/signaling in 500-write batches.
export async function clearSignalingCollection(db, appointmentId) {
    const colRef = collection(db, 'appointments', appointmentId, 'signaling');
    const snap = await getDocs(colRef);
    const docs = snap.docs;
    if (!docs.length) return;
    const chunk = 500;
    for (let i = 0; i < docs.length; i += chunk) {
        const batch = writeBatch(db);
        docs.slice(i, i + chunk).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
}

