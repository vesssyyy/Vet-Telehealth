/**
 * Televet Health — SPA Router
 *
 * Intercepts in-portal link clicks and swaps page content via fetch +
 * DOMParser, keeping the sidebar, header, and bottom-nav persistent.
 * Provides browser back/forward support through the History API.
 *
 * Used by both petowner and vet portals.
 * Pages with a different shell (video-call.html) are excluded and
 * cause a normal full-page navigation.
 */
(function () {
    'use strict';

    var path = window.location.pathname;
    if (path.indexOf('/pages/petowner/') === -1 && path.indexOf('/pages/vet/') === -1) return;

    window.__spaRouterActive = true;

    /* ── Configuration ──────────────────────────────────────────────── */

    var EXCLUDED_FILES  = { 'video-call.html': true };
    var COMMON_SCRIPTS  = [
        'sidebar.js', 'route-guard.js', 'spa-router.js',
        'petowner-profile.js', 'vet-profile.js'
    ];
    var CDN_HOSTS       = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

    /* ── State ──────────────────────────────────────────────────────── */

    var _navigating     = false;
    var _abortCtrl      = null;
    var _loadedCdnSrcs  = {};
    var _dclPatched     = false;

    /* ── Helpers ────────────────────────────────────────────────────── */

    function filename(url) {
        return (url || '').split('/').pop().split('?')[0].split('#')[0];
    }

    function includes(src, list) {
        for (var i = 0; i < list.length; i++) {
            if (src.indexOf(list[i]) !== -1) return true;
        }
        return false;
    }

    function isCommon(src) { return includes(src, COMMON_SCRIPTS); }
    function isCdn(src)    { return includes(src, CDN_HOSTS); }

    function isSamePortalLink(href) {
        if (!href) return false;
        var c = href.charAt(0);
        if (c === '#') return false;
        if (href.lastIndexOf('javascript:', 0) === 0) return false;
        if (href.lastIndexOf('mailto:', 0) === 0) return false;
        if (href.indexOf('../') !== -1) return false;
        if (href.indexOf('://') !== -1 && href.indexOf(location.host) === -1) return false;
        var fn = filename(href);
        if (!fn || fn.indexOf('.html') === -1) return false;
        if (EXCLUDED_FILES[fn]) return false;
        return true;
    }

    function resolve(href) {
        var a = document.createElement('a');
        a.href = href;
        return a.href;
    }

    function isBodyHiddenStyle(el) {
        var t = (el.textContent || '').replace(/\s+/g, '');
        return t === 'body{visibility:hidden;}' || t === 'body{visibility:hidden}';
    }

    /* ── DOMContentLoaded shim ─────────────────────────────────────── *
     * After the first SPA navigation the document is already loaded,   *
     * but newly-injected scripts may register DOMContentLoaded          *
     * listeners. This shim runs them immediately.                       *
     * ─────────────────────────────────────────────────────────────────  */

    function patchDCL() {
        if (_dclPatched) return;
        _dclPatched = true;
        var orig = document.addEventListener;
        document.addEventListener = function (type, fn, opts) {
            if (type === 'DOMContentLoaded') {
                requestAnimationFrame(function () {
                    try { fn.call(document, new Event('DOMContentLoaded')); } catch (e) { /* skip */ }
                });
                return;
            }
            return orig.call(this, type, fn, opts);
        };
    }

    /* ── Progress bar ──────────────────────────────────────────────── */

    (function injectCSS() {
        var s = document.createElement('style');
        s.textContent =
            '.spa-progress{position:fixed;top:0;left:0;width:0;height:3px;z-index:99999;' +
            'pointer-events:none;background:linear-gradient(90deg,#4f9cf7,#2c5f7d);transition:width .3s ease}' +
            '.spa-progress--active{width:80%;transition:width 12s cubic-bezier(.08,.05,.1,.06)}' +
            '.spa-progress--done{width:100%;opacity:0;transition:width .12s ease,opacity .25s ease .12s}' +
            '.spa-enter{animation:spaEnter .2s ease both}' +
            '@keyframes spaEnter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}';
        document.head.appendChild(s);
    })();

    function showProgress() {
        var bar = document.querySelector('.spa-progress');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'spa-progress';
            bar.setAttribute('aria-hidden', 'true');
            document.body.appendChild(bar);
        }
        bar.classList.remove('spa-progress--done');
        void bar.offsetWidth;
        bar.classList.add('spa-progress--active');
    }

    function hideProgress() {
        var bar = document.querySelector('.spa-progress');
        if (!bar) return;
        bar.classList.remove('spa-progress--active');
        bar.classList.add('spa-progress--done');
        setTimeout(function () { if (bar.parentNode) bar.remove(); }, 500);
    }

    /* ── CSS diffing ───────────────────────────────────────────────── */

    function hrefOf(l) { return l.getAttribute('href') || ''; }

    function diffCSS(newDoc) {
        var cur = [].slice.call(document.querySelectorAll('head link[rel="stylesheet"]'));
        var nxt = [].slice.call(newDoc.querySelectorAll('head link[rel="stylesheet"]'));
        var curSet = {}; cur.forEach(function (l) { curSet[hrefOf(l)] = l; });
        var nxtSet = {}; nxt.forEach(function (l) { nxtSet[hrefOf(l)] = l; });
        return {
            toRemove: cur.filter(function (l) { return !nxtSet[hrefOf(l)]; }),
            toAdd:    nxt.filter(function (l) { return !curSet[hrefOf(l)]; })
        };
    }

    /* ── Content extraction ────────────────────────────────────────── */

    function extractPage(doc) {
        var main   = doc.querySelector('main');
        var header = main ? main.querySelector('.app-top-header') : null;

        var contentNodes = [];
        if (main) {
            var past = !header;
            for (var i = 0; i < main.children.length; i++) {
                if (main.children[i] === header) { past = true; continue; }
                if (past) contentNodes.push(main.children[i]);
            }
        }

        var extras = [];
        if (doc.body) {
            for (var j = 0; j < doc.body.children.length; j++) {
                var el  = doc.body.children[j];
                var tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'main') continue;
                if (el.classList.contains('sidebar-overlay') || el.classList.contains('sidebar')) continue;
                if (el.classList.contains('bottom-nav')) continue;
                if (tag === 'nav' && el.getAttribute('aria-label') === 'Main navigation') continue;
                if (el.classList.contains('profile-loading-overlay')) continue;
                extras.push(el);
            }
        }

        var scripts = [];
        var allScripts = doc.querySelectorAll('body script');
        for (var k = 0; k < allScripts.length; k++) {
            var s   = allScripts[k];
            var src = s.getAttribute('src') || '';
            if (src && isCommon(src)) continue;
            if (src && isCdn(src) && _loadedCdnSrcs[src]) continue;
            if (!src && !(s.textContent || '').trim()) continue;
            scripts.push(s);
        }

        var inlineStyles = [];
        var headStyles = doc.querySelectorAll('head style');
        for (var m = 0; m < headStyles.length; m++) {
            if (!isBodyHiddenStyle(headStyles[m])) inlineStyles.push(headStyles[m]);
        }

        return {
            title:        (doc.querySelector('title') || {}).textContent || document.title,
            bodyClass:    doc.body ? doc.body.className : '',
            mainClass:    main ? main.className : 'main-content',
            contentNodes: contentNodes,
            extras:       extras,
            scripts:      scripts,
            inlineStyles: inlineStyles
        };
    }

    /* ── Script loading ────────────────────────────────────────────── */

    function loadScripts(defs, done) {
        var remaining = defs.length;
        if (!remaining) { done(); return; }

        function tick() { if (--remaining <= 0) done(); }

        defs.forEach(function (orig) {
            var s   = document.createElement('script');
            var src = orig.getAttribute('src');

            if (orig.type) s.type = orig.type;

            if (src) {
                if (s.type === 'module') {
                    try {
                        var u = new URL(src, window.location.href);
                        u.searchParams.set('_spa', Date.now());
                        s.src = u.href;
                    } catch (_) { s.src = src; }
                } else {
                    s.src = src;
                    if (isCdn(src)) _loadedCdnSrcs[src] = true;
                }
                s.onload = s.onerror = tick;
            } else {
                s.textContent = orig.textContent;
                tick();
            }

            for (var i = 0; i < orig.attributes.length; i++) {
                var a = orig.attributes[i];
                if (a.name !== 'src' && a.name !== 'type') s.setAttribute(a.name, a.value);
            }

            s.setAttribute('data-spa-loaded', '');
            document.body.appendChild(s);
        });
    }

    /* ── Active-nav highlight ──────────────────────────────────────── */

    function updateNav() {
        var page = filename(window.location.pathname);
        document.querySelectorAll('.nav-item').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('href') === page);
        });
        document.querySelectorAll('.bottom-nav-item').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('href') === page);
        });
    }

    /* ── Navigate ──────────────────────────────────────────────────── */

    function navigate(url, opts) {
        opts = opts || {};
        if (_navigating) return;
        if (filename(url) === filename(window.location.href) && !opts.force) return;

        _navigating = true;
        if (_abortCtrl) try { _abortCtrl.abort(); } catch (_) { /* ok */ }
        _abortCtrl = new AbortController();

        showProgress();
        patchDCL();
        window.dispatchEvent(new CustomEvent('spa:beforeleave'));

        var main = document.querySelector('main');

        fetch(url, { signal: _abortCtrl.signal })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function (html) {
                var newDoc = new DOMParser().parseFromString(html, 'text/html');
                if (!newDoc.querySelector('main') || !newDoc.querySelector('.sidebar')) {
                    window.location.href = url;
                    return;
                }

                var data   = extractPage(newDoc);
                var header = main ? main.querySelector('.app-top-header') : null;

                /* 1 — Remove old main content (keep header) */
                if (main) {
                    var rm = []; var past = !header;
                    for (var i = 0; i < main.children.length; i++) {
                        if (main.children[i] === header) { past = true; continue; }
                        if (past) rm.push(main.children[i]);
                    }
                    rm.forEach(function (n) { n.remove(); });
                }

                /* 2 — Remove old body-level extras */
                var oldX = [];
                for (var j = 0; j < document.body.children.length; j++) {
                    var ch  = document.body.children[j];
                    var tag = ch.tagName.toLowerCase();
                    if (tag === 'script' || tag === 'main') continue;
                    if (ch.classList.contains('sidebar-overlay') || ch.classList.contains('sidebar')) continue;
                    if (ch.classList.contains('bottom-nav')) continue;
                    if (tag === 'nav' && ch.getAttribute('aria-label') === 'Main navigation') continue;
                    if (ch.classList.contains('profile-loading-overlay')) continue;
                    if (ch.classList.contains('spa-progress')) continue;
                    oldX.push(ch);
                }
                oldX.forEach(function (n) { n.remove(); });

                /* 3 — Remove previously loaded SPA scripts */
                document.querySelectorAll('script[data-spa-loaded]').forEach(function (s) { s.remove(); });

                /* 3b — Inline-hide persistent overlays before CSS swap removes their display:none rules */
                var plo = document.querySelector('.profile-loading-overlay');
                if (plo) plo.style.display = 'none';

                /* 4 — Swap stylesheets */
                var css = diffCSS(newDoc);
                css.toRemove.forEach(function (l) { l.remove(); });
                var cssReady = css.toAdd.map(function (l) {
                    return new Promise(function (ok) {
                        var nl  = document.createElement('link');
                        nl.rel  = 'stylesheet';
                        nl.href = l.getAttribute('href');
                        nl.onload = nl.onerror = ok;
                        document.head.appendChild(nl);
                    });
                });

                /* 5 — Swap inline <style> */
                document.querySelectorAll('head style[data-spa-style]').forEach(function (s) { s.remove(); });
                data.inlineStyles.forEach(function (st) {
                    var cl = st.cloneNode(true);
                    cl.setAttribute('data-spa-style', '');
                    document.head.appendChild(cl);
                });

                /* 6 — Update body / main attributes (strip loading classes to avoid flash) */
                document.body.className = data.bodyClass
                    .replace(/\bprofile-loading-full-page\b/g, '')
                    .replace(/\bprofile-loading\b/g, '')
                    .replace(/\bdashboard-waiting\b/g, '')
                    .trim();
                document.body.style.visibility = 'visible';
                document.body.style.opacity    = '1';
                if (main) main.className = data.mainClass;

                /* 7 — Title & URL */
                document.title = data.title;
                if (opts.pushState !== false) {
                    history.pushState({ spaUrl: url }, data.title, url);
                } else {
                    history.replaceState({ spaUrl: url }, data.title, url);
                }

                /* 8 — Active nav + scroll */
                updateNav();
                window.scrollTo(0, 0);
                if (main) main.scrollTop = 0;

                /* 9 — Wait for CSS, THEN inject content, fade in & run scripts.
                 *     This prevents modals/overlays from flashing unstyled. */
                Promise.all(cssReady).then(function () {

                    /* 9a — Inject new main content */
                    data.contentNodes.forEach(function (n) {
                        main.appendChild(document.importNode(n, true));
                    });

                    /* 9b — Inject new body-level extras (before bottom-nav) */
                    var bottomNav = document.querySelector('.bottom-nav');
                    data.extras.forEach(function (n) {
                        var imp = document.importNode(n, true);
                        if (bottomNav && bottomNav.parentNode) {
                            document.body.insertBefore(imp, bottomNav);
                        } else {
                            document.body.appendChild(imp);
                        }
                    });

                    /* 9c — Clean up loading states (route-guard won't re-run on SPA nav) */
                    document.body.classList.remove(
                        'profile-loading', 'profile-loading-full-page', 'dashboard-waiting'
                    );
                    document.body.classList.add('dashboard-ready');

                    var dl = document.getElementById('dashboard-loading');
                    if (dl) dl.setAttribute('aria-hidden', 'true');

                    var dc = document.getElementById('dashboard-content');
                    if (dc) dc.classList.remove('is-loading');

                    var al = document.getElementById('appointments-loading');
                    if (al) {
                        al.setAttribute('aria-hidden', 'true');
                        al.classList.add('is-hidden');
                    }

                    main.querySelectorAll('.content-loading-overlay').forEach(function (el) {
                        el.setAttribute('aria-hidden', 'true');
                    });

                    /* 9d — Animate new content in (header stays untouched) */
                    if (main) {
                        var header2 = main.querySelector('.app-top-header');
                        for (var ci = 0; ci < main.children.length; ci++) {
                            if (main.children[ci] !== header2) {
                                main.children[ci].classList.add('spa-enter');
                            }
                        }
                    }

                    /* 9e — Load page scripts */
                    loadScripts(data.scripts, function () {
                        window.dispatchEvent(new CustomEvent('spa:afternavigate'));
                        _navigating = false;
                        hideProgress();
                    });
                });
            })
            .catch(function (err) {
                if (err.name !== 'AbortError') {
                    console.error('[SPA Router]', err);
                    window.location.href = url;
                }
                _navigating = false;
                hideProgress();
            });
    }

    /* ── Click interception (capture phase) ────────────────────────── */

    document.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var link = e.target.closest ? e.target.closest('a[href]') : null;
        if (!link) return;
        var href = link.getAttribute('href');
        if (!isSamePortalLink(href)) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(resolve(href));
    }, true);

    /* ── History popstate ──────────────────────────────────────────── */

    window.addEventListener('popstate', function (e) {
        if (e.state && e.state.spaUrl) {
            e.stopImmediatePropagation();
            navigate(e.state.spaUrl, { pushState: false });
        }
    });

    /* ── Public API ────────────────────────────────────────────────── */

    window.__spaNavigate = function (href) {
        if (!isSamePortalLink(href)) return false;
        navigate(resolve(href));
        return true;
    };

    /* ── Init ──────────────────────────────────────────────────────── */

    history.replaceState(
        { spaUrl: window.location.href },
        document.title,
        window.location.href
    );

    document.querySelectorAll('head style').forEach(function (s) {
        if (!isBodyHiddenStyle(s)) s.setAttribute('data-spa-style', '');
    });

    document.querySelectorAll('script[src]').forEach(function (s) {
        var src = s.getAttribute('src');
        if (isCdn(src)) _loadedCdnSrcs[src] = true;
    });
})();
