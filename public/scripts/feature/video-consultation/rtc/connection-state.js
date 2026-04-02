/**
 * Video consultation — connection state helpers.
 * Keeps ownership of mutable variables in the caller via getters/setters.
 */
export function createVideoCallConnectionStateHelpers(ctx) {
    const {
        getRemoteStream,
        setRemoteStream,
        remoteVideo,
        getPeerConnection,
        setPeerConnection,
        setActivePeerSessionId,
        setConnectionEstablished,
        pendingIceCandidates,
        scheduleAutoReconnect,
        setStatus,
        getSessionEndedHandled,
    } = ctx;

    let mediaWatchdogTimeoutId = null;

    function clearMediaWatchdog() {
        if (mediaWatchdogTimeoutId) {
            clearTimeout(mediaWatchdogTimeoutId);
            mediaWatchdogTimeoutId = null;
        }
    }

    function hasRemoteMediaFlow() {
        const stream = getRemoteStream?.();
        if (!stream) return false;
        const tracks = stream.getTracks();
        if (!tracks.length) return false;
        return tracks.some((t) => t.readyState === 'live');
    }

    function armMediaWatchdog() {
        if (getSessionEndedHandled?.()) return;
        clearMediaWatchdog();
        mediaWatchdogTimeoutId = setTimeout(() => {
            mediaWatchdogTimeoutId = null;
            if (getSessionEndedHandled?.()) return;
            if (getPeerConnection?.() && !hasRemoteMediaFlow()) {
                setStatus?.('Connected but no media yet. Reconnecting…');
                scheduleAutoReconnect?.('no-media');
            }
        }, 9000);
    }

    function resetPeerConnectionState() {
        try { getPeerConnection?.()?.close(); } catch (_) {}
        setPeerConnection?.(null);
        setActivePeerSessionId?.(null);
        setConnectionEstablished?.(false);
        clearMediaWatchdog();
        pendingIceCandidates.length = 0;
        setRemoteStream?.(null);
        if (remoteVideo) remoteVideo.srcObject = null;
    }

    function ensureRemotePlayback() {
        if (!remoteVideo) return;
        const playPromise = remoteVideo.play?.();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
        }
    }

    return {
        clearMediaWatchdog,
        hasRemoteMediaFlow,
        armMediaWatchdog,
        resetPeerConnectionState,
        ensureRemotePlayback,
    };
}

