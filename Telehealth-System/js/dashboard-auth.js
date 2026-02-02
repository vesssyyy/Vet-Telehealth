/**
 * Televet Health — Dashboard Auth Guard
 */
import { auth } from './firebase-config.js';
import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

(function () {
    'use strict';

    let isLoggedIn = false;
    const logoutBtn = document.getElementById('logout-btn');

    function lockHistory() {
        history.pushState({ telehealthLock: true }, document.title, window.location.href);
        history.pushState({ telehealthLock: true }, document.title, window.location.href);
    }

    window.addEventListener('popstate', () => {
        if (isLoggedIn) {
            history.go(1);
        }
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            logoutBtn.disabled = true;
            try {
                sessionStorage.setItem('telehealthLoggedOut', 'true');
                await signOut(auth);
                isLoggedIn = false;
                window.location.replace('auth.html#login');
            } catch (error) {
                console.error('Logout error:', error);
                alert('Logout failed. Please try again.');
                logoutBtn.disabled = false;
            }
        });
    }

    onAuthStateChanged(auth, (user) => {
        const loggedOut = sessionStorage.getItem('telehealthLoggedOut') === 'true';
        if (!user) {
            const target = loggedOut ? 'index.html' : 'auth.html#login';
            window.location.replace(target);
            return;
        }

        sessionStorage.removeItem('telehealthLoggedOut');
        isLoggedIn = true;
        lockHistory();
        if (document.body) {
            document.body.style.visibility = 'visible';
        }
    });
})();
