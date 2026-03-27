import {
    addDoc,
    collection,
    getDocs,
    query,
    serverTimestamp,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { withDr } from '../../../core/app/utils.js';

/**
 * Find existing conversation for owner/vet/pet or create one if missing.
 * Returns conversation id or null when unavailable.
 */
export async function resolveVideoCallConversation(options = {}) {
    const {
        db,
        userUid,
        ownerUid,
        vetUid,
        petId,
        petName = 'Pet',
        isVet = false,
        myName = '',
        otherParticipantName = '',
        idFromFirestoreField,
    } = options;

    try {
        const [ownerConvsSnap, vetConvsSnap] = await Promise.all([
            getDocs(query(collection(db, 'conversations'), where('ownerId', '==', userUid))),
            getDocs(query(collection(db, 'conversations'), where('vetId', '==', userUid))),
        ]);
        const convDocs = [...ownerConvsSnap.docs, ...vetConvsSnap.docs];
        const conv = convDocs
            .map((d) => ({ id: d.id, ...d.data() }))
            .find((c) => {
                const o = idFromFirestoreField(c.ownerId);
                const v = idFromFirestoreField(c.vetId);
                return v === vetUid && o === ownerUid && String(c.petId) === String(petId);
            });

        if (conv) return conv.id;

        if (ownerUid && vetUid && ownerUid !== vetUid) {
            const ownerName = isVet ? (otherParticipantName || 'Pet Owner') : myName;
            /** Always store canonical vet title; whoever opens the call first used to skip "Dr." for the vet. */
            const vetName = withDr(isVet ? myName : otherParticipantName);
            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId: ownerUid,
                ownerName,
                vetId: vetUid,
                vetName,
                petId,
                petName,
                vetSpecialty: '',
                participants: [ownerUid, vetUid],
                lastMessage: '',
                lastMessageAt: serverTimestamp(),
                createdAt: serverTimestamp(),
            });
            return convRef.id;
        }
    } catch (convErr) {
        console.warn('Video call: could not open or create conversation (chat may be unavailable):', convErr);
    }

    return null;
}

