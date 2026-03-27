/** Televet Health — Admin dashboard: list users, reports, disable/enable/delete via Cloud Functions */
import { app, auth } from '../../core/firebase/firebase-config.js';
import { escapeHtml } from '../../core/app/utils.js';
import { initPasswordToggleFields } from '../../core/app/password-toggle.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-functions.js';

(function () {
    'use strict';
    const appBasePrefix = (() => {
        const p = window.location.pathname || '';
        return p === '/public' || p.startsWith('/public/') ? '/public' : '';
    })();
    const withAppBase = (path) => `${appBasePrefix}${path}`;
    initPasswordToggleFields();
    const $ = id => document.getElementById(id);
    const functions = getFunctions(app);
    const callables = {
        listUsers: httpsCallable(functions, 'listUsers'),
        getReport: httpsCallable(functions, 'getReport'),
        disableUser: httpsCallable(functions, 'disableUser'),
        enableUser: httpsCallable(functions, 'enableUser'),
        deleteUser: httpsCallable(functions, 'deleteUser'),
        createVetUser: httpsCallable(functions, 'createVetUser'),
    };

    const els = {
        reportsLoading: $('reports-loading'),
        reportsGrid: $('reports-grid'),
        reportTotal: $('report-total'),
        reportPetOwner: $('report-petOwner'),
        reportVet: $('report-vet'),
        reportAdmin: $('report-admin'),
        reportDisabled: $('report-disabled'),
        reportsRefresh: $('reports-refresh-btn'),
        filterRole: $('filter-role'),
        filterStatus: $('filter-status'),
        search: $('admin-search-input'),
        adminRefresh: $('admin-refresh-btn'),
        adminLoading: $('admin-loading'),
        adminError: $('admin-error'),
        adminErrorMsg: $('admin-error-message'),
        listWrapper: $('admin-list-wrapper'),
        tableBody: $('admin-table-body'),
        empty: $('admin-empty'),
        overlay: $('admin-action-overlay'),
        modal: $('admin-action-modal'),
        modalName: $('admin-action-name'),
        modalEmail: $('admin-action-email'),
        modalRole: $('admin-action-role'),
        modalStatus: $('admin-action-status'),
        disableBtn: $('admin-action-disable-btn'),
        disableLabel: $('admin-action-disable-label'),
        deleteBtn: $('admin-action-delete-btn'),
        closeBtn: $('admin-action-close'),
        createVetBtn: $('create-vet-btn'),
        createVetOverlay: $('create-vet-overlay'),
        createVetModal: $('create-vet-modal'),
        createVetClose: $('create-vet-close'),
        createVetForm: $('create-vet-form'),
        createVetStepForm: $('create-vet-step-form'),
        createVetStepSuccess: $('create-vet-step-success'),
        createVetSuccessEmail: $('create-vet-success-email'),
        createVetCancel: $('create-vet-cancel'),
        createVetSubmit: $('create-vet-submit'),
    };

    let allUsers = [];
    let currentUser = null;

    const esc = escapeHtml;
    const nameOf = u => (u.displayName || '').trim() || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'User';
    const toDate = (ts) => {
        if (!ts) return null;
        if (typeof ts?.toDate === 'function') return ts.toDate();
        const sec = ts.seconds ?? ts._seconds;
        if (typeof sec === 'number') return new Date(sec * 1000);
        return new Date(ts);
    };
    const fmt = (ts) => {
        const d = toDate(ts);
        return !d || Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };
    const fmtDateTime = (ts) => {
        const d = toDate(ts);
        return !d || Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    function setReportsLoading(on) {
        els.reportsLoading?.classList.toggle('is-hidden', !on);
        els.reportsGrid?.classList.toggle('is-hidden', on);
    }
    function setReports(data) {
        if (els.reportTotal) els.reportTotal.textContent = data.total ?? 0;
        if (els.reportPetOwner) els.reportPetOwner.textContent = data.byRole?.petOwner ?? 0;
        if (els.reportVet) els.reportVet.textContent = data.byRole?.vet ?? 0;
        if (els.reportAdmin) els.reportAdmin.textContent = data.byRole?.admin ?? 0;
        if (els.reportDisabled) els.reportDisabled.textContent = data.disabled ?? 0;
        setReportsLoading(false);
    }
    async function loadReport() {
        setReportsLoading(true);
        try {
            const res = await callables.getReport({});
            setReports(res.data);
        } catch (e) {
            console.error('Report error:', e);
            setReports({ total: 0, byRole: { petOwner: 0, vet: 0, admin: 0 }, disabled: 0 });
            setReportsLoading(false);
        }
    }

    function setAdminLoading(on) {
        els.adminLoading?.classList.toggle('is-hidden', !on);
        els.listWrapper?.classList.toggle('is-hidden', on);
        els.empty?.classList.add('is-hidden');
    }
    function setAdminError(on, msg) {
        els.adminError?.classList.toggle('is-hidden', !on);
        if (msg && els.adminErrorMsg) els.adminErrorMsg.textContent = msg;
    }
    function filterUsers() {
        const role = els.filterRole?.value || '';
        const status = els.filterStatus?.value || '';
        const term = (els.search?.value || '').trim().toLowerCase();
        return allUsers.filter(u => {
            if (role && u.role !== role) return false;
            if (status === 'active' && u.disabled) return false;
            if (status === 'disabled' && !u.disabled) return false;
            if (term && !nameOf(u).toLowerCase().includes(term) && !(u.email || '').toLowerCase().includes(term)) return false;
            return true;
        });
    }
    function renderUsers() {
        const list = filterUsers();
        if (!els.tableBody) return;
        els.tableBody.innerHTML = '';
        list.forEach(u => {
            const tr = document.createElement('tr');
            const n = nameOf(u);
            const roleBadge = u.role === 'admin' ? 'admin' : u.role === 'vet' ? 'vet' : 'petOwner';
            const emailStatus = u.emailVerified ? 'Verified' : 'Unverified';
            const lastLoginDate = fmt(u.lastLoginAt);
            const activeStatus = u.disabled ? 'Inactive' : 'Active';
            const lastLoginHtml = `${esc(lastLoginDate)}, <span class="admin-cell-status admin-cell-status-${u.disabled ? 'inactive' : 'active'}">${esc(activeStatus)}</span>`;
            tr.innerHTML = `
                <td><span class="admin-cell-name">${esc(n)}</span></td>
                <td><a href="mailto:${esc(u.email || '')}" class="admin-cell-email">${esc(u.email || '—')}</a></td>
                <td><span class="admin-badge ${u.emailVerified ? 'admin-badge-verified' : 'admin-badge-unverified'}">${esc(emailStatus)}</span></td>
                <td><span class="admin-badge admin-badge-${esc(roleBadge)}">${esc(u.role || '—')}</span></td>
                <td><span class="admin-cell-lastlogin">${lastLoginHtml}</span></td>
                <td class="admin-td-actions">
                    <button type="button" class="admin-btn ${u.disabled ? 'admin-btn-enable' : 'admin-btn-disable'}" data-uid="${esc(u.id)}" data-disabled="${!!u.disabled}">
                        <i class="fa ${u.disabled ? 'fa-check-circle' : 'fa-ban'}"></i> ${u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button type="button" class="admin-btn admin-btn-delete" data-uid="${esc(u.id)}" data-name="${esc(n)}"><i class="fa fa-trash-o"></i> Delete</button>
                </td>`;
            const deleteBtn = tr.querySelector('.admin-btn-delete');
            const disableBtn = tr.querySelector('.admin-btn-disable, .admin-btn-enable');
            if (deleteBtn) deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); openModal(u); });
            if (disableBtn) disableBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDisabled(u); });
            els.tableBody.appendChild(tr);
        });
        els.listWrapper?.classList.toggle('is-hidden', list.length === 0);
        els.empty?.classList.toggle('is-hidden', list.length > 0);
    }
    async function loadUsers() {
        setAdminError(false);
        setAdminLoading(true);
        try {
            const res = await callables.listUsers({});
            const users = res.data?.users || [];
            const myUid = auth.currentUser?.uid;
            allUsers = myUid ? users.filter((u) => u.id !== myUid) : users;
            setAdminLoading(false);
            renderUsers();
        } catch (e) {
            console.error('List users error:', e);
            setAdminLoading(false);
            setAdminError(true, e.message || 'Failed to load users. Deploy Cloud Functions and ensure you are an admin.');
        }
    }
    async function toggleDisabled(u) {
        const newDisabled = !u.disabled;
        const action = newDisabled ? 'disable' : 'enable';
        if (!confirm(`${action === 'disable' ? 'Disable' : 'Enable'} "${nameOf(u)}"?`)) return;
        try {
            await callables.disableUser({ uid: u.id, disabled: newDisabled });
            u.disabled = newDisabled;
            renderUsers();
            loadReport();
        } catch (e) {
            console.error(e);
            alert(e.message || 'Action failed.');
        }
    }
    function openModal(u) {
        currentUser = u;
        if (els.modalName) els.modalName.textContent = nameOf(u);
        if (els.modalEmail) els.modalEmail.textContent = u.email || '—';
        if (els.modalRole) { els.modalRole.textContent = u.role || '—'; els.modalRole.className = 'admin-badge admin-badge-' + (u.role || 'petOwner'); }
        if (els.modalStatus) {
            els.modalStatus.textContent = u.disabled ? 'Disabled' : 'Active';
            els.modalStatus.className = 'admin-badge ' + (u.disabled ? 'admin-badge-disabled' : 'admin-badge-active');
        }
        if (els.disableBtn) {
            els.disableBtn.innerHTML = u.disabled ? '<i class="fa fa-check-circle"></i> Enable account' : '<i class="fa fa-ban"></i> Disable account';
        }
        if (els.disableLabel) els.disableLabel.textContent = u.disabled ? 'Enable' : 'Disable';
        els.overlay?.classList.remove('is-hidden');
        els.modal?.classList.remove('is-hidden');
    }
    function closeModal() {
        currentUser = null;
        els.overlay?.classList.add('is-hidden');
        els.modal?.classList.add('is-hidden');
    }
    /** Get user-facing message from Firebase callable or generic error. */
    function getErrorMessage(e) {
        if (!e) return 'Delete failed.';
        return e.message || (e.details && (typeof e.details === 'string' ? e.details : e.details.message)) || e.code || 'Delete failed.';
    }
    async function doDelete() {
        if (!currentUser) return;
        if (!confirm(`Permanently delete "${nameOf(currentUser)}"? This removes their account and all related data. This cannot be undone.`)) return;
        const uidToRemove = currentUser.id;
        try {
            await callables.deleteUser({ uid: uidToRemove });
            allUsers = allUsers.filter(x => x.id !== uidToRemove);
            closeModal();
            renderUsers();
            loadReport().catch((err) => console.warn('Report refresh after delete:', err));
        } catch (e) {
            console.error('Delete user failed:', e);
            alert(getErrorMessage(e));
        }
    }
    async function doDisableInModal() {
        if (!currentUser) return;
        const newDisabled = !currentUser.disabled;
        try {
            await callables.disableUser({ uid: currentUser.id, disabled: newDisabled });
            currentUser.disabled = newDisabled;
            const idx = allUsers.findIndex(x => x.id === currentUser.id);
            if (idx !== -1) allUsers[idx] = { ...currentUser };
            openModal(currentUser);
            renderUsers();
            loadReport();
        } catch (e) {
            console.error(e);
            alert(e.message || 'Action failed.');
        }
    }

    function init() {
        loadReport();
        loadUsers();
        els.reportsRefresh?.addEventListener('click', loadReport);
        els.adminRefresh?.addEventListener('click', loadUsers);
        els.filterRole?.addEventListener('change', renderUsers);
        els.filterStatus?.addEventListener('change', renderUsers);
        els.search?.addEventListener('input', renderUsers);
        els.search?.addEventListener('search', renderUsers);
        els.overlay?.addEventListener('click', closeModal);
        els.closeBtn?.addEventListener('click', closeModal);
        els.modal?.addEventListener('click', e => e.stopPropagation());
        els.disableBtn?.addEventListener('click', doDisableInModal);
        els.deleteBtn?.addEventListener('click', doDelete);

        els.createVetBtn?.addEventListener('click', openCreateVetModal);
        els.createVetOverlay?.addEventListener('click', closeCreateVetModal);
        els.createVetClose?.addEventListener('click', closeCreateVetModal);
        els.createVetCancel?.addEventListener('click', closeCreateVetModal);
        els.createVetSubmit?.addEventListener('click', submitCreateVet);
        els.createVetModal?.addEventListener('click', (e) => e.stopPropagation());
    }

    function openCreateVetModal() {
        els.createVetForm?.reset();
        els.createVetStepForm?.classList.remove('is-hidden');
        els.createVetStepSuccess?.classList.add('is-hidden');
        if (els.createVetSubmit) { els.createVetSubmit.classList.remove('is-hidden'); els.createVetSubmit.innerHTML = '<i class="fa fa-user-plus"></i> Create Account'; }
        if (els.createVetCancel) els.createVetCancel.textContent = 'Cancel';
        els.createVetOverlay?.classList.remove('is-hidden');
        els.createVetModal?.classList.remove('is-hidden');
    }
    function closeCreateVetModal() {
        els.createVetOverlay?.classList.add('is-hidden');
        els.createVetModal?.classList.add('is-hidden');
    }
    async function submitCreateVet() {
        if (els.createVetStepSuccess && !els.createVetStepSuccess.classList.contains('is-hidden')) {
            closeCreateVetModal();
            return;
        }
        const firstName = $('create-vet-fname')?.value?.trim();
        const lastName = $('create-vet-lname')?.value?.trim();
        const password = $('create-vet-password')?.value;
        const confirm = $('create-vet-confirm')?.value;
        const email = $('create-vet-email')?.value?.trim();
        if (!firstName || !lastName) return alert('Please enter the veterinarian\'s full name.');
        if (!password || password.length < 6) return alert('Password must be at least 6 characters.');
        if (password !== confirm) return alert('Passwords do not match.');
        if (!email) return alert('Please enter an email address.');
        const emailLower = email.trim().toLowerCase();
        const atIdx = emailLower.indexOf('@');
        if (atIdx <= 0 || atIdx === emailLower.length - 1 || emailLower.length > 254) {
            return alert('Please enter a valid email address.');
        }
        const local = emailLower.slice(0, atIdx);
        const domain = emailLower.slice(atIdx + 1);
        if (!local || !domain || local.endsWith('.') || local.startsWith('.') || domain.startsWith('.') || domain.endsWith('.') || domain.indexOf('.') <= 0 || domain.length < 4 || /\.@|@\.|\.\./.test(emailLower) || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(emailLower)) {
            return alert('Please enter a valid email address.');
        }
        const submitBtn = els.createVetSubmit;
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Creating…'; }
        try {
            const continueUrl = `${window.location.protocol}//${window.location.host}${withAppBase('/auth.html')}?verified=true`;
            await callables.createVetUser({ email, password, firstName, lastName, continueUrl });
            els.createVetStepForm?.classList.add('is-hidden');
            els.createVetStepSuccess?.classList.remove('is-hidden');
            if (els.createVetSuccessEmail) els.createVetSuccessEmail.textContent = email;
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Done'; }
            if (els.createVetCancel) els.createVetCancel.classList.add('is-hidden');
            loadUsers();
            loadReport();
        } catch (e) {
            console.error('Create vet error:', e);
            alert(e.message || 'Failed to create vet account.');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa fa-user-plus"></i> Create Account'; }
        }
    }

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
