/** Televet Health — Vet Profile Sync */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const D = { sn: $('sidebar-name'), se: $('sidebar-email'), sa: $('sidebar-avatar'), si: $('sidebar-avatar-img'), du: $('dashboard-user-name'), pn: $('profile-name'), pe: $('profile-email'), pr: $('profile-role'), pv: $('profile-verified'), pc: $('profile-created'), pp: $('profile-photo'), ph: $('profile-photo-placeholder') };
    const CACHE = 'telehealthProfileCache:', UID = 'telehealthLastUid';

    const initials = n => !n ? 'V' : (p => p.length >= 2 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : (n[0]||'V').toUpperCase())(n.trim().split(/\s+/).filter(Boolean));
    const withDr = n => !(n=(n||'').trim()) ? 'Dr. Veterinarian' : /^dr\.?\s/i.test(n) ? n : `Dr. ${n}`;
    const fmtDate = ts => !ts ? '—' : (d => Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))(typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts));

    const setPhoto = (url, name, img, initialsEl, placeholderEl) => {
        if (!img) return;
        const show = !!url;
        if (show) { img.src = url; img.alt = name ? `${name} profile photo` : 'Profile photo'; } else img.removeAttribute('src');
        img.classList.toggle('is-hidden', !show);
        if (initialsEl) initialsEl.classList.toggle('is-hidden', show);
        if (placeholderEl) placeholderEl.classList.toggle('is-hidden', show);
    };
    const txt = (el, t) => { if (el) el.textContent = t; };

    const apply = p => {
        if (!p) return;
        const { displayName = 'Veterinarian', email = '—', photoUrl = '', createdAt, verified } = p;
        const fn = (displayName||'').trim().split(/\s+/)[0] || '', dash = fn || 'there', full = withDr(displayName);
        txt(D.sn, full); txt(D.se, email); txt(D.du, dash); txt(D.sa, initials(displayName));
        setPhoto(photoUrl, displayName, D.si, D.sa, null);
        txt(D.pn, full); txt(D.pe, email); txt(D.pr, 'Veterinarian'); txt(D.pv, verified ? 'Verified' : 'Unverified'); txt(D.pc, fmtDate(createdAt));
        setPhoto(photoUrl, displayName, D.pp, null, D.ph);
    };

    const fromUser = u => ({ displayName: u.displayName || (u.email?.split('@')[0] || '') || 'Veterinarian', email: u.email || '—', photoUrl: u.photoURL || '', verified: u.emailVerified, createdAt: null });
    const readCache = uid => { try { return uid ? JSON.parse(sessionStorage.getItem(CACHE+uid) || 'null') : null; } catch { return null; } };
    const writeCache = (uid, p) => { if (uid && p) { sessionStorage.setItem(CACHE+uid, JSON.stringify(p)); sessionStorage.setItem(UID, uid); } };

    const sync = async user => {
        const data = (await getDoc(doc(db, 'users', user.uid))).data() || {};
        const p = { displayName: data.displayName || `${data.firstName||''} ${data.lastName||''}`.trim() || user.displayName || (user.email?.split('@')[0]||'') || 'Veterinarian', email: data.email || user.email || '—', photoUrl: data.photoURL || user.photoURL || '', verified: user.emailVerified || data.emailVerified, createdAt: data.createdAt || null };
        apply(p); writeCache(user.uid, p); return p;
    };
    const reveal = () => { document.body.classList.remove('profile-loading'); window.dispatchEvent(new CustomEvent('profileReady')); };
    const done = () => requestAnimationFrame(() => requestAnimationFrame(reveal));

    onAuthStateChanged(auth, user => {
        if (!user) return;
        const prev = sessionStorage.getItem(UID);
        if (prev && prev !== user.uid) sessionStorage.removeItem(CACHE+prev);
        sessionStorage.setItem(UID, user.uid);
        const c = readCache(user.uid);
        if (c) { apply(c); sync(user).then(done).catch(err => { console.error('Profile sync error:', err); done(); }); return; }
        sync(user).then(done).catch(err => { console.error('Profile sync error:', err); const f = fromUser(user); apply(f); writeCache(user.uid, f); done(); });
    });
})();
