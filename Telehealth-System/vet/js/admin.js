/** Televet Health — Admin: list, disable, enable, delete pet owners */
import { auth, db } from '../../shared/js/firebase-config.js';
import { collection, query, where, getDocs, doc, updateDoc, writeBatch, serverTimestamp, deleteField } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const els = { load: $('admin-loading'), wrap: document.querySelector('.admin-content-wrapper'), err: $('admin-error'), errMsg: $('admin-error-message'), toolbar: $('admin-toolbar'), list: $('admin-list-wrapper'), body: $('admin-table-body'), count: $('admin-count'), plural: $('admin-count-plural'), empty: $('admin-empty'), search: $('admin-search-input'), overlay: $('admin-action-overlay'), modal: $('admin-action-modal'), name: $('admin-action-name'), email: $('admin-action-email'), status: $('admin-action-status'), lastLogin: $('admin-action-lastlogin'), activity: $('admin-action-activity'), disabledNotice: $('admin-action-disabled-notice'), disableBtn: $('admin-action-disable-btn'), deleteBtn: $('admin-action-delete-btn'), close: $('admin-action-close') };
    const MONTH = 30 * 24 * 60 * 60 * 1000;
    let owners = [], current = null;

    const lastLogin = d => !d.lastLoginAt ? null : (typeof d.lastLoginAt?.toDate === 'function' ? d.lastLoginAt.toDate() : new Date(d.lastLoginAt));
    const inactive = d => { const t = lastLogin(d); return !t || (Date.now() - t.getTime()) > MONTH; };
    const fmt = ts => !ts ? '—' : (d => Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))(typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts));
    const name = d => (d.displayName || '').trim() || [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || 'Pet Owner';
    const esc = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    const ui = (toolbar, list, empty) => { els.toolbar?.classList.toggle('is-hidden', !toolbar); els.list?.classList.toggle('is-hidden', !list); els.empty?.classList.toggle('is-hidden', !empty); };
    const loading = on => { els.load?.classList.toggle('is-hidden', !on); els.wrap?.classList.toggle('admin-content-loading', on); };
    const err = (on, msg) => { els.err?.classList.toggle('is-hidden', !on); if (msg && els.errMsg) els.errMsg.textContent = msg; };
    const cnt = n => { if (els.count) els.count.textContent = n; if (els.plural) els.plural.textContent = n === 1 ? '' : 's'; };

    const render = list => {
        if (!els.body) return;
        els.body.innerHTML = '';
        list.forEach(o => {
            const d = o.data, dis = !!d.disabled, n = name(d), ver = d.emailVerified ? 'Verified' : 'Unverified', last = lastLogin(d), lastTxt = last ? fmt(d.lastLoginAt) : 'Never', inact = inactive(d);
            const status = dis ? `<span class="admin-badge admin-badge-disabled">Disabled</span>` : `<span class="admin-badge admin-badge-${d.emailVerified ? 'verified' : 'unverified'}">${esc(ver)}</span>`;
            const lastCell = inact ? `<span class="admin-cell-lastlogin">${esc(lastTxt)}</span> <span class="admin-badge admin-badge-inactive">Inactive</span>` : esc(lastTxt);
            const tr = document.createElement('tr');
            tr.classList.toggle('admin-row-disabled', dis); tr.classList.toggle('admin-row-inactive', inact); tr.classList.add('admin-row-clickable'); tr.dataset.uid = o.id;
            tr.innerHTML = `<td><span class="admin-cell-name">${esc(n)}</span></td><td><a href="mailto:${esc(d.email||'—')}" class="admin-cell-email">${esc(d.email||'—')}</a></td><td>${esc(fmt(d.createdAt))}</td><td class="admin-cell-lastlogin-wrap">${lastCell}</td><td>${status}</td>`;
            tr.addEventListener('click', () => openModal(o));
            tr.querySelector('.admin-cell-email')?.addEventListener('click', e => e.stopPropagation());
            els.body.appendChild(tr);
        });
    };

    const openModal = o => {
        if (!els.modal || !els.overlay) return;
        current = o;
        const d = o.data, n = name(d), dis = !!d.disabled, ver = d.emailVerified ? 'Verified' : 'Unverified', last = lastLogin(d), lastTxt = last ? fmt(d.lastLoginAt) : 'Never', inact = inactive(d);
        if (els.name) els.name.textContent = n;
        if (els.email) els.email.textContent = d.email || '—';
        if (els.status) { els.status.className = 'admin-badge ' + (dis ? 'admin-badge-disabled' : (d.emailVerified ? 'admin-badge-verified' : 'admin-badge-unverified')); els.status.textContent = dis ? 'Disabled' : ver; }
        if (els.lastLogin) els.lastLogin.textContent = lastTxt;
        if (els.activity) { els.activity.className = 'admin-badge ' + (inact ? 'admin-badge-inactive' : 'admin-badge-active'); els.activity.textContent = inact ? 'Inactive' : 'Active'; }
        if (els.disableBtn) els.disableBtn.innerHTML = dis ? '<i class="fa fa-check-circle" aria-hidden="true"></i> Enable account' : '<i class="fa fa-ban" aria-hidden="true"></i> Disable account';
        if (els.disabledNotice) { els.disabledNotice.classList.toggle('is-hidden', !dis); els.disabledNotice.textContent = dis ? 'This account is disabled. The user cannot log in until you re-enable them.' : ''; }
        els.overlay.classList.remove('is-hidden');
        els.modal.classList.remove('is-hidden');
    };
    const closeModal = () => { current = null; els.overlay?.classList.add('is-hidden'); els.modal?.classList.add('is-hidden'); };

    const setDisabled = async (uid, dis) => {
        try {
            await updateDoc(doc(db, 'users', uid), dis ? { disabled: true, disabledAt: serverTimestamp(), disabledBy: auth.currentUser?.uid || null } : { disabled: false, disabledAt: deleteField(), disabledBy: deleteField() });
            const i = owners.findIndex(x => x.id === uid);
            if (i !== -1) {
                owners[i] = { ...owners[i], data: { ...owners[i].data, disabled: dis } };
                applyFilter();
                if (current?.id === uid) openModal(owners[i]);
            } else applyFilter();
        } catch (e) { console.error('Set disabled error:', e); alert(e.message || 'Failed to update account.'); }
    };
    const deleteAcct = async uid => {
        try {
            const batch = writeBatch(db);
            (await getDocs(collection(db, 'users', uid, 'pets'))).docs.forEach(x => batch.delete(x.ref));
            batch.delete(doc(db, 'users', uid));
            await batch.commit();
            owners = owners.filter(x => x.id !== uid);
            applyFilter();
            if (!owners.length) { ui(false, false, true); cnt(0); }
            if (current?.id === uid) closeModal();
        } catch (e) { console.error('Delete error:', e); alert(e.message || 'Failed to delete account.'); }
    };

    const filter = term => { const t = (term || '').trim().toLowerCase(); return !t ? owners : owners.filter(({ data }) => name(data).toLowerCase().includes(t) || (data.email || '').toLowerCase().includes(t)); };
    const applyFilter = () => { const f = filter(els.search?.value); render(f); cnt(f.length); ui(true, !!f.length, !f.length); };

    const load = async () => {
        ui(false, false, false); err(false); els.body && (els.body.innerHTML = ''); cnt(0); loading(true);
        try {
            const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'petOwner')));
            owners = snap.docs.map(d => ({ id: d.id, data: d.data() })).sort((a, b) => (b.data.createdAt?.toDate?.()?.getTime() ?? 0) - (a.data.createdAt?.toDate?.()?.getTime() ?? 0));
            loading(false);
            if (!owners.length) { ui(false, false, true); cnt(0); return; }
            cnt(owners.length); render(owners); ui(true, true, false);
        } catch (e) { console.error('Load error:', e); loading(false); err(true, e.message || 'Failed to load pet owners.'); }
    };

    const init = () => {
        if (!els.load) return;
        load();
        $('admin-refresh-btn')?.addEventListener('click', load);
        els.search?.addEventListener('input', applyFilter);
        els.search?.addEventListener('search', applyFilter);
        els.overlay?.addEventListener('click', closeModal);
        els.close?.addEventListener('click', closeModal);
        els.modal?.addEventListener('click', e => e.stopPropagation());
        els.disableBtn?.addEventListener('click', async () => { if (!current) return; if (!confirm(current.data.disabled ? `Re-enable "${name(current.data)}"?` : `Disable "${name(current.data)}"? They will not be able to log in until you re-enable them.`)) return; await setDisabled(current.id, !current.data.disabled); });
        els.deleteBtn?.addEventListener('click', async () => { if (!current) return; if (!confirm(`Permanently delete "${name(current.data)}"? This will remove their profile and all pet records. They will need to re-register. This cannot be undone.`)) return; await deleteAcct(current.id); });
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
