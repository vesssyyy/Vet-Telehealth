import {
    addDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/**
 * Create RTCPeerConnection for video consultation.
 * Uses callbacks/getters to keep state ownership in caller.
 */
export function createVideoCallPeerConnection(ctx) {
    const {
        rtcConfig,
        getPreferRelayTransport,
        localStream,
        signalingRef,
        userUid,
        getCurrentSignalingSessionId,
        remoteVideo,
        getRemoteStream,
        setRemoteStream,
        ensureRemotePlayback,
        setConnectionEstablished,
        clearMediaWatchdog,
        resetAutoReconnectAttempts,
        clearAutoReconnectTimer,
        setStatus,
        setWaiting,
        showReconnectUI,
        clearEstablishTimeout,
        setPreferRelayTransport,
        setVisiblePhaseMessage,
        scheduleAutoReconnect,
        armMediaWatchdog,
    } = ctx;

    const effectiveRtcConfig = getPreferRelayTransport?.()
        ? { ...rtcConfig, iceTransportPolicy: 'relay' }
        : rtcConfig;

    const pc = new RTCPeerConnection(effectiveRtcConfig);
    const audioTracks = localStream?.getAudioTracks?.() || [];
    const videoTracks = localStream?.getVideoTracks?.() || [];
    [...audioTracks, ...videoTracks].forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (ev) => {
        const incomingTrack = ev.track || null;
        const incomingStream = ev.streams?.[0] || null;
        let stream = getRemoteStream?.();
        if (!stream) {
            stream = new MediaStream();
            setRemoteStream?.(stream);
        }
        if (incomingTrack && !stream.getTracks().some((t) => t.id === incomingTrack.id)) {
            stream.addTrack(incomingTrack);
            incomingTrack.onunmute = () => ensureRemotePlayback?.();
        }
        if (incomingStream) {
            incomingStream.getTracks().forEach((t) => {
                if (!stream.getTracks().some((rt) => rt.id === t.id)) stream.addTrack(t);
            });
        }
        if (remoteVideo) {
            remoteVideo.srcObject = stream;
            ensureRemotePlayback?.();
        }
        if (stream.getTracks().length > 0) {
            setConnectionEstablished?.(true);
            clearMediaWatchdog?.();
            resetAutoReconnectAttempts?.();
            clearAutoReconnectTimer?.();
            setStatus?.('Connected');
            setWaiting?.(false);
            showReconnectUI?.(false);
        }
    };

    pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        addDoc(signalingRef, {
            from: userUid,
            candidate: JSON.stringify(ev.candidate),
            sessionId: getCurrentSignalingSessionId?.() || null,
            createdAt: serverTimestamp(),
        }).catch((err) => console.warn('ICE send error', err));
    };

    pc.onicegatheringstatechange = () => {
        console.info('ICE gathering state:', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
            setConnectionEstablished?.(true);
            resetAutoReconnectAttempts?.();
            clearAutoReconnectTimer?.();
            clearEstablishTimeout?.();
            setStatus?.('Connected');
            setWaiting?.(false);
            showReconnectUI?.(false);
        } else if (state === 'failed' || state === 'disconnected') {
            if (state === 'failed') {
                setPreferRelayTransport?.(true);
                setStatus?.('Connection failed. Network path blocked (likely no relay). Trying to reconnect…');
                setVisiblePhaseMessage?.('Connecting…', 'fa-spinner fa-spin');
                showReconnectUI?.(true);
                scheduleAutoReconnect?.('failed');
            } else if (state === 'disconnected') {
                setStatus?.('Connection unstable. Trying to reconnect…');
                setVisiblePhaseMessage?.('Connecting…', 'fa-spinner fa-spin');
                try { pc.restartIce(); } catch (_) {}
                scheduleAutoReconnect?.('unstable');
            }
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.info('Peer connection state:', state);
        if (state === 'connected') {
            setConnectionEstablished?.(true);
            armMediaWatchdog?.();
            resetAutoReconnectAttempts?.();
            clearAutoReconnectTimer?.();
            clearEstablishTimeout?.();
            setStatus?.('Connected');
            setWaiting?.(false);
            showReconnectUI?.(false);
        } else if (state === 'failed') {
            setPreferRelayTransport?.(true);
            setStatus?.('Connection failed. Network path blocked (likely no relay). Trying to reconnect…');
            setVisiblePhaseMessage?.('Connecting…', 'fa-spinner fa-spin');
            showReconnectUI?.(true);
            scheduleAutoReconnect?.('failed');
        }
    };

    return pc;
}

