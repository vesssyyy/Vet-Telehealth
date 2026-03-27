import { onSnapshot } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

export function subscribeToVideoCallRoom(videoCallRef, onData, onError) {
    return onSnapshot(
        videoCallRef,
        (snap) => {
            if (!snap.exists()) return;
            onData?.(snap.data(), snap);
        },
        onError
    );
}

export function subscribeToSignalingIce(signalingRef, onIceCandidate, onError) {
    return onSnapshot(
        signalingRef,
        (snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === 'added') onIceCandidate?.(change.doc.data(), change.doc);
            });
        },
        onError
    );
}

