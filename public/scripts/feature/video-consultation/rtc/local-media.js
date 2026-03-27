/**
 * Acquire local user media and attach to local video element.
 * Returns MediaStream or null on failure.
 */
export async function getLocalStream({ localVideo, onError }) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideo) localVideo.srcObject = stream;
        return stream;
    } catch (e) {
        console.error('getUserMedia error:', e);
        if (typeof onError === 'function') onError(e);
        return null;
    }
}

