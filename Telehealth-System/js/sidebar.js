/**
 * Sidebar: mobile menu, active nav item, user initials
 */
(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', () => {
        const menuToggle = document.querySelector('.mobile-menu-toggle');
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');

        if (menuToggle && sidebar) {
            menuToggle.addEventListener('click', () => {
                sidebar.classList.toggle('active');
                menuToggle.classList.toggle('hidden');
                overlay?.classList.toggle('active');
            });
            overlay?.addEventListener('click', () => {
                sidebar.classList.remove('active');
                menuToggle.classList.remove('hidden');
                overlay.classList.remove('active');
            });
        }

        const currentPage = window.location.pathname.split('/').pop();
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.getAttribute('href') === currentPage);
        });

        const userName = document.querySelector('.user-name');
        const avatarInitials = document.getElementById('sidebar-avatar');
        const avatarImg = document.getElementById('sidebar-avatar-img');
        if (userName && avatarInitials && (!avatarImg?.getAttribute('src') || avatarImg.classList.contains('is-hidden'))) {
            avatarInitials.textContent = getInitials(userName.textContent);
        }
    });

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(' ');
        return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name[0] || '?').toUpperCase();
    }
})();
