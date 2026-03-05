/**
 * Televet Health — Shared Sidebar
 * Handles: mobile menu toggle, active nav highlighting,
 * sidebar avatar initials, profile button, and mobile viewport height fix.
 * Used by all portals (petowner, vet, admin).
 */
(function () {
    'use strict';

    function setVisualViewportHeight() {
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
    window.addEventListener('load', function () { setTimeout(setVisualViewportHeight, 100); });

    function getInitials(name, fallback) {
        if (!name) return fallback || '?';
        var parts = name.trim().split(/\s+/).filter(Boolean);
        return parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : (name[0] || fallback || '?').toUpperCase();
    }

    document.addEventListener('DOMContentLoaded', function () {
        var menuToggle = document.querySelector('.mobile-menu-toggle');
        var sidebar = document.querySelector('.sidebar');
        var overlay = document.querySelector('.sidebar-overlay');

        if (menuToggle && sidebar) {
            var close = function () {
                sidebar.classList.remove('active');
                menuToggle.classList.remove('hidden');
                if (overlay) overlay.classList.remove('active');
            };
            menuToggle.addEventListener('click', function () {
                sidebar.classList.toggle('active');
                menuToggle.classList.toggle('hidden');
                if (overlay) overlay.classList.toggle('active');
            });
            if (overlay) overlay.addEventListener('click', close);
        }

        var page = window.location.pathname.split('/').pop();
        document.querySelectorAll('.nav-item').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('href') === page);
        });
        document.querySelectorAll('.bottom-nav-item').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('href') === page);
        });

        var userName = document.querySelector('.user-name');
        var avatarInitials = document.getElementById('sidebar-avatar');
        var avatarImg = document.getElementById('sidebar-avatar-img');
        if (userName && avatarInitials && (!avatarImg?.getAttribute('src') || avatarImg.classList.contains('is-hidden'))) {
            avatarInitials.textContent = getInitials(userName.textContent);
        }

        document.querySelector('.profile-header-btn')?.addEventListener('click', function () {
            window.location.href = 'profile.html';
        });
    });
})();
