import {
    updateDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/**
 * Builds offer/answer/ICE handlers while keeping mutable call state in the caller.
 */
export function createRtcNegotiationHandlers(ctx) {
    const {
        userUid,
        videoCallRef,
        pendingIceCandidates,
        nextSignalingSessionId,
        getCurrentSignalingSessionId,
        setCurrentSignalingSessionId,
        getActivePeerSessionId,
        setActivePeerSessionId,
        getPeerConnection,
        setPeerConnection,
        createPeerConnection,
        resetPeerConnectionState,
    } = ctx;

    async function drainPendingIceCandidates() {
        const pc = getPeerConnection();
        if (!pc) return;
        while (pendingIceCandidates.length > 0) {
            const data = pendingIceCandidates.shift();
            if (data.from === userUid) continue;
            try { await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))); }
            catch (e) { console.warn('addIceCandidate (drain) error', e); }
        }
    }

    async function handleOffer(offerStr, sessionId) {
        if (!offerStr) return;
        const activeSessionId = sessionId || getCurrentSignalingSessionId() || nextSignalingSessionId();
        if (getPeerConnection() && getActivePeerSessionId() && getActivePeerSessionId() !== activeSessionId) {
            resetPeerConnectionState();
        }
        const currentPc = getPeerConnection();
        if (currentPc) {
            const sameOffer =
                currentPc.remoteDescription?.type === 'offer' &&
                currentPc.remoteDescription?.sdp === JSON.parse(offerStr)?.sdp;
            if (!sameOffer) resetPeerConnectionState();
        }
        if (getPeerConnection()) return;
        setCurrentSignalingSessionId(activeSessionId);
        setActivePeerSessionId(activeSessionId);
        if (!sessionId) {
            await updateDoc(videoCallRef, { sessionId: activeSessionId, updatedAt: serverTimestamp() }).catch(() => {});
        }
        const pc = createPeerConnection();
        setPeerConnection(pc);
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerStr)));
        await drainPendingIceCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await updateDoc(videoCallRef, {
            answer: JSON.stringify(answer),
            sessionId: activeSessionId,
            updatedAt: serverTimestamp(),
        });
    }

    async function handleAnswer(answerStr, sessionId) {
        const pc = getPeerConnection();
        if (!answerStr || !pc || pc.signalingState !== 'have-local-offer') return;
        if (sessionId && getCurrentSignalingSessionId() && sessionId !== getCurrentSignalingSessionId()) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
            await drainPendingIceCandidates();
        } catch (e) { console.warn('setRemoteDescription (answer) skipped:', e.message); }
    }

    async function handleIceCandidate(data) {
        if (data.from === userUid) return;
        if (getCurrentSignalingSessionId() && data.sessionId !== getCurrentSignalingSessionId()) return;
        const pc = getPeerConnection();
        if (!pc || pc.remoteDescription === null) {
            pendingIceCandidates.push(data);
            return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))); }
        catch (e) { console.warn('addIceCandidate error', e); pendingIceCandidates.push(data); }
    }

    return {
        drainPendingIceCandidates,
        handleOffer,
        handleAnswer,
        handleIceCandidate,
    };
}

