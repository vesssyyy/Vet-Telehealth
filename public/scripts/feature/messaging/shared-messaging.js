import { auth, db } from '../../core/firebase/firebase-config.js';
import {
    collection, doc, getDoc, getDocs, addDoc,
    query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

export function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function ownerDisplayName(data) {
    return (data?.displayName || '').trim()
        || [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim()
        || (data?.email || '').split('@')[0]
        || 'Pet Owner';
}

export function vetDisplayName(data, withDr) {
    return withDr(
        (data?.displayName || '').trim()
        || [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim()
        || (data?.email || '').split('@')[0]
        || 'Veterinarian'
    );
}

export async function getCurrentOwnerDisplayName() {
    const user = auth.currentUser;
    if (!user?.uid) return 'Pet Owner';
    const ownerSnap = await getDoc(doc(db, 'users', user.uid));
    return ownerDisplayName(ownerSnap.exists() ? ownerSnap.data() : {});
}

export async function getCurrentVetDisplayName(withDr) {
    const user = auth.currentUser;
    if (!user?.uid) return 'Veterinarian';
    const vetSnap = await getDoc(doc(db, 'users', user.uid));
    return vetDisplayName(vetSnap.exists() ? vetSnap.data() : {}, withDr);
}

export async function findConversationByRolePair({ roleField, roleUid, peerField, peerId, petId }) {
    const snap = await getDocs(query(collection(db, 'conversations'), where(roleField, '==', roleUid)));
    const hit = snap.docs.find(d => {
        const data = d.data();
        return String(data[peerField]) === String(peerId) && String(data.petId) === String(petId);
    });
    return hit ? { id: hit.id, ...hit.data() } : null;
}

export async function createConversationDoc(payload) {
    const convRef = await addDoc(collection(db, 'conversations'), {
        unreadCount_owner: 0,
        unreadCount_vet: 0,
        ...payload,
        lastMessageAt: serverTimestamp(),
        createdAt: serverTimestamp(),
    });
    return convRef.id;
}

