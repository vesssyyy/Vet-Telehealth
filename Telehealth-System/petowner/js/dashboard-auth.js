/**
 * Televet Health — Dashboard Auth Guard
 */
import { auth } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

(function () {
    'use strict';

    let isLoggedIn = false;

    // Prevent back navigation when logged in
    window.addEventListener('popstate', () => isLoggedIn && history.go(1));

    // Logout handler
    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        // Ask for confirmation before logging out
        if (!confirm('Are you sure you want to logout?')) {
            return;
        }
        
        e.target.disabled = true;
        try {
            // Clear profile cache to prevent flicker on account switch
            const lastUid = sessionStorage.getItem('telehealthLastUid');
            if (lastUid) {
                sessionStorage.removeItem(`telehealthProfileCache:${lastUid}`);
                sessionStorage.removeItem('telehealthLastUid');
            }
            
            sessionStorage.setItem('telehealthLoggedOut', 'true');
            await signOut(auth);
            window.location.replace('../auth.html#login');
        } catch (error) {
            console.error('Logout error:', error);
            alert('Logout failed. Please try again.');
            e.target.disabled = false;
        }
    });

    // Auth state observer: show loading overlay until profile is ready (prevents sidebar flicker)
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            const target = sessionStorage.getItem('telehealthLoggedOut') === 'true' ? '../index.html' : '../auth.html#login';
            return window.location.replace(target);
        }

        sessionStorage.removeItem('telehealthLoggedOut');
        isLoggedIn = true;
        history.pushState(null, document.title, window.location.href);
        history.pushState(null, document.title, window.location.href);
        document.body.style.visibility = 'visible';
        document.body.classList.add('profile-loading');
    });

    // Hide loading overlay when profile is ready (profile.js fires this)
    window.addEventListener('profileReady', () => {
        document.body.classList.remove('profile-loading');
    });

    // Fallback: if profile never signals ready (e.g. script error), show page after 5s
    setTimeout(() => {
        if (document.body.classList.contains('profile-loading')) {
            document.body.classList.remove('profile-loading');
        }
    }, 5000);
})();
