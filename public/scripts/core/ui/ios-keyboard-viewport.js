/**
 * iOS Safari: keyboard + layout viewport mismatch causes window scroll, blank gaps, and extra
 * white space above the keyboard. Android: no-op (handlers bail early).
 * Exposes window.__telehealthIOSViewportUpdate for pages that toggle keyboard classes (e.g. messages).
 */
(function () {
    'use strict';

    function setVisualViewportVars() {
        try {
            var vv = window.visualViewport;
            var h = (vv && vv.height > 0) ? vv.height : window.innerHeight;
            document.documentElement.style.setProperty('--vh', h + 'px');
            var top = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
            var left = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0;
            document.documentElement.style.setProperty('--vv-top', top + 'px');
            document.documentElement.style.setProperty('--vv-left', left + 'px');
        } catch (_) { /* noop */ }
    }

    function isIOS() {
        return typeof navigator !== 'undefined' &&
            (/iP(ad|hone|od)/.test(navigator.userAgent || '') ||
                (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1));
    }

    function isMobileLayout() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    function stabilizeWindowScroll() {
        try {
            window.scrollTo(0, 0);
            if (document.documentElement) document.documentElement.scrollTop = 0;
            if (document.body) document.body.scrollTop = 0;
        } catch (_) { /* noop */ }
    }

    function isTextualField(el) {
        if (!el || !el.tagName) return false;
        var t = el.tagName;
        if (t === 'TEXTAREA' || t === 'SELECT') return true;
        if (t !== 'INPUT') return false;
        var ty = (el.getAttribute('type') || 'text').toLowerCase();
        return ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'range', 'color'].indexOf(ty) === -1;
    }

    function vvLooksKeyboardish() {
        var vv = window.visualViewport;
        if (!vv || vv.height <= 0) return false;
        return (window.innerHeight - vv.height) > 100;
    }

    /** Login/signup: must remain scrollable when the keyboard is open; do not lock html or force scroll. */
    function isAuthPage() {
        return document.body && document.body.classList.contains('auth-page');
    }

    function updateHtmlLock() {
        if (!isIOS() || !isMobileLayout()) {
            document.documentElement.classList.remove('ios-keyboard-viewport-active');
            return;
        }
        if (isAuthPage()) {
            document.documentElement.classList.remove('ios-keyboard-viewport-active');
            return;
        }
        var body = document.body;
        var msg = body && body.classList.contains('messages-page');
        var pay = body && body.classList.contains('payment-page');
        var lock = false;
        if (msg) {
            lock = !!(body.classList.contains('messages-keyboard-open') || vvLooksKeyboardish());
        } else if (pay) {
            lock = !!(body.classList.contains('payment-keyboard-open') || vvLooksKeyboardish());
        } else {
            var petKb = body.classList.contains('petowner-keyboard-open');
            var ae = document.activeElement;
            lock = !!petKb || vvLooksKeyboardish() || (isTextualField(ae) && ae !== document.body);
        }
        document.documentElement.classList.toggle('ios-keyboard-viewport-active', lock);
    }

    function onViewportEvent() {
        setVisualViewportVars();
        if (!isIOS() || !isMobileLayout()) return;
        if (isAuthPage()) {
            updateHtmlLock();
            return;
        }
        stabilizeWindowScroll();
        updateHtmlLock();
    }

    window.__telehealthIOSViewportUpdate = function () {
        updateHtmlLock();
        if (isIOS() && isMobileLayout() && !isAuthPage()) stabilizeWindowScroll();
    };

    document.addEventListener('focusin', function (e) {
        if (!isIOS() || !isMobileLayout()) return;
        if (!isTextualField(e.target)) return;
        if (isAuthPage()) {
            updateHtmlLock();
            return;
        }
        stabilizeWindowScroll();
        updateHtmlLock();
        setTimeout(stabilizeWindowScroll, 50);
        setTimeout(stabilizeWindowScroll, 160);
        setTimeout(stabilizeWindowScroll, 320);
    }, true);

    document.addEventListener('focusout', function () {
        if (!isIOS() || !isMobileLayout()) return;
        setTimeout(updateHtmlLock, 130);
    }, true);

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportEvent);
        window.visualViewport.addEventListener('scroll', onViewportEvent);
    }

    window.addEventListener('resize', function () {
        setVisualViewportVars();
        if (!isIOS()) {
            document.documentElement.classList.remove('ios-keyboard-viewport-active');
            return;
        }
        if (!isMobileLayout()) {
            document.documentElement.classList.remove('ios-keyboard-viewport-active');
            return;
        }
        updateHtmlLock();
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden && isIOS()) {
            document.documentElement.classList.remove('ios-keyboard-viewport-active');
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setVisualViewportVars();
            updateHtmlLock();
        });
    } else {
        setVisualViewportVars();
        updateHtmlLock();
    }
})();
