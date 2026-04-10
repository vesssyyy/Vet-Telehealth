// Shared sidebar: mobile menu, active nav, avatar initials, profile shortcut, --vh for mobile viewport.
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
            if (window.__spaNavigate && window.__spaNavigate('profile.html')) return;
            window.location.href = 'profile.html';
        });

        document.querySelectorAll('.nav-item[href="messages.html"]').forEach(function (el) {
            var dot = document.createElement('span');
            dot.className = 'nav-unread-dot';
            dot.setAttribute('aria-hidden', 'true');
            el.appendChild(dot);
        });
        document.querySelectorAll('.bottom-nav-item[href="messages.html"]').forEach(function (el) {
            var dot = document.createElement('span');
            dot.className = 'bottom-nav-unread-dot';
            dot.setAttribute('aria-hidden', 'true');
            el.appendChild(dot);
        });
    });

    // Fade in dynamically inserted images on load; skip if already decoded (e.g. from cache).
    (function () {
        var DUR = '0.35s';
        function prep(img) {
            if (img._siFade) return;
            img._siFade = true;
            if (img.complete && img.naturalWidth > 0 && img.style.opacity !== '0') return;
            if (!img.style.transition) img.style.transition = 'opacity ' + DUR + ' ease';
            if (img.style.opacity !== '0') img.style.opacity = '0';
            img.addEventListener('load', function () {
                requestAnimationFrame(function () { img.style.opacity = '1'; });
            }, { once: true });
            img.addEventListener('error', function () {
                img.style.opacity = '';
                img.style.transition = '';
            }, { once: true });
        }
        if (typeof MutationObserver === 'undefined') return;
        var obs = new MutationObserver(function (list) {
            for (var m = 0; m < list.length; m++) {
                var nodes = list[m].addedNodes;
                for (var n = 0; n < nodes.length; n++) {
                    var nd = nodes[n];
                    if (nd.nodeType !== 1) continue;
                    if (nd.tagName === 'IMG') prep(nd);
                    else if (nd.getElementsByTagName) {
                        var imgs = nd.getElementsByTagName('img');
                        for (var i = 0; i < imgs.length; i++) prep(imgs[i]);
                    }
                }
            }
        });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
        else document.addEventListener('DOMContentLoaded', function () {
            obs.observe(document.body, { childList: true, subtree: true });
        });
    })();
})();
