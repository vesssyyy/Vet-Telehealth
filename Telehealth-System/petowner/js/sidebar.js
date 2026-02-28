/**
 * Sidebar: mobile menu, active nav, user initials, profile button
 * Also sets --vh for real mobile viewport (address bar reduces visible height).
 */
(function () {
    'use strict';

    function setVisualViewportHeight() {
        /* Use visualViewport.height when available so the layout shrinks when the keyboard opens on mobile. */
        var vh = (window.visualViewport && window.visualViewport.height > 0)
            ? window.visualViewport.height
            : window.innerHeight;
        document.documentElement.style.setProperty('--vh', vh + 'px');
    }

    setVisualViewportHeight();
    window.addEventListener('resize', setVisualViewportHeight);
    window.addEventListener('orientationchange', setVisualViewportHeight);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setVisualViewportHeight);
    }
    /* After address bar settles on mobile */
    window.addEventListener('load', function () { setTimeout(setVisualViewportHeight, 100); });

    const getInitials = (name) => {
        if (!name) return '?';
        const p = name.trim().split(' ');
        return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : (name[0] || '?').toUpperCase();
    };

    function init() {
        const menuToggle = document.querySelector('.mobile-menu-toggle');
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');

        if (menuToggle && sidebar) {
            const close = () => { sidebar.classList.remove('active'); menuToggle.classList.remove('hidden'); overlay?.classList.remove('active'); };
            menuToggle.addEventListener('click', () => { sidebar.classList.toggle('active'); menuToggle.classList.toggle('hidden'); overlay?.classList.toggle('active'); });
            overlay?.addEventListener('click', close);
        }

        const page = window.location.pathname.split('/').pop();
        document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.getAttribute('href') === page));
        document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.toggle('active', el.getAttribute('href') === page));

        const userName = document.querySelector('.user-name');
        const avatarInitials = document.getElementById('sidebar-avatar');
        const avatarImg = document.getElementById('sidebar-avatar-img');
        if (userName && avatarInitials && (!avatarImg?.getAttribute('src') || avatarImg.classList.contains('is-hidden')))
            avatarInitials.textContent = getInitials(userName.textContent);

        document.querySelector('.profile-header-btn')?.addEventListener('click', () => { window.location.href = 'profile.html'; });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
