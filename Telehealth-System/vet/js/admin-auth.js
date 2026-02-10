/** Televet Health — Admin Auth Guard (vet only) */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';
    const CACHE = 'telehealthProfileCache:', UID = 'telehealthLastUid';
    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to logout?')) return;
        e.target.disabled = true;
        try {
            const uid = sessionStorage.getItem(UID);
            if (uid) sessionStorage.removeItem(CACHE + uid);
            sessionStorage.removeItem(UID);
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace('../auth.html#login');
        } catch (err) { console.error('Logout error:', err); alert('Logout failed. Please try again.'); e.target.disabled = false; }
    });
    onAuthStateChanged(auth, async (user) => {
        if (!user) return window.location.replace(sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login');
        if ((await getDoc(doc(db, 'users', user.uid))).data()?.role !== 'vet') return window.location.replace('../petowner/dashboard.html');
        sessionStorage.removeItem('telehealthLoggedOut');
        document.body.style.visibility = 'visible';
        document.body.classList.remove('profile-loading', 'profile-loading-full-page');
        document.querySelector('.profile-loading-overlay')?.setAttribute('aria-hidden', 'true');
    });
})();
