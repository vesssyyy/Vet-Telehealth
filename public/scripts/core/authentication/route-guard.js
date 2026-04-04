/**
 * Televet Health — Portal route guard (pet owner / vet / admin) from URL path.
 */
import { auth, db } from '../firebase/firebase-config.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { attachLogoutButton } from './logout.js';

(function () {
    'use strict';

    const FIRST_LOAD_PETOWNER = 'telehealthFirstLoad';
    const FIRST_LOAD_VET = 'telehealthVetFirstLoad';
    const DASHBOARD_READY_DELAY = 150;
    const FALLBACK_REVEAL_MS = 5000;
    const appBasePrefix = (() => {
        const p = window.location.pathname || '';
        return p === '/public' || p.startsWith('/public/') ? '/public' : '';
    })();
    const withAppBase = (path) => `${appBasePrefix}${path}`;

    /** @returns {'petowner'|'vet'|'admin'} */
    function detectPortalRole() {
        const p = window.location.pathname || '';
        if (p.includes('/pages/admin/')) return 'admin';
        if (p.includes('/pages/vet/')) return 'vet';
        if (p.includes('/pages/petowner/')) return 'petowner';
        return 'petowner';
    }

    const portal = detectPortalRole();

    if (portal === 'petowner') {
        let isLoggedIn = false;
        let profileReadyDone = false;
        let petsReadyDone = false;

        const isDashboard = () => (window.location.pathname || '').includes('dashboard');
        const isProfilePage = () => (window.location.pathname || '').includes('profile');
        const isFirstLoad = () => sessionStorage.getItem(FIRST_LOAD_PETOWNER) !== 'false';

        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.spaUrl) return;
            if (isLoggedIn) history.go(1);
        });
        attachLogoutButton(auth, { firstLoadKey: FIRST_LOAD_PETOWNER });

        function tryRemoveLoading() {
            if (isDashboard()) {
                if (!profileReadyDone || !petsReadyDone) return;
                document.body.classList.remove('profile-loading', 'profile-loading-full-page', 'dashboard-waiting');
                document.body.classList.add('dashboard-ready');
                document.getElementById('dashboard-loading')?.setAttribute('aria-hidden', 'true');
                document.getElementById('dashboard-content')?.classList.remove('is-loading');
            } else if (profileReadyDone) {
                document.body.classList.remove('profile-loading', 'profile-loading-full-page');
            } else return;
            sessionStorage.setItem(FIRST_LOAD_PETOWNER, 'false');
        }

        onAuthStateChanged(auth, async () => {
            await auth.authStateReady();
            const user = auth.currentUser;
            if (!user) {
                const goTo = sessionStorage.getItem('telehealthLoggedOut') === 'true'
                    ? withAppBase('/index.html')
                    : `${withAppBase('/auth.html')}#login`;
                return window.location.replace(goTo);
            }
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (!userDoc.exists()) {
                await signOut(auth);
                sessionStorage.setItem('telehealthLoggedOut', 'true');
                window.location.replace(`${withAppBase('/auth.html')}#login`);
                return;
            }
            const role = userDoc.data().role;
            if (role === 'vet') {
                window.location.replace('../vet/dashboard.html');
                return;
            }
            if (userDoc.data().disabled) {
                await signOut(auth);
                sessionStorage.setItem('telehealthLoggedOut', 'true');
                window.location.replace(`${withAppBase('/auth.html')}?disabled=1#login`);
                return;
            }
            sessionStorage.removeItem('telehealthLoggedOut');
            isLoggedIn = true;
            profileReadyDone = false;
            petsReadyDone = false;
            if (!window.__spaRouterActive) {
                history.pushState(null, document.title, window.location.href);
                history.pushState(null, document.title, window.location.href);
            }
            document.body.style.opacity = '0';
            document.body.style.visibility = 'visible';
            requestAnimationFrame(function () {
                document.body.style.transition = 'opacity 0.3s ease';
                document.body.style.opacity = '1';
            });

            import('../messaging/message-notifications.js').then(function (mod) {
                mod.initMessageNotifications({ role: 'petowner', uid: user.uid });
            }).catch(function () {});

            if (isFirstLoad()) document.body.classList.add('profile-loading', 'profile-loading-full-page');
            else if (!isDashboard() && !isProfilePage()) document.body.classList.add('profile-loading');

            if (isDashboard()) {
                setTimeout(() => {
                    if (!document.body.classList.contains('dashboard-ready')) document.body.classList.add('dashboard-waiting');
                }, DASHBOARD_READY_DELAY);
            }
        });

        window.addEventListener('profileReady', () => { profileReadyDone = true; tryRemoveLoading(); });
        window.addEventListener('petsReady', () => { petsReadyDone = true; tryRemoveLoading(); });
        setTimeout(() => {
            profileReadyDone = true;
            petsReadyDone = true;
            tryRemoveLoading();
        }, FALLBACK_REVEAL_MS);
        return;
    }

    if (portal === 'vet') {
        let loggedIn = false;
        let profileDone = false;
        const isDash = () => (window.location.pathname || '').includes('dashboard');
        const isFirst = () => sessionStorage.getItem(FIRST_LOAD_VET) !== 'false';

        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.spaUrl) return;
            if (loggedIn) history.go(1);
        });
        attachLogoutButton(auth, { firstLoadKey: FIRST_LOAD_VET });

        const reveal = () => {
            if (!profileDone) return;
            document.body.classList.remove('profile-loading', 'profile-loading-full-page', 'dashboard-waiting');
            if (isDash()) {
                document.body.classList.add('dashboard-ready');
                document.getElementById('dashboard-loading')?.setAttribute('aria-hidden', 'true');
                document.getElementById('dashboard-content')?.classList.remove('is-loading');
            }
            sessionStorage.setItem(FIRST_LOAD_VET, 'false');
        };

        onAuthStateChanged(auth, async (user) => {
            if (!user) {
                const goTo = sessionStorage.getItem('telehealthLoggedOut') === 'true'
                    ? withAppBase('/index.html')
                    : `${withAppBase('/auth.html')}#login`;
                return window.location.replace(goTo);
            }
            const role = (await getDoc(doc(db, 'users', user.uid))).data()?.role;
            if (role !== 'vet') return window.location.replace('../petowner/dashboard.html');
            sessionStorage.removeItem('telehealthLoggedOut');
            loggedIn = true;
            profileDone = false;
            if (!window.__spaRouterActive) {
                history.pushState(null, document.title, window.location.href);
            }
            document.body.style.opacity = '0';
            document.body.style.visibility = 'visible';
            requestAnimationFrame(function () {
                document.body.style.transition = 'opacity 0.3s ease';
                document.body.style.opacity = '1';
            });

            import('../messaging/message-notifications.js').then(function (mod) {
                mod.initMessageNotifications({ role: 'vet', uid: user.uid });
            }).catch(function () {});

            if (isFirst()) document.body.classList.add('profile-loading', 'profile-loading-full-page');
            if (isDash()) setTimeout(() => !document.body.classList.contains('dashboard-ready') && document.body.classList.add('dashboard-waiting'), 150);
        });
        window.addEventListener('profileReady', () => { profileDone = true; reveal(); });
        setTimeout(() => { profileDone = true; if (isDash()) reveal(); }, 5000);
        return;
    }

    // admin
    attachLogoutButton(auth, {});

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            const goTo = sessionStorage.getItem('telehealthLoggedOut') === 'true'
                ? withAppBase('/index.html')
                : `${withAppBase('/auth.html')}#login`;
            window.location.replace(goTo);
            return;
        }
        const snap = await getDoc(doc(db, 'users', user.uid));
        const role = snap.exists() ? snap.data()?.role : null;
        if (role !== 'admin') {
            window.location.replace('../vet/dashboard.html');
            return;
        }
        sessionStorage.removeItem('telehealthLoggedOut');
        document.body.style.opacity = '0';
        document.body.style.visibility = 'visible';
        requestAnimationFrame(function () {
            document.body.style.transition = 'opacity 0.3s ease';
            document.body.style.opacity = '1';
        });
        document.body.classList.remove('profile-loading', 'profile-loading-full-page');
        document.querySelector('.profile-loading-overlay')?.setAttribute('aria-hidden', 'true');
        const nameEl = document.getElementById('sidebar-name');
        const emailEl = document.getElementById('sidebar-email');
        const avatarEl = document.getElementById('sidebar-avatar');
        if (nameEl) nameEl.textContent = snap.data()?.displayName || user.displayName || 'Admin';
        if (emailEl) emailEl.textContent = user.email || '—';
        if (avatarEl) avatarEl.textContent = (snap.data()?.displayName || user.email || 'A').toString().trim().charAt(0).toUpperCase();
    });
})();
