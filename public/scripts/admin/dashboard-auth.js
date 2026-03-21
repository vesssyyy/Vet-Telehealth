/** Televet Health — Admin auth guard: only role === 'admin' can access; logout. */
import { auth, db } from '../core/firebase-config.js';
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
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.replace(sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login');
            return;
        }
        const snap = await getDoc(doc(db, 'users', user.uid));
        const role = snap.exists() ? snap.data()?.role : null;
        if (role !== 'admin') {
            window.location.replace('../vet/dashboard.html');
            return;
        }
        sessionStorage.removeItem('telehealthLoggedOut');
        document.body.style.visibility = 'visible';
        document.body.classList.remove('profile-loading', 'profile-loading-full-page');
        document.querySelector('.profile-loading-overlay')?.setAttribute('aria-hidden', 'true');
        const nameEl = document.getElementById('sidebar-name');
        const emailEl = document.getElementById('sidebar-email');
        const avatarEl = document.getElementById('sidebar-avatar');
        if (nameEl) nameEl.textContent = snap.data()?.displayName || user.displayName || 'Admin';
        if (emailEl) emailEl.textContent = user.email || '—';
        if (avatarEl) avatarEl.textContent = (snap.data()?.displayName || user.email || 'A').toString().trim().charAt(0).toUpperCase();
    });
})();
