/** Sidebar: mobile menu, active nav, profile button */
(function () {
    'use strict';
    const getInits = n => !n ? 'V' : (p => p.length >= 2 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : (n[0]||'V').toUpperCase())(n.trim().split(' '));

    document.addEventListener('DOMContentLoaded', () => {
        const menu = document.querySelector('.mobile-menu-toggle'), sidebar = document.querySelector('.sidebar'), overlay = document.querySelector('.sidebar-overlay');
        if (menu && sidebar) {
            const close = () => { sidebar.classList.remove('active'); menu.classList.remove('hidden'); overlay?.classList.remove('active'); };
            menu.addEventListener('click', () => { sidebar.classList.toggle('active'); menu.classList.toggle('hidden'); overlay?.classList.toggle('active'); });
            overlay?.addEventListener('click', close);
        }
        const page = window.location.pathname.split('/').pop();
        document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.getAttribute('href') === page));
        const name = document.querySelector('.user-name'), av = document.getElementById('sidebar-avatar'), img = document.getElementById('sidebar-avatar-img');
        if (name && av && (!img?.getAttribute('src') || img.classList.contains('is-hidden'))) av.textContent = getInits(name.textContent);
        document.querySelector('.profile-header-btn')?.addEventListener('click', () => window.location.href = 'profile.html');
    });
})();
