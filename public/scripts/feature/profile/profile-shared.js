/**
 * Televet Health — Shared Profile Logic
 * Consumed by petowner/profile.js and vet/profile.js via initProfile(config).
 */
import { app, auth, db, storage } from '../../core/firebase/firebase-config.js';
import { getInitials, formatDate } from '../../core/app/utils.js';
import { openProfilePhotoCrop } from '../../core/app/profile-photo-crop.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-functions.js';
import {
    onAuthStateChanged, updatePassword,
    reauthenticateWithCredential, EmailAuthProvider,
    GoogleAuthProvider, reauthenticateWithPopup,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';
import { initPasswordToggleFields } from '../../core/app/password-toggle.js';

const CACHE_PREFIX = 'telehealthProfileCache:';
const LAST_UID_KEY  = 'telehealthLastUid';
const appBasePrefix = (() => {
    const p = window.location.pathname || '';
    return p === '/public' || p.startsWith('/public/') ? '/public' : '';
})();
const withAppBase = (path) => `${appBasePrefix}${path}`;

const $ = id => document.getElementById(id);
const setText = (el, text) => { if (el) el.textContent = text; };
const orDash  = v => (v && String(v).trim()) ? String(v).trim() : '—';

const isEmailProvider  = user => user.providerData?.some(p => p.providerId === 'password');
const isGoogleProvider = user => user.providerData?.some(p => p.providerId === 'google.com');

const readCache = uid => {
    try { return uid ? JSON.parse(sessionStorage.getItem(`${CACHE_PREFIX}${uid}`) || 'null') : null; }
    catch { return null; }
};
const writeCache = (uid, p) => {
    if (uid && p) {
        sessionStorage.setItem(`${CACHE_PREFIX}${uid}`, JSON.stringify(p));
        sessionStorage.setItem(LAST_UID_KEY, uid);
    }
};

/**
 * Show or hide a photo element with a companion placeholder.
 * @param {string}      url           Download URL (empty → show placeholder)
 * @param {string}      name          Used for alt text and initials
 * @param {HTMLElement} imgEl         The <img> element
 * @param {HTMLElement} [placeholderEl] Placeholder that shows initials when no photo
 * @param {HTMLElement} [initialsEl]    Alternative element toggled alongside placeholder
 * @param {string}      [defaultInitials]
 */
function setPhoto(url, name, imgEl, placeholderEl = null, initialsEl = null, defaultInitials = '') {
    if (!imgEl) return;
    const show = Boolean(url);
    if (show) { imgEl.src = url; imgEl.alt = name ? `${name} profile photo` : 'Profile photo'; }
    else imgEl.removeAttribute('src');
    imgEl.classList.toggle('is-hidden', !show);
    if (placeholderEl) {
        placeholderEl.classList.toggle('is-hidden', show);
        placeholderEl.textContent = name ? getInitials(name) : defaultInitials;
    }
    if (initialsEl) initialsEl.classList.toggle('is-hidden', show);
}

/**
 * Initialize the profile page.
 *
 * @param {object}   config
 * @param {string}   config.defaultName      Fallback display name  ('Pet Owner' | 'Veterinarian')
 * @param {function} [config.formatName]     Transform the display name shown in UI  (default: identity)
 * @param {function} config.buildProfile     (firestoreData, firebaseUser) → profile object
 * @param {function} config.getRole          (profile) → role label string shown in badge
 * @param {string}   [config.defaultInitials] Initials shown when no photo (default: first 2 caps of defaultName)
 */
export function initProfile(config) {
    const {
        defaultName,
        formatName      = n => n,
        buildProfile,
        getRole,
        defaultInitials = defaultName.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2),
    } = config;

    initPasswordToggleFields(document);

    /* ── DOM references ───────────────────────────────────────────── */
    const D = {
        sidebarName:              $('sidebar-name'),
        sidebarEmail:             $('sidebar-email'),
        sidebarAvatar:            $('sidebar-avatar'),
        sidebarAvatarImg:         $('sidebar-avatar-img'),
        dashboardUserName:        $('dashboard-user-name'),
        profileName:              $('profile-name'),
        profileNameGrid:          $('profile-name-grid'),
        profileEmail:             $('profile-email'),
        profileRole:              $('profile-role'),
        profileRoleGrid:          $('profile-role-grid'),
        profileCreated:           $('profile-created'),
        profilePhoto:             $('profile-photo'),
        profilePhotoPlaceholder:  $('profile-photo-placeholder'),
        editProfilePhoto:         $('edit-profile-photo'),
        editProfilePhotoPlaceholder: $('edit-profile-photo-placeholder'),
        bio:                      $('profile-bio'),
        address:                  $('profile-address'),
        phone:                    $('profile-phone'),
        bioView:                  $('profile-bio-view'),
        addressView:              $('profile-address-view'),
        phoneView:                $('profile-phone-view'),
        bioCount:                 $('bio-char-count'),
        btnSave:                  $('btn-save-profile'),
        btnEditProfile:           $('btn-edit-profile'),
        btnCancelEdit:            $('btn-cancel-edit'),
        btnChangePhoto:           $('btn-change-photo'),
        btnRemovePhoto:           $('btn-remove-photo'),
        btnUseEmailPhoto:         $('btn-use-email-photo'),
        photoInput:               $('profile-photo-input'),
        editModal:                $('edit-profile-modal'),
        formPassword:             $('form-change-password'),
        currentPass:              $('current-password'),
        newPass:                  $('new-password'),
        confirmPass:              $('confirm-password'),
        btnDelete:                $('btn-delete-account'),
        modal:                    $('delete-account-modal'),
        deletePass:               $('delete-password'),
        btnModalCancel:           $('btn-modal-cancel'),
        btnModalConfirm:          $('btn-modal-confirm-delete'),
        changePasswordBlock:      $('form-change-password')?.closest('.security-block'),
        btnRevealChangePassword:  $('btn-reveal-change-password'),
        changePasswordFormWrap:   $('change-password-form-wrap'),
        btnCancelChangePassword:  $('btn-cancel-change-password'),
    };

    /* ── Pending state (cleared on Cancel, applied on Save) ────────── */
    let pendingProfilePhoto = null; // { file: File, objectUrl: string } | null
    let pendingPhotoAction  = null; // 'remove' | { type: 'url', url: string } | null

    /* ── Photo helpers ─────────────────────────────────────────────── */
    const setSidebarPhoto  = (url, name) => setPhoto(url, name, D.sidebarAvatarImg, null, D.sidebarAvatar);
    const setProfilePhoto  = (url, name) => setPhoto(url, name, D.profilePhoto, D.profilePhotoPlaceholder, null, defaultInitials);
    const setModalPhoto    = (url, name) => setPhoto(url, name, D.editProfilePhoto, D.editProfilePhotoPlaceholder, null, defaultInitials);

    const getModalPhotoUrl = () => {
        if (pendingProfilePhoto?.objectUrl) return pendingProfilePhoto.objectUrl;
        if (pendingPhotoAction === 'remove') return '';
        if (pendingPhotoAction?.type === 'url') return pendingPhotoAction.url;
        return readCache(auth.currentUser?.uid)?.photoUrl || '';
    };

    /* ── Apply profile to DOM ──────────────────────────────────────── */
    const applyProfile = profile => {
        if (!profile) return;
        const { displayName = defaultName, email = '—', photoUrl = '', createdAt, bio = '', address = '', phone = '' } = profile;
        const formattedName = formatName(displayName);
        const firstName  = (displayName || '').trim().split(/\s+/)[0] || '';
        // If the first word matches the role default name (e.g. "Pet"), fall back to "there"
        const firstDefault = defaultName.split(/\s+/)[0].toLowerCase();
        const dashName  = firstName && firstName.toLowerCase() !== firstDefault ? firstName : 'there';

        setText(D.sidebarName, formattedName);
        setText(D.sidebarEmail, email);
        setText(D.dashboardUserName, dashName);
        setText(D.sidebarAvatar, getInitials(displayName));
        setSidebarPhoto(photoUrl, displayName);

        setText(D.profileName, formattedName);
        if (D.profileNameGrid) setText(D.profileNameGrid, formattedName);
        setText(D.profileEmail, email);
        const roleLabel = getRole(profile);
        setText(D.profileRole, roleLabel);
        if (D.profileRoleGrid) setText(D.profileRoleGrid, roleLabel);
        setText(D.profileCreated, formatDate(createdAt) || '—');

        setProfilePhoto(photoUrl, displayName);
        setModalPhoto(photoUrl, displayName);

        setText(D.bioView, orDash(bio));
        setText(D.addressView, orDash(address));
        setText(D.phoneView, orDash(phone));
        if (D.bio)     { D.bio.value = bio; setText(D.bioCount, String(bio.length)); }
        if (D.address)   D.address.value = address;
        if (D.phone)     D.phone.value = phone;
    };

    /* ── Firestore sync ────────────────────────────────────────────── */
    const syncProfile = async user => {
        const snap = await getDoc(doc(db, 'users', user.uid));
        const data  = snap.exists() ? snap.data() : {};
        const profile = buildProfile(data, user);
        applyProfile(profile);
        writeCache(user.uid, profile);
        return profile;
    };

    const reveal       = () => { document.body.classList.remove('profile-loading'); window.dispatchEvent(new CustomEvent('profileReady')); };
    const profileReady = () => requestAnimationFrame(() => requestAnimationFrame(reveal));

    /* ── Storage helpers ───────────────────────────────────────────── */
    const deleteStoragePhoto = async () => {
        const user = auth.currentUser;
        if (!user) return;
        try { await deleteObject(ref(storage, `profile-photos/${user.uid}`)); } catch (_) {}
    };

    const uploadPhoto = async file => {
        const user = auth.currentUser;
        if (!user || !file?.type?.startsWith('image/')) return;
        const storageRef = ref(storage, `profile-photos/${user.uid}`);
        const snap = await uploadBytes(storageRef, file, { contentType: file.type });
        const url  = await getDownloadURL(snap.ref);
        await updateDoc(doc(db, 'users', user.uid), { photoURL: url });
        const cache = readCache(user.uid);
        if (cache) { cache.photoUrl = url; writeCache(user.uid, cache); }
        applyProfile(cache || { ...readCache(user.uid), photoUrl: url });
    };

    /* ── Edit modal ────────────────────────────────────────────────── */
    const openEditModal = () => {
        const user = auth.currentUser;
        const c    = readCache(user?.uid);
        if (c) {
            D.bio.value     = c.bio     || '';
            D.address.value = c.address || '';
            D.phone.value   = c.phone   || '';
            setText(D.bioCount, String((c.bio || '').length));
            setModalPhoto(getModalPhotoUrl(), c.displayName);
        }
        if (D.btnUseEmailPhoto) {
            D.btnUseEmailPhoto.classList.toggle('is-hidden', !(user && isGoogleProvider(user) && !!user.photoURL));
        }
        D.editModal?.setAttribute('aria-hidden', 'false');
    };

    const closeEditModal = () => {
        if (pendingProfilePhoto) { URL.revokeObjectURL(pendingProfilePhoto.objectUrl); pendingProfilePhoto = null; }
        pendingPhotoAction = null;
        D.editModal?.setAttribute('aria-hidden', 'true');
    };

    /* ── Save profile ──────────────────────────────────────────────── */
    const saveProfile = async () => {
        const user = auth.currentUser;
        if (!user) return;
        if (D.btnSave) { D.btnSave.disabled = true; D.btnSave.textContent = 'Saving...'; }
        const bio     = (D.bio?.value     || '').trim();
        const address = (D.address?.value || '').trim();
        const phone   = (D.phone?.value   || '').trim();
        try {
            if (pendingPhotoAction === 'remove') {
                await deleteStoragePhoto();
                await updateDoc(doc(db, 'users', user.uid), { photoURL: null });
                const cache = readCache(user.uid);
                if (cache) { cache.photoUrl = ''; writeCache(user.uid, cache); }
                applyProfile(cache || { photoUrl: '' });
            } else if (pendingPhotoAction?.type === 'url') {
                await deleteStoragePhoto();
                await updateDoc(doc(db, 'users', user.uid), { photoURL: pendingPhotoAction.url });
                const cache = readCache(user.uid);
                if (cache) { cache.photoUrl = pendingPhotoAction.url; writeCache(user.uid, cache); }
                applyProfile(cache || { photoUrl: pendingPhotoAction.url });
            } else if (pendingProfilePhoto) {
                await uploadPhoto(pendingProfilePhoto.file);
                URL.revokeObjectURL(pendingProfilePhoto.objectUrl);
                pendingProfilePhoto = null;
            }
            pendingPhotoAction = null;
            await updateDoc(doc(db, 'users', user.uid), { bio, address, phone });
            const cache = readCache(user.uid);
            if (cache) { cache.bio = bio; cache.address = address; cache.phone = phone; writeCache(user.uid, cache); }
            applyProfile(cache || { bio, address, phone });
            closeEditModal();
            alert('Profile updated successfully.');
        } catch (err) {
            console.error('Save profile error:', err);
            alert('Failed to save profile. Please try again.');
        } finally {
            if (D.btnSave) { D.btnSave.disabled = false; D.btnSave.textContent = 'Save Changes'; }
        }
    };

    /* ── Photo actions (modal) ─────────────────────────────────────── */
    const removePhoto = () => {
        if (pendingProfilePhoto) { URL.revokeObjectURL(pendingProfilePhoto.objectUrl); pendingProfilePhoto = null; }
        pendingPhotoAction = 'remove';
        setModalPhoto('', readCache(auth.currentUser?.uid)?.displayName || defaultName);
    };

    const useEmailPhoto = () => {
        const user = auth.currentUser;
        if (!user || !isGoogleProvider(user) || !user.photoURL) return;
        if (pendingProfilePhoto) { URL.revokeObjectURL(pendingProfilePhoto.objectUrl); pendingProfilePhoto = null; }
        pendingPhotoAction = { type: 'url', url: user.photoURL };
        const c = readCache(user.uid);
        setModalPhoto(user.photoURL, c?.displayName || user.displayName || defaultName);
    };

    /* ── Change password ───────────────────────────────────────────── */
    const handleChangePassword = async e => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user || !isEmailProvider(user)) return;
        const current = D.currentPass?.value || '';
        const newP    = D.newPass?.value     || '';
        const confirm = D.confirmPass?.value || '';
        if (!current || !newP || !confirm) { alert('Please fill all password fields.'); return; }
        if (newP.length < 6)               { alert('New password must be at least 6 characters.'); return; }
        if (newP !== confirm)              { alert('New passwords do not match.'); return; }
        const btn = D.formPassword?.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = 'Updating...';
        try {
            await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
            await updatePassword(user, newP);
            D.formPassword.reset();
            D.changePasswordFormWrap?.classList.add('is-hidden');
            D.changePasswordFormWrap?.setAttribute('aria-hidden', 'true');
            D.btnRevealChangePassword?.classList.remove('is-hidden');
            D.btnRevealChangePassword?.removeAttribute('aria-hidden');
            alert('Password updated successfully.');
        } catch (err) {
            console.error('Change password error:', err);
            alert(
                err.code === 'auth/wrong-password'  ? 'Current password is incorrect.'  :
                err.code === 'auth/weak-password'   ? 'New password is too weak.'        :
                err.message || 'Failed to update password.'
            );
        } finally {
            btn.disabled = false; btn.textContent = 'Update Password';
        }
    };

    /* ── Delete account modal ──────────────────────────────────────── */
    const openDeleteModal  = () => { D.modal?.setAttribute('aria-hidden', 'false'); D.deletePass.value = ''; D.deletePass.focus(); };
    const closeDeleteModal = () => D.modal?.setAttribute('aria-hidden', 'true');

    const handleDeleteAccount = async () => {
        const user = auth.currentUser;
        if (!user) return;
        const password = D.deletePass?.value || '';
        if (isEmailProvider(user)) {
            if (!password) { alert('Please enter your password to confirm.'); return; }
            try {
                await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
            } catch (err) {
                alert(err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
                    ? 'Incorrect password.' : err.message || 'Authentication failed.');
                return;
            }
        } else {
            try { await reauthenticateWithPopup(user, new GoogleAuthProvider()); }
            catch { alert('Re-authentication required. Please try again.'); return; }
        }
        D.btnModalConfirm.disabled = true; D.btnModalConfirm.textContent = 'Deleting...';
        try {
            const current = auth.currentUser;
            if (current) await current.getIdToken(true);
            await httpsCallable(getFunctions(app), 'deleteMyAccount')();
            closeDeleteModal();
            window.location.replace(withAppBase('/auth.html'));
        } catch (err) {
            console.error('Delete account error:', err);
            const msg = err.message || err.data?.message || err.data || 'Failed to delete account. Please try again.';
            alert(typeof msg === 'string' ? msg : 'Failed to delete account. Please try again.');
        } finally {
            D.btnModalConfirm.disabled = false; D.btnModalConfirm.textContent = 'Delete My Account';
        }
    };

    /* ── Bind UI events ────────────────────────────────────────────── */
    const initUI = user => {
        if (D.bio) D.bio.addEventListener('input', () => setText(D.bioCount, String((D.bio.value || '').length)));

        D.btnEditProfile?.addEventListener('click', openEditModal);
        D.btnCancelEdit?.addEventListener('click', closeEditModal);
        D.btnSave?.addEventListener('click', saveProfile);
        D.btnChangePhoto?.addEventListener('click', () => D.photoInput?.click());
        D.btnRemovePhoto?.addEventListener('click', removePhoto);
        D.btnUseEmailPhoto?.addEventListener('click', useEmailPhoto);

        D.photoInput?.addEventListener('change', async e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f || !f.type.startsWith('image/')) return;
            const blob = await openProfilePhotoCrop(f);
            if (!blob) return;
            const file = new File([blob], 'profile.png', { type: blob.type });
            if (pendingProfilePhoto?.objectUrl) URL.revokeObjectURL(pendingProfilePhoto.objectUrl);
            pendingPhotoAction  = null;
            pendingProfilePhoto = { file, objectUrl: URL.createObjectURL(file) };
            setModalPhoto(pendingProfilePhoto.objectUrl, readCache(auth.currentUser?.uid)?.displayName || defaultName);
        });

        D.formPassword?.addEventListener('submit', handleChangePassword);
        D.btnRevealChangePassword?.addEventListener('click', () => {
            D.changePasswordFormWrap?.classList.remove('is-hidden');
            D.changePasswordFormWrap?.setAttribute('aria-hidden', 'false');
            D.btnRevealChangePassword?.classList.add('is-hidden');
            D.btnRevealChangePassword?.setAttribute('aria-hidden', 'true');
        });
        D.btnCancelChangePassword?.addEventListener('click', () => {
            D.formPassword?.reset();
            D.changePasswordFormWrap?.classList.add('is-hidden');
            D.changePasswordFormWrap?.setAttribute('aria-hidden', 'true');
            D.btnRevealChangePassword?.classList.remove('is-hidden');
            D.btnRevealChangePassword?.removeAttribute('aria-hidden');
        });

        D.btnDelete?.addEventListener('click', openDeleteModal);
        D.btnModalCancel?.addEventListener('click', closeDeleteModal);
        D.btnModalConfirm?.addEventListener('click', handleDeleteAccount);
        D.modal?.addEventListener('click', e => { if (e.target === D.modal) closeDeleteModal(); });
        D.editModal?.addEventListener('click', e => { if (e.target === D.editModal) closeEditModal(); });
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (D.modal?.getAttribute('aria-hidden') === 'false') closeDeleteModal();
            else if (D.editModal?.getAttribute('aria-hidden') === 'false') closeEditModal();
        });

        if (!isEmailProvider(user) && D.changePasswordBlock) {
            D.changePasswordBlock.innerHTML = '<p class="danger-text">You signed in with Google. Password change is not available. Use your Google account to manage sign-in.</p>';
        }
        const deletePassGroup = D.deletePass?.closest('.field-group');
        if (!isEmailProvider(user) && deletePassGroup) deletePassGroup.style.display = 'none';
    };

    /* ── Auth state entry point ────────────────────────────────────── */
    onAuthStateChanged(auth, user => {
        if (!user) return;

        const prev = sessionStorage.getItem(LAST_UID_KEY);
        if (prev && prev !== user.uid) sessionStorage.removeItem(`${CACHE_PREFIX}${prev}`);
        sessionStorage.setItem(LAST_UID_KEY, user.uid);

        const cached = readCache(user.uid);
        const doSync = () => syncProfile(user).then(profileReady).catch(err => {
            console.error('Profile sync error:', err);
            if (!cached) {
                const fallback = {
                    displayName: user.displayName || user.email?.split('@')[0] || defaultName,
                    email: user.email || '—', photoUrl: user.photoURL || '',
                    createdAt: null, bio: '', address: '', phone: '',
                };
                applyProfile(fallback);
                writeCache(user.uid, fallback);
            }
            profileReady();
        });

        if (cached) { applyProfile(cached); doSync(); }
        else doSync();

        initUI(user);
    });
}
