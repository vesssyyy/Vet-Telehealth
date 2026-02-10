/** Televet Health — Vet Dashboard Auth Guard */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';
    const CACHE = 'telehealthProfileCache:', UID = 'telehealthLastUid', FIRST = 'telehealthVetFirstLoad';
    let loggedIn = false, profileDone = false;
    const isDash = () => (window.location.pathname || '').includes('dashboard');
    const isFirst = () => sessionStorage.getItem(FIRST) !== 'false';

    window.addEventListener('popstate', () => loggedIn && history.go(1));
    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to logout?')) return;
        e.target.disabled = true;
        try {
            const uid = sessionStorage.getItem(UID);
            if (uid) sessionStorage.removeItem(CACHE + uid);
            sessionStorage.removeItem(UID);
            sessionStorage.removeItem(FIRST);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace('../auth.html#login');
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });

    const reveal = () => {
        if (!profileDone) return;
        document.body.classList.remove('profile-loading', 'profile-loading-full-page', 'dashboard-waiting');
        if (isDash()) {
            document.body.classList.add('dashboard-ready');
            document.getElementById('dashboard-loading')?.setAttribute('aria-hidden', 'true');
            document.getElementById('dashboard-content')?.classList.remove('is-loading');
        }
        sessionStorage.setItem(FIRST, 'false');
    };

    onAuthStateChanged(auth, async (user) => {
        if (!user) return window.location.replace(sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login');
        const role = (await getDoc(doc(db, 'users', user.uid))).data()?.role;
        if (role !== 'vet') return window.location.replace('../petowner/dashboard.html');
        sessionStorage.removeItem('telehealthLoggedOut');
        loggedIn = true;
        profileDone = false;
        history.pushState(null, document.title, window.location.href);
        document.body.style.visibility = 'visible';
        if (isFirst()) document.body.classList.add('profile-loading', 'profile-loading-full-page');
        if (isDash()) setTimeout(() => !document.body.classList.contains('dashboard-ready') && document.body.classList.add('dashboard-waiting'), 150);
    });
    window.addEventListener('profileReady', () => { profileDone = true; reveal(); });
    setTimeout(() => { profileDone = true; if (isDash()) reveal(); }, 5000);
})();
