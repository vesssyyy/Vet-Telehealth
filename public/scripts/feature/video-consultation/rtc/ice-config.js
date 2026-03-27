import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-functions.js';

/**
 * Load ICE servers from backend callable and fallback to default config.
 * Returns a complete RTC config object.
 */
export async function loadRtcConfigFromBackend({ app, forceRelay = false, defaultRtcConfig }) {
    try {
        const callable = httpsCallable(getFunctions(app, 'us-central1'), 'getRtcIceServers');
        const result = await callable();
        const servers = result?.data?.iceServers;
        if (Array.isArray(servers) && servers.length > 0) {
            const config = forceRelay ? { iceServers: servers, iceTransportPolicy: 'relay' } : { iceServers: servers };
            const hasRelay = servers.some((s) => {
                const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
                return urls.some((u) => typeof u === 'string' && /^turns?:/i.test(u));
            });
            console.info('RTC ICE loaded from backend.', { hasRelay, serverCount: servers.length, forceRelay });
            return config;
        }
        return forceRelay ? { ...defaultRtcConfig, iceTransportPolicy: 'relay' } : { ...defaultRtcConfig };
    } catch (e) {
        console.warn(
            'RTC ICE config fallback (using STUN-only). Ensure getRtcIceServers is deployed and callable (CORS/auth).',
            e
        );
        return forceRelay ? { ...defaultRtcConfig, iceTransportPolicy: 'relay' } : { ...defaultRtcConfig };
    }
}

