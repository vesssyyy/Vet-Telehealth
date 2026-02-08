/**
 * Televet Health — Dashboard Auth Guard
 */
import { auth } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

(function () {
    'use strict';

    let isLoggedIn = false;
    const CACHE_PREFIX = 'telehealthProfileCache:';
    const LAST_UID_KEY = 'telehealthLastUid';

    window.addEventListener('popstate', () => isLoggedIn && history.go(1));

    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to logout?')) return;

        e.target.disabled = true;
        try {
            const lastUid = sessionStorage.getItem(LAST_UID_KEY);
            if (lastUid) sessionStorage.removeItem(`${CACHE_PREFIX}${lastUid}`);
            sessionStorage.removeItem(LAST_UID_KEY);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace('../auth.html#login');
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });

    onAuthStateChanged(auth, (user) => {
        if (!user) return window.location.replace(sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login');

        sessionStorage.removeItem('telehealthLoggedOut');
        isLoggedIn = true;
        history.pushState(null, document.title, window.location.href);
        history.pushState(null, document.title, window.location.href);
        document.body.style.visibility = 'visible';
        document.body.classList.add('profile-loading');
    });

    window.addEventListener('profileReady', () => document.body.classList.remove('profile-loading'));
    setTimeout(() => document.body.classList.remove('profile-loading'), 5000);
})();
