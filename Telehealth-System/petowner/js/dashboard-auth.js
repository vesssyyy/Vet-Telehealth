/**
 * Televet Health — Dashboard Auth Guard
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';

    const CACHE_PREFIX = 'telehealthProfileCache:';
    const LAST_UID_KEY = 'telehealthLastUid';
    const FIRST_LOAD_KEY = 'telehealthFirstLoad';
    const DASHBOARD_READY_DELAY = 150;
    const FALLBACK_REVEAL_MS = 5000;

    let isLoggedIn = false;
    let profileReadyDone = false;
    let petsReadyDone = false;

    const isDashboard = () => (window.location.pathname || '').includes('dashboard');
    const isProfilePage = () => (window.location.pathname || '').includes('profile');
    const isFirstLoad = () => sessionStorage.getItem(FIRST_LOAD_KEY) !== 'false';

    window.addEventListener('popstate', () => isLoggedIn && history.go(1));

    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to logout?')) return;
        e.target.disabled = true;
        try {
            const lastUid = sessionStorage.getItem(LAST_UID_KEY);
            if (lastUid) sessionStorage.removeItem(`${CACHE_PREFIX}${lastUid}`);
            sessionStorage.removeItem(LAST_UID_KEY);
            sessionStorage.removeItem(FIRST_LOAD_KEY);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace('../auth.html#login');
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });

    function tryRemoveLoading() {
        if (isDashboard()) {
            if (!profileReadyDone || !petsReadyDone) return;
            document.body.classList.remove('profile-loading', 'profile-loading-full-page', 'dashboard-waiting');
            document.body.classList.add('dashboard-ready');
            document.getElementById('dashboard-loading')?.setAttribute('aria-hidden', 'true');
            document.getElementById('dashboard-content')?.classList.remove('is-loading');
        } else if (profileReadyDone) {
            document.body.classList.remove('profile-loading', 'profile-loading-full-page');
        } else return;
        sessionStorage.setItem(FIRST_LOAD_KEY, 'false');
    }

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            const goTo = sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login';
            return window.location.replace(goTo);
        }
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (!userDoc.exists()) {
            await signOut(auth);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            window.location.replace('../auth.html#login');
            return;
        }
        const role = userDoc.data().role;
        if (role === 'vet') {
            window.location.replace('../vet/dashboard.html');
            return;
        }
        if (userDoc.data().disabled) {
            await signOut(auth);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            window.location.replace('../auth.html?disabled=1#login');
            return;
        }
        sessionStorage.removeItem('telehealthLoggedOut');
        isLoggedIn = true;
        profileReadyDone = false;
        petsReadyDone = false;
        history.pushState(null, document.title, window.location.href);
        history.pushState(null, document.title, window.location.href);
        document.body.style.visibility = 'visible';

        if (isFirstLoad()) document.body.classList.add('profile-loading', 'profile-loading-full-page');
        else if (!isDashboard() && !isProfilePage()) document.body.classList.add('profile-loading');

        if (isDashboard()) {
            setTimeout(() => {
                if (!document.body.classList.contains('dashboard-ready')) document.body.classList.add('dashboard-waiting');
            }, DASHBOARD_READY_DELAY);
        }
    });

    window.addEventListener('profileReady', () => { profileReadyDone = true; tryRemoveLoading(); });
    window.addEventListener('petsReady', () => { petsReadyDone = true; tryRemoveLoading(); });
    setTimeout(() => {
        profileReadyDone = true;
        petsReadyDone = true;
        if (isDashboard()) tryRemoveLoading();
    }, FALLBACK_REVEAL_MS);
})();
