/**
 * Televet Health — Profile sync (sidebar + profile page)
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const DOM = {
        sidebarName: $('sidebar-name'), sidebarEmail: $('sidebar-email'), sidebarAvatar: $('sidebar-avatar'),
        sidebarAvatarImg: $('sidebar-avatar-img'), profileName: $('profile-name'), profileEmail: $('profile-email'),
        profileRole: $('profile-role'), profileVerified: $('profile-verified'), profileCreated: $('profile-created'),
        profilePhoto: $('profile-photo'), profilePhotoPlaceholder: $('profile-photo-placeholder')
    };
    const CACHE_PREFIX = 'telehealthProfileCache:';
    const LAST_UID_KEY = 'telehealthLastUid';

    const getInitials = (name) => {
        if (!name) return '?';
        const parts = name.trim().split(' ').filter(Boolean);
        return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name[0] || '?').toUpperCase();
    };
    const formatRole = (role) => role === 'vet' ? 'Veterinarian' : 'Pet Owner';
    const formatDate = (timestamp) => {
        if (!timestamp) return '—';
        const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
        return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const setPhoto = (photoUrl, name, imgEl, placeholderEl, initialsEl) => {
        if (!imgEl) return;
        if (photoUrl) {
            imgEl.src = photoUrl;
            imgEl.alt = name ? `${name} profile photo` : 'Profile photo';
            imgEl.classList.remove('is-hidden');
            if (placeholderEl) placeholderEl.classList.add('is-hidden');
            if (initialsEl) initialsEl.classList.add('is-hidden');
        } else {
            imgEl.removeAttribute('src');
            imgEl.classList.add('is-hidden');
            if (placeholderEl) placeholderEl.classList.remove('is-hidden');
            if (initialsEl) initialsEl.classList.remove('is-hidden');
        }
    };

    const setSidebarPhoto = (photoUrl, name) => setPhoto(photoUrl, name, DOM.sidebarAvatarImg, null, DOM.sidebarAvatar);
    const setProfilePhoto = (photoUrl, name) => setPhoto(photoUrl, name, DOM.profilePhoto, DOM.profilePhotoPlaceholder);

    const applyProfile = (profile) => {
        if (!profile) return;
        const displayName = profile.displayName || 'Pet Owner';
        const email = profile.email || '—';
        const role = profile.role || 'Pet Owner';
        const verified = Boolean(profile.verified);

        if (DOM.sidebarName) DOM.sidebarName.textContent = displayName;
        if (DOM.sidebarEmail) DOM.sidebarEmail.textContent = email;
        if (DOM.sidebarAvatar) DOM.sidebarAvatar.textContent = getInitials(displayName);
        setSidebarPhoto(profile.photoUrl, displayName);

        if (DOM.profileName) DOM.profileName.textContent = displayName;
        if (DOM.profileEmail) DOM.profileEmail.textContent = email;
        if (DOM.profileRole) DOM.profileRole.textContent = role;
        if (DOM.profileVerified) DOM.profileVerified.textContent = verified ? 'Verified' : 'Unverified';
        if (DOM.profileCreated) DOM.profileCreated.textContent = formatDate(profile.createdAt);
        setProfilePhoto(profile.photoUrl, displayName);
    };

    const buildProfileFromUser = (user) => {
        const hasGoogle = user.providerData?.some(p => p.providerId === 'google.com');
        const hasEmail = user.providerData?.some(p => p.providerId === 'password');
        const displayName = (hasGoogle && hasEmail)
            ? (user.email ? user.email.split('@')[0] : '') || user.displayName || 'Pet Owner'
            : user.displayName || (user.email ? user.email.split('@')[0] : '') || 'Pet Owner';
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
        if (!uid) return null;
        try { return JSON.parse(sessionStorage.getItem(`${CACHE_PREFIX}${uid}`) || 'null'); }
        catch { return null; }
    };
    const writeCache = (uid, profile) => {
        if (!uid || !profile) return;
        sessionStorage.setItem(`${CACHE_PREFIX}${uid}`, JSON.stringify(profile));
        sessionStorage.setItem(LAST_UID_KEY, uid);
    };

    const syncProfile = async (user) => {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const data = userDoc.exists() ? userDoc.data() : {};
        const currentName = DOM.profileName?.textContent || DOM.sidebarName?.textContent || '';
        const displayName = data.displayName || currentName || user.displayName
            || `${data.firstName || ''} ${data.lastName || ''}`.trim()
            || (user.email ? user.email.split('@')[0] : '') || 'Pet Owner';

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

    const profileReady = () => {
        document.body.classList.remove('profile-loading');
        window.dispatchEvent(new CustomEvent('profileReady'));
    };

    onAuthStateChanged(auth, (user) => {
        if (!user) return;
        const cachedUid = sessionStorage.getItem(LAST_UID_KEY);
        if (cachedUid && cachedUid !== user.uid) sessionStorage.removeItem(`${CACHE_PREFIX}${cachedUid}`);
        sessionStorage.setItem(LAST_UID_KEY, user.uid);

        const userCache = readCache(user.uid);
        if (userCache) {
            applyProfile(userCache);
            profileReady();
            syncProfile(user).catch(err => console.error('Profile sync error:', err));
            return;
        }
        syncProfile(user)
            .then(profileReady)
            .catch((err) => {
                console.error('Profile sync error:', err);
                applyProfile(buildProfileFromUser(user));
                writeCache(user.uid, buildProfileFromUser(user));
                profileReady();
            });
    });
})();
