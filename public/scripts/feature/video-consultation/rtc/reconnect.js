import {
    updateDoc,
    serverTimestamp,
    deleteField,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/**
 * Reconnect UI + auto-reconnect timer/backoff.
 * Caller owns state; this module acts through getters/setters and callbacks.
 */
export function createVideoCallReconnectController(ctx) {
    const {
        videoCallRef,
        appointmentData,
        remoteVideo,
        pendingIceCandidates,
        nextSignalingSessionId,
        getSessionEndedHandled,
        getPeerConnection,
        setPeerConnection,
        setConnectionEstablished,
        setCurrentSignalingSessionId,
        setOfferedSessionId,
        setStatus,
        setVisiblePhaseMessage,
        setWaiting,
    } = ctx;

    const {
        maxAttempts = 5,
        baseMs = 1200,
    } = ctx.auto ?? {};

    let reconnectBtnEl = null;
    let autoReconnectAttempts = 0;
    let autoReconnectTimerId = null;

    function showReconnectUI(show) {
        const wrap = document.querySelector('.remote-video-wrap');
        if (!wrap) return;
        if (show) {
            if (!reconnectBtnEl) {
                reconnectBtnEl = document.createElement('button');
                reconnectBtnEl.type = 'button';
                reconnectBtnEl.className = 'video-call-reconnect-btn';
                reconnectBtnEl.innerHTML = '<i class="fa fa-refresh" aria-hidden="true"></i> Reconnect video';
                reconnectBtnEl.setAttribute('aria-label', 'Reconnect video');
                reconnectBtnEl.addEventListener('click', () => {
                    reconnectBtnEl?.classList.add('is-loading');
                    reconnectBtnEl.disabled = true;
                    triggerReconnect();
                });
                wrap.appendChild(reconnectBtnEl);
            }
            reconnectBtnEl.classList.remove('is-hidden');
            reconnectBtnEl.classList.remove('is-loading');
            reconnectBtnEl.disabled = false;
        } else if (reconnectBtnEl) {
            reconnectBtnEl.classList.add('is-hidden');
        }
    }

    function clearAutoReconnectTimer() {
        if (autoReconnectTimerId) {
            clearTimeout(autoReconnectTimerId);
            autoReconnectTimerId = null;
        }
    }

    function resetAutoReconnectAttempts() {
        autoReconnectAttempts = 0;
        clearAutoReconnectTimer();
    }

    function scheduleAutoReconnect(reason = 'network') {
        if (autoReconnectAttempts >= maxAttempts) {
            setStatus?.('Connection unstable. Tap reconnect to try again.');
            showReconnectUI(true);
            return;
        }
        if (autoReconnectTimerId) return;
        const waitMs = Math.min(baseMs * Math.pow(2, autoReconnectAttempts), 10000);
        autoReconnectAttempts += 1;
        setStatus?.(`Reconnecting (${reason})…`);
        autoReconnectTimerId = setTimeout(() => {
            autoReconnectTimerId = null;
            triggerReconnect();
        }, waitMs);
    }

    async function triggerReconnect() {
        if (getSessionEndedHandled?.()) return;
        try {
            clearAutoReconnectTimer();
            const pc = getPeerConnection?.();
            if (pc) { pc.close(); setPeerConnection?.(null); }
            pendingIceCandidates.length = 0;
            setConnectionEstablished?.(false);
            const sid = nextSignalingSessionId();
            setCurrentSignalingSessionId?.(sid);
            setOfferedSessionId?.(null);
            if (remoteVideo) remoteVideo.srcObject = null;
            await updateDoc(videoCallRef, {
                offer: deleteField(),
                answer: deleteField(),
                sessionId: sid,
                ...(appointmentData?.ownerId ? { offererUid: appointmentData.ownerId } : {}),
                updatedAt: serverTimestamp(),
            }).catch(() => {});
            setStatus?.('Reconnecting…');
            setVisiblePhaseMessage?.('Connecting…', 'fa-spinner fa-spin');
            setWaiting?.(true);
            showReconnectUI(false);
        } catch (e) {
            console.warn('Reconnect error:', e);
            setStatus?.('Reconnecting failed. Try leaving and rejoining.');
            showReconnectUI(true);
        }
    }

    return {
        showReconnectUI,
        scheduleAutoReconnect,
        triggerReconnect,
        clearAutoReconnectTimer,
        resetAutoReconnectAttempts,
    };
}

