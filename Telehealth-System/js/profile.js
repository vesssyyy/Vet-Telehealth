/**
 * Televet Health — Profile Sync
 */
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    const $ = id => document.getElementById(id);

    const DOM = {
        sidebarName: $('sidebar-name'),
        sidebarEmail: $('sidebar-email'),
        sidebarAvatar: $('sidebar-avatar'),
        sidebarAvatarImg: $('sidebar-avatar-img'),
        profileName: $('profile-name'),
        profileEmail: $('profile-email'),
        profileRole: $('profile-role'),
        profileVerified: $('profile-verified'),
        profileCreated: $('profile-created'),
        profilePhoto: $('profile-photo'),
        profilePhotoPlaceholder: $('profile-photo-placeholder')
    };

    const CACHE_KEY_PREFIX = 'telehealthProfileCache:';
    const LAST_UID_KEY = 'telehealthLastUid';

    const getInitials = (name) => {
        if (!name) return '?';
        const parts = name.trim().split(' ').filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name[0].toUpperCase();
    };

    const formatRole = (role) => role === 'vet' ? 'Veterinarian' : 'Pet Owner';

    const formatDate = (timestamp) => {
        if (!timestamp) return '—';
        const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const setPhoto = (photoUrl, name) => {
        if (!DOM.profilePhoto || !DOM.profilePhotoPlaceholder) return;

        if (photoUrl) {
            DOM.profilePhoto.src = photoUrl;
            DOM.profilePhoto.alt = name ? `${name} profile photo` : 'Profile photo';
            DOM.profilePhoto.classList.remove('is-hidden');
            DOM.profilePhotoPlaceholder.classList.add('is-hidden');
        } else {
            DOM.profilePhoto.removeAttribute('src');
            DOM.profilePhoto.classList.add('is-hidden');
            DOM.profilePhotoPlaceholder.classList.remove('is-hidden');
        }
    };

    const setSidebarPhoto = (photoUrl, name) => {
        if (!DOM.sidebarAvatarImg || !DOM.sidebarAvatar) return;

        if (photoUrl) {
            DOM.sidebarAvatarImg.src = photoUrl;
            DOM.sidebarAvatarImg.alt = name ? `${name} profile photo` : 'Profile photo';
            DOM.sidebarAvatarImg.classList.remove('is-hidden');
            DOM.sidebarAvatar.classList.add('is-hidden');
        } else {
            DOM.sidebarAvatarImg.removeAttribute('src');
            DOM.sidebarAvatarImg.classList.add('is-hidden');
            DOM.sidebarAvatar.classList.remove('is-hidden');
        }
    };

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

        setPhoto(profile.photoUrl, displayName);
    };

    const buildProfileFromUser = (user) => {
        // Check if user has multiple providers (e.g., both Google and email/password)
        const hasGoogleProvider = user.providerData?.some(p => p.providerId === 'google.com');
        const hasEmailProvider = user.providerData?.some(p => p.providerId === 'password');
        const isMultiProvider = hasGoogleProvider && hasEmailProvider;

        // For multi-provider accounts, prefer email-derived name to avoid showing Google name
        // The Firestore document has the authoritative display name set during email signup
        let displayName;
        if (isMultiProvider) {
            displayName = (user.email ? user.email.split('@')[0] : '')
                || user.displayName
                || 'Pet Owner';
        } else {
            displayName = user.displayName
                || (user.email ? user.email.split('@')[0] : '')
                || 'Pet Owner';
        }

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
        const cached = sessionStorage.getItem(`${CACHE_KEY_PREFIX}${uid}`);
        if (!cached) return null;
        try {
            return JSON.parse(cached);
        } catch (error) {
            console.warn('Profile cache parse error:', error);
            return null;
        }
    };

    const writeCache = (uid, profile) => {
        if (!uid || !profile) return;
        sessionStorage.setItem(`${CACHE_KEY_PREFIX}${uid}`, JSON.stringify(profile));
        sessionStorage.setItem(LAST_UID_KEY, uid);
    };

    const syncProfile = async (user) => {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const data = userDoc.exists() ? userDoc.data() : {};

        const currentName = DOM.profileName?.textContent
            || DOM.sidebarName?.textContent
            || '';

        const displayName = data.displayName
            || currentName
            || user.displayName
            || `${data.firstName || ''} ${data.lastName || ''}`.trim()
            || (user.email ? user.email.split('@')[0] : '')
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

    /** Call when profile is ready to show; hides loading overlay and reveals page */
    const profileReady = () => {
        document.body.classList.remove('profile-loading');
        window.dispatchEvent(new CustomEvent('profileReady'));
    };

    onAuthStateChanged(auth, (user) => {
        if (!user) return;

        // Check if this is a different user than the cached one
        const cachedUid = sessionStorage.getItem(LAST_UID_KEY);
        if (cachedUid && cachedUid !== user.uid) {
            sessionStorage.removeItem(`${CACHE_KEY_PREFIX}${cachedUid}`);
        }

        sessionStorage.setItem(LAST_UID_KEY, user.uid);

        const userCache = readCache(user.uid);
        if (userCache) {
            // Use cached profile immediately — no flicker, then sync in background
            applyProfile(userCache);
            profileReady();
            syncProfile(user).catch((error) => {
                console.error('Profile sync error:', error);
            });
            return;
        }

        // No cache: resolve profile first (Firestore), then apply once and show page
        syncProfile(user)
            .then(() => {
                profileReady();
            })
            .catch((error) => {
                console.error('Profile sync error:', error);
                const quickProfile = buildProfileFromUser(user);
                applyProfile(quickProfile);
                writeCache(user.uid, quickProfile);
                profileReady();
            });
    });
})();
