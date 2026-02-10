/**
 * Televet Health — Profile sync (sidebar + profile page)
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const DOM = {
        sidebarName: $('sidebar-name'),
        sidebarEmail: $('sidebar-email'),
        sidebarAvatar: $('sidebar-avatar'),
        sidebarAvatarImg: $('sidebar-avatar-img'),
        dashboardUserName: $('dashboard-user-name'),
        profileName: $('profile-name'),
        profileEmail: $('profile-email'),
        profileRole: $('profile-role'),
        profileVerified: $('profile-verified'),
        profileCreated: $('profile-created'),
        profilePhoto: $('profile-photo'),
        profilePhotoPlaceholder: $('profile-photo-placeholder')
    };
    const CACHE_PREFIX = 'telehealthProfileCache:';
    const LAST_UID_KEY = 'telehealthLastUid';

    const getInitials = (name) => {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/).filter(Boolean);
        return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name[0] || '?').toUpperCase();
    };
    const formatRole = (role) => (role === 'vet' ? 'Veterinarian' : 'Pet Owner');
    const formatDate = (ts) => {
        if (!ts) return '—';
        const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const setPhoto = (photoUrl, name, imgEl, placeholderEl, initialsEl) => {
        if (!imgEl) return;
        const show = Boolean(photoUrl);
        if (show) {
            imgEl.src = photoUrl;
            imgEl.alt = name ? `${name} profile photo` : 'Profile photo';
        } else imgEl.removeAttribute('src');
        imgEl.classList.toggle('is-hidden', !show);
        if (placeholderEl) placeholderEl.classList.toggle('is-hidden', show);
        if (initialsEl) initialsEl.classList.toggle('is-hidden', show);
    };
    const setSidebarPhoto = (url, name) => setPhoto(url, name, DOM.sidebarAvatarImg, null, DOM.sidebarAvatar);
    const setProfilePhoto = (url, name) => setPhoto(url, name, DOM.profilePhoto, DOM.profilePhotoPlaceholder);
    const setText = (el, text) => { if (el) el.textContent = text; };

    const applyProfile = (profile) => {
        if (!profile) return;
        const { displayName = 'Pet Owner', email = '—', role = 'Pet Owner', photoUrl = '', createdAt } = profile;
        const verified = Boolean(profile.verified);
        const firstName = (displayName || '').trim().split(/\s+/)[0] || '';
        const dashName = firstName && firstName.toLowerCase() !== 'pet' ? firstName : 'there';

        setText(DOM.sidebarName, displayName);
        setText(DOM.sidebarEmail, email);
        setText(DOM.dashboardUserName, dashName);
        setText(DOM.sidebarAvatar, getInitials(displayName));
        setSidebarPhoto(photoUrl, displayName);
        setText(DOM.profileName, displayName);
        setText(DOM.profileEmail, email);
        setText(DOM.profileRole, role);
        setText(DOM.profileVerified, verified ? 'Verified' : 'Unverified');
        setText(DOM.profileCreated, formatDate(createdAt));
        setProfilePhoto(photoUrl, displayName);
    };

    const buildProfileFromUser = (user) => {
        const hasGoogle = user.providerData?.some((p) => p.providerId === 'google.com');
        const hasEmail = user.providerData?.some((p) => p.providerId === 'password');
        const displayName = (hasGoogle && hasEmail)
            ? (user.email?.split('@')[0] || '') || user.displayName || 'Pet Owner'
            : user.displayName || (user.email?.split('@')[0] || '') || 'Pet Owner';
        return {
            displayName,
            email: user.email || '—',
            role: formatRole(),
            verified: user.emailVerified,
            photoUrl: user.photoURL || '',
            createdAt: null
        };
    };

    const readCache = (uid) => {
        try { return uid ? JSON.parse(sessionStorage.getItem(`${CACHE_PREFIX}${uid}`) || 'null') : null; } catch { return null; }
    };
    const writeCache = (uid, p) => {
        if (uid && p) {
            sessionStorage.setItem(`${CACHE_PREFIX}${uid}`, JSON.stringify(p));
            sessionStorage.setItem(LAST_UID_KEY, uid);
        }
    };

    const syncProfile = async (user) => {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const data = userDoc.exists() ? userDoc.data() : {};
        const currentName = DOM.profileName?.textContent || DOM.sidebarName?.textContent || '';
        const displayName = data.displayName || currentName || user.displayName
            || `${data.firstName || ''} ${data.lastName || ''}`.trim()
            || (user.email?.split('@')[0] || '')
            || 'Pet Owner';
        const profile = {
            displayName,
            email: data.email || user.email || '—',
            role: formatRole(data.role),
            verified: user.emailVerified || data.emailVerified,
            photoUrl: data.photoURL || user.photoURL || '',
            createdAt: data.createdAt || null
        };
        applyProfile(profile);
        writeCache(user.uid, profile);
        return profile;
    };

    const reveal = () => {
        document.body.classList.remove('profile-loading');
        window.dispatchEvent(new CustomEvent('profileReady'));
    };
    const profileReady = () => requestAnimationFrame(() => requestAnimationFrame(reveal));

    onAuthStateChanged(auth, (user) => {
        if (!user) return;
        const cachedUid = sessionStorage.getItem(LAST_UID_KEY);
        if (cachedUid && cachedUid !== user.uid) sessionStorage.removeItem(`${CACHE_PREFIX}${cachedUid}`);
        sessionStorage.setItem(LAST_UID_KEY, user.uid);
        const userCache = readCache(user.uid);
        if (userCache) {
            applyProfile(userCache);
            syncProfile(user).then(profileReady).catch((err) => { console.error('Profile sync error:', err); profileReady(); });
            return;
        }
        syncProfile(user).then(profileReady).catch((err) => {
            console.error('Profile sync error:', err);
            const fallback = buildProfileFromUser(user);
            applyProfile(fallback);
            writeCache(user.uid, fallback);
            profileReady();
        });
    });
})();
