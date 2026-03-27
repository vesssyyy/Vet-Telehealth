import {
    setDoc,
    updateDoc,
    serverTimestamp,
    deleteField,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/**
 * Offer creation logic (including m-line retry path) for the offerer peer.
 */
export function createRtcOfferer(ctx) {
    const {
        videoCallRef,
        userUid,
        appointmentData,
        nextSignalingSessionId,
        getCreateOfferInFlight,
        setCreateOfferInFlight,
        getCurrentSignalingSessionId,
        setCurrentSignalingSessionId,
        getOfferedSessionId,
        setOfferedSessionId,
        getPeerConnection,
        setPeerConnection,
        createPeerConnection,
        getActivePeerSessionId,
        setActivePeerSessionId,
        resetPeerConnectionState,
    } = ctx;

    return async function createOffer() {
        if (getCreateOfferInFlight()) return;

        if (!getCurrentSignalingSessionId()) {
            setCurrentSignalingSessionId(nextSignalingSessionId());
        }

        if (
            getOfferedSessionId() === getCurrentSignalingSessionId() &&
            getPeerConnection()?.localDescription?.type === 'offer'
        ) {
            return;
        }

        setCreateOfferInFlight(true);
        const hasSessionMismatch = !!(
            getPeerConnection() &&
            getActivePeerSessionId() &&
            getCurrentSignalingSessionId() &&
            getActivePeerSessionId() !== getCurrentSignalingSessionId()
        );
        const hasUnstableSignaling = !!(getPeerConnection() && getPeerConnection().signalingState !== 'stable');
        if (hasSessionMismatch || hasUnstableSignaling) {
            resetPeerConnectionState();
        }
        if (!getPeerConnection()) setPeerConnection(createPeerConnection());

        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const pc = getPeerConnection();
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    setActivePeerSessionId(getCurrentSignalingSessionId());
                    setOfferedSessionId(getCurrentSignalingSessionId());
                    await setDoc(videoCallRef, {
                        offer: JSON.stringify(offer),
                        offererUid: userUid,
                        sessionId: getCurrentSignalingSessionId(),
                        updatedAt: serverTimestamp(),
                    }, { merge: true });
                    return;
                } catch (e) {
                    const msg = String(e?.message || '');
                    const isMLineOrderError = e?.name === 'InvalidAccessError' && /m-lines/i.test(msg);
                    if (!(isMLineOrderError && attempt === 0)) throw e;

                    console.warn('Offer SDP m-line order mismatch; rebuilding peer and retrying offer once.');
                    resetPeerConnectionState();
                    setCurrentSignalingSessionId(nextSignalingSessionId());
                    setOfferedSessionId(null);
                    await updateDoc(videoCallRef, {
                        offer: deleteField(),
                        answer: deleteField(),
                        sessionId: getCurrentSignalingSessionId(),
                        ...(appointmentData?.ownerId ? { offererUid: appointmentData.ownerId } : {}),
                        updatedAt: serverTimestamp(),
                    }).catch(() => {});
                    setPeerConnection(createPeerConnection());
                }
            }
        } finally {
            setCreateOfferInFlight(false);
        }
    };
}

