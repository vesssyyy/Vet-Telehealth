// Shared sidebar: mobile menu, active nav, avatar initials, profile shortcut, --vh for mobile viewport.
(function () {
    'use strict';

    function syncDashboardHeaderClass() {
        var main = document.querySelector('.main-content');
        if (!main) return;
        var hasDash = Boolean(document.querySelector('.dashboard-header'));
        main.classList.toggle('has-dashboard-header', hasDash);
        document.body.classList.toggle('has-dashboard-header', hasDash);
    }

    function setVisualViewportHeight() {
        var vv = window.visualViewport;
        var vh = (vv && vv.height > 0) ? vv.height : window.innerHeight;
        document.documentElement.style.setProperty('--vh', vh + 'px');
        // iOS Safari can shift the visual viewport when the URL bar / keyboard animates.
        // Expose offsets so fixed/sticky layouts can compensate if needed.
        var top = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
        var left = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0;
        document.documentElement.style.setProperty('--vv-top', top + 'px');
        document.documentElement.style.setProperty('--vv-left', left + 'px');
    }

    setVisualViewportHeight();
    window.addEventListener('resize', setVisualViewportHeight);
    window.addEventListener('orientationchange', setVisualViewportHeight);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setVisualViewportHeight);
        window.visualViewport.addEventListener('scroll', setVisualViewportHeight);
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
        syncDashboardHeaderClass();
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
        document.querySelectorAll('.nav-item[href="appointments.html"]').forEach(function (el) {
            var badge = document.createElement('span');
            badge.className = 'nav-unread-badge';
            badge.setAttribute('aria-hidden', 'true');
            el.appendChild(badge);
        });
        document.querySelectorAll('.bottom-nav-item[href="messages.html"]').forEach(function (el) {
            var dot = document.createElement('span');
            dot.className = 'bottom-nav-unread-dot';
            dot.setAttribute('aria-hidden', 'true');
            el.appendChild(dot);
        });

        function setAppointmentsBadgeCount(unreadCount) {
            var n = Number(unreadCount);
            if (!Number.isFinite(n)) n = 0;
            n = Math.max(0, Math.floor(n));
            var text = n > 9 ? '9+' : (n > 0 ? String(n) : '');
            document.querySelectorAll('.nav-item[href="appointments.html"] .nav-unread-badge').forEach(function (badge) {
                badge.textContent = text;
                badge.classList.toggle('is-visible', !!text);
                badge.setAttribute('aria-hidden', text ? 'false' : 'true');
            });
        }

        // Initial paint from persisted cache (module updates it in realtime).
        try {
            var cached = window.localStorage && window.localStorage.getItem('televet_appointments_unread');
            if (cached != null) setAppointmentsBadgeCount(parseInt(cached, 10));
        } catch (_) {}
        window.addEventListener('telehealth:appointments:unread', function (e) {
            setAppointmentsBadgeCount(e && e.detail ? e.detail.unreadCount : 0);
        });
    });

    var petownerMobileKbInitDone = false;
    /** Pet owner pages with bottom nav: bounded scroll + keyboard layout (excludes messages, payment, dashboard, video call). */
    function initPetownerMobileKeyboardChrome() {
        if (petownerMobileKbInitDone) return;
        petownerMobileKbInitDone = true;
        function mq768() {
            return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
        }
        function shouldUsePetownerScrollMode() {
            if (!mq768()) return false;
            if (!document.querySelector('.bottom-nav')) return false;
            if (document.body.classList.contains('messages-page')) return false;
            if (document.body.classList.contains('payment-page')) return false;
            if (document.body.classList.contains('video-call-fullscreen')) return false;
            if (document.body.classList.contains('has-dashboard-header') || document.querySelector('.dashboard-header')) return false;
            return true;
        }
        function applyScrollRootClass() {
            if (shouldUsePetownerScrollMode()) {
                document.documentElement.classList.add('petowner-scroll-root');
                document.body.classList.add('petowner-scroll-body');
            } else {
                document.documentElement.classList.remove('petowner-scroll-root');
                document.body.classList.remove('petowner-scroll-body');
                document.body.classList.remove('petowner-keyboard-open');
            }
        }
        function syncPetownerKeyboardOpen() {
            if (!shouldUsePetownerScrollMode()) {
                document.body.classList.remove('petowner-keyboard-open');
                return;
            }
            var vv = window.visualViewport;
            if (!vv) return;
            // Use a px threshold; percentage thresholds vary across iOS devices / orientations.
            var delta = window.innerHeight - vv.height;
            var keyboardLikelyOpen = vv.height > 0 && delta > 140;
            document.body.classList.toggle('petowner-keyboard-open', keyboardLikelyOpen);
            if (typeof window.__telehealthIOSViewportUpdate === 'function') {
                window.__telehealthIOSViewportUpdate();
            }
        }
        function onViewportChange() {
            syncDashboardHeaderClass();
            applyScrollRootClass();
            syncPetownerKeyboardOpen();
        }
        applyScrollRootClass();
        window.addEventListener('resize', onViewportChange);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) document.body.classList.remove('petowner-keyboard-open');
        });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncPetownerKeyboardOpen);
            window.visualViewport.addEventListener('scroll', syncPetownerKeyboardOpen);
        }
        syncPetownerKeyboardOpen();
    }
    document.addEventListener('DOMContentLoaded', initPetownerMobileKeyboardChrome);
    if (document.readyState !== 'loading') initPetownerMobileKeyboardChrome();

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

    /** Load iOS keyboard / viewport fix (same origin as this script). Android: no-op inside. */
    (function injectIosKeyboardViewport() {
        try {
            var sc = document.querySelector('script[src*="sidebar.js"]');
            if (!sc || !sc.src) return;
            var url = new URL(sc.src, window.location.href);
            url.pathname = url.pathname.replace(/\/app\/sidebar\.js$/i, '/ui/ios-keyboard-viewport.js');
            var x = document.createElement('script');
            x.src = url.toString();
            x.async = false;
            document.head.appendChild(x);
        } catch (e) { /* noop */ }
    })();
})();
