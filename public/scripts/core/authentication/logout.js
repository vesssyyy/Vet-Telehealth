/**
 * Televet Health — Shared logout (profile cache + session + Firebase signOut).
 */
import { signOut } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';

const CACHE_PREFIX = 'telehealthProfileCache:';
const LAST_UID_KEY = 'telehealthLastUid';

/**
 * @param {import('firebase/auth').Auth} auth
 * @param {{ firstLoadKey?: string|null }} [opts] - sessionStorage key cleared on logout (pet owner / vet first-load flags)
 */
export function attachLogoutButton(auth, opts = {}) {
    const { firstLoadKey = null } = opts;
    const appBasePrefix = (() => {
        const p = window.location.pathname || '';
        return p === '/public' || p.startsWith('/public/') ? '/public' : '';
    })();
    const withAppBase = (path) => `${appBasePrefix}${path}`;
    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to logout?')) return;
        e.target.disabled = true;
        try {
            const lastUid = sessionStorage.getItem(LAST_UID_KEY);
            if (lastUid) sessionStorage.removeItem(`${CACHE_PREFIX}${lastUid}`);
            sessionStorage.removeItem(LAST_UID_KEY);
            if (firstLoadKey) sessionStorage.removeItem(firstLoadKey);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace(`${withAppBase('/auth.html')}#login`);
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });
}
