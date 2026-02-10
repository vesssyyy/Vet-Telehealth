/**
 * Televet Health — Pet Manager: CRUD, Firestore sync, dashboard UI
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const SPECIES_OPTIONS = ['Dog', 'Cat'];
const SELECTED_PET_STORAGE_KEY = 'telehealthSelectedPetId';
const TOAST_DURATION = 3500;

let currentUserId = null;
let currentPetId = null;
let currentPet = null;
let editPetId = null;
let petsUnsubscribe = null;
let firstPetsLoadDone = false;

const petsRef = (uid) => collection(db, 'users', uid, 'pets');

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
function formatAge(age) {
    if (age == null || age === '') return '—';
    const n = Number(age);
    return Number.isNaN(n) ? String(age) : n === 1 ? '1 Year' : `${n} Years`;
}
function formatWeight(weight) {
    if (weight == null || weight === '') return '—';
    const n = Number(weight);
    return Number.isNaN(n) ? String(weight) : `${n} kg`;
}
function speciesIcon(species, extraClass = '') {
    const isCat = (species || '').toLowerCase() === 'cat';
    const cls = extraClass ? ` ${extraClass}` : '';
    return isCat ? `<i class="fa-solid fa-cat${cls}" aria-hidden="true"></i>` : `<i class="fa fa-paw${cls}" aria-hidden="true"></i>`;
}

function setPanelOpen(open) {
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const method = open ? 'add' : 'remove';
    panel?.classList[method]('is-open');
    overlay?.classList[method]('is-open');
    overlay?.setAttribute('aria-hidden', !open);
    panel?.setAttribute('aria-hidden', !open);
    document.body.style.overflow = open ? 'hidden' : '';
}
function resetPanelForm() {
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');
    editPetId = null;
    form?.reset();
    clearFormErrors();
    if (titleEl) titleEl.innerHTML = '<i class="fa fa-paw" aria-hidden="true"></i> Add Pet';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
}
function showToast(id) {
    const toast = document.getElementById(id);
    if (!toast) return;
    toast.classList.add('is-visible');
    toast.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        toast.classList.remove('is-visible');
        toast.setAttribute('aria-hidden', 'true');
    }, TOAST_DURATION);
}
function clearFormErrors() {
    document.querySelectorAll('.add-pet-field.is-error').forEach((el) => el.classList.remove('is-error'));
    document.querySelectorAll('.add-pet-error-msg').forEach((el) => el.remove());
}
function showFieldError(field, message) {
    if (!field) return;
    field.classList.add('is-error');
    const msg = document.createElement('span');
    msg.className = 'add-pet-error-msg';
    msg.textContent = message;
    msg.setAttribute('role', 'alert');
    field.appendChild(msg);
}

function init() {
    bindAddPetPanel();
    bindEditPetInfoButton();
    document.addEventListener('click', (e) => {
        const openDropdown = document.querySelector('.pet-switch-dropdown.is-open');
        if (openDropdown && !openDropdown.contains(e.target)) {
            openDropdown.classList.remove('is-open');
            openDropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
        }
    });

    onAuthStateChanged(auth, (user) => {
        if (petsUnsubscribe) {
            petsUnsubscribe();
            petsUnsubscribe = null;
        }
        currentUserId = user?.uid || null;
        currentPetId = null;
        if (!user) {
            renderEmptyState();
            return;
        }
        firstPetsLoadDone = false;
        petsUnsubscribe = onSnapshot(
            petsRef(user.uid),
            (snapshot) => {
                let pets = snapshot.docs.map((d) => {
                    const data = d.data();
                    return { id: d.id, ...data, createdAt: data.createdAt };
                });
                pets = pets.sort((a, b) => {
                    const at = a.createdAt?.toMillis?.() ?? a.createdAt?.getTime?.() ?? 0;
                    const bt = b.createdAt?.toMillis?.() ?? b.createdAt?.getTime?.() ?? 0;
                    return bt - at;
                });
                if (pets.length === 0) {
                    currentPetId = null;
                    currentPet = null;
                    renderEmptyState();
                } else {
                    try {
                        const saved = localStorage.getItem(`${SELECTED_PET_STORAGE_KEY}:${currentUserId}`);
                        if (saved && pets.some((p) => p.id === saved)) currentPetId = saved;
                    } catch (_) {}
                    if (!currentPetId || !pets.some((p) => p.id === currentPetId)) currentPetId = pets[0].id;
                    currentPet = pets.find((p) => p.id === currentPetId) || pets[0];
                    renderPetProfile(pets);
                }
                const fromServer = !snapshot.metadata?.fromCache;
                if (fromServer && !firstPetsLoadDone) {
                    firstPetsLoadDone = true;
                    window.dispatchEvent(new CustomEvent('petsReady'));
                }
            },
            (err) => {
                console.error('Pet snapshot error:', err);
                renderEmptyState();
                if (!firstPetsLoadDone) {
                    firstPetsLoadDone = true;
                    window.dispatchEvent(new CustomEvent('petsReady'));
                }
            }
        );
    });
}

function renderEmptyState() {
    const card = document.querySelector('.pet-profile-card');
    if (!card) return;
    document.getElementById('dashboard-content')?.classList.add('has-no-pets');
    card.innerHTML = `
        <div class="pet-empty-state">
            <div class="pet-empty-icon" aria-hidden="true"><i class="fa fa-paw"></i></div>
            <h2 class="pet-empty-title">You don't have any pets yet…</h2>
            <p class="pet-empty-desc">looks like it's a little too quiet here 😄 Add one now!</p>
            <button type="button" class="btn btn-primary btn-add-pet" aria-label="Add pet"><i class="fa fa-plus" aria-hidden="true"></i> Add Pet</button>
        </div>`;
    bindAddPetButton(card);
}

function renderPetProfile(pets) {
    const card = document.querySelector('.pet-profile-card');
    if (!card) return;
    document.getElementById('dashboard-content')?.classList.remove('has-no-pets');
    const active = pets.find((p) => p.id === currentPetId) || pets[0];
    if (!active) return;
    currentPet = active;
    const avatarUrl = active.imageUrl || '';
    const fallbackClass = avatarUrl ? '' : ' visible';
    const dropdownItems = [...pets]
        .sort((a, b) => (a.id === currentPetId ? -1 : 0) - (b.id === currentPetId ? -1 : 0))
        .map((p) => `<button type="button" class="dropdown-item ${p.id === currentPetId ? 'active' : ''}" role="menuitem" data-pet-id="${p.id}">${speciesIcon(p.species, ' dropdown-item-icon')}<span>${escapeHtml(p.name)}</span></button>`)
        .join('');
    card.innerHTML = `
        <div class="pet-profile-header">
            <div class="pet-profile-left">
                <div class="pet-avatar-wrap">
                    <img class="pet-avatar-img" src="${escapeHtml(avatarUrl) || '#'}" alt="${escapeHtml(active.name)}" onerror="this.style.display='none';this.nextElementSibling.classList.add('visible')">
                    <span class="pet-avatar-fallback${fallbackClass}" aria-hidden="true">${speciesIcon(active.species)}</span>
                </div>
                <div class="pet-info">
                    <h2 class="pet-name">${escapeHtml(active.name)}</h2>
                    <div class="pet-meta">
                        <span class="pet-meta-item"><i class="fa fa-birthday-cake" aria-hidden="true"></i> ${formatAge(active.age)}</span>
                        <span class="pet-meta-item"><i class="fa fa-balance-scale" aria-hidden="true"></i> ${formatWeight(active.weight)}</span>
                        <span class="pet-meta-item">${speciesIcon(active.species)} ${escapeHtml(active.species || '—')}</span>
                    </div>
                </div>
            </div>
            <div class="pet-actions">
                ${pets.length > 1 ? `
                <div class="dropdown pet-switch-dropdown">
                    <button type="button" class="btn btn-secondary dropdown-trigger" aria-expanded="false" aria-haspopup="true" aria-label="Switch pet" title="Switch to another pet">
                        <i class="fa fa-exchange" aria-hidden="true"></i> Switch Pet <i class="fa fa-chevron-down dropdown-caret" aria-hidden="true"></i>
                    </button>
                    <div class="dropdown-menu" role="menu" aria-label="Pet list">${dropdownItems}</div>
                </div>` : ''}
                <button type="button" class="btn btn-outline btn-add-pet" title="Add a new pet"><i class="fa fa-plus" aria-hidden="true"></i> Add Pet</button>
            </div>
        </div>`;
    const img = card.querySelector('.pet-avatar-img');
    if (img) img.style.display = avatarUrl ? '' : 'none';
    if (avatarUrl && img) img.src = avatarUrl;
    bindAddPetButton(card);
    bindPetSwitch(card, pets);
}

function bindAddPetButton(container) {
    container?.querySelector('.btn-add-pet')?.addEventListener('click', () => openAddPetPanel());
}
function bindEditPetInfoButton() {
    document.getElementById('edit-pet-info-btn')?.addEventListener('click', () => {
        currentPet ? openEditPetPanel(currentPet) : openAddPetPanel();
    });
}

function openEditPetPanel(pet) {
    editPetId = pet.id;
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (titleEl) titleEl.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i> Edit Pet';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Update';
    populateSpeciesSelect();
    const speciesSelect = document.getElementById('add-pet-species');
    if (speciesSelect?.options.length > 1) {
        const opt = Array.from(speciesSelect.options).find((o) => o.value === (pet.species || ''));
        if (opt) speciesSelect.value = opt.value;
    }
    const setVal = (sel, val) => { const el = form?.querySelector(sel); if (el) el.value = val != null && val !== '' ? String(val) : ''; };
    setVal('[name="petName"]', pet.name);
    setVal('[name="breed"]', pet.breed);
    setVal('[name="sex"]', pet.sex);
    setVal('[name="age"]', pet.age);
    setVal('[name="weight"]', pet.weight);
    setPanelOpen(true);
    setTimeout(() => form?.querySelector('[name="petName"]')?.focus(), 100);
}

function bindPetSwitch(card, pets) {
    const dropdown = card.querySelector('.pet-switch-dropdown');
    if (!dropdown) return;
    const trigger = dropdown.querySelector('.dropdown-trigger');
    const setOpen = (open) => {
        dropdown.classList.toggle('is-open', open);
        trigger?.setAttribute('aria-expanded', open);
    };
    trigger?.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!dropdown.classList.contains('is-open')); });
    dropdown.addEventListener('click', (e) => e.stopPropagation());
    dropdown.querySelectorAll('.dropdown-item').forEach((item) => {
        item.addEventListener('click', function () {
            currentPetId = this.dataset.petId || null;
            try { if (currentUserId) localStorage.setItem(`${SELECTED_PET_STORAGE_KEY}:${currentUserId}`, currentPetId || ''); } catch (_) {}
            if (pets.length) renderPetProfile(pets);
            setOpen(false);
        });
    });
}

function bindAddPetPanel() {
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const form = document.getElementById('add-pet-form');
    const close = () => {
        resetPanelForm();
        setPanelOpen(false);
    };
    overlay?.addEventListener('click', close);
    document.getElementById('add-pet-close')?.addEventListener('click', close);
    document.getElementById('add-pet-cancel')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel?.classList.contains('is-open')) close(); });
    form?.addEventListener('submit', (e) => { e.preventDefault(); handleAddPetSubmit(form); });
}

function openAddPetPanel() {
    setPanelOpen(true);
    populateSpeciesSelect();
    setTimeout(() => document.getElementById('add-pet-form')?.querySelector('[name="petName"]')?.focus(), 100);
}
function populateSpeciesSelect() {
    const select = document.getElementById('add-pet-species');
    if (!select || select.options.length > 1) return;
    select.innerHTML = '<option value="">Select species…</option>' + SPECIES_OPTIONS.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

async function handleAddPetSubmit(form) {
    const get = (name) => (form.querySelector(`[name="${name}"]`)?.value || '').trim();
    const name = get('petName');
    const species = get('species');
    const breed = get('breed');
    const sex = get('sex');
    const age = get('age');
    const weight = get('weight');
    clearFormErrors();
    const nameField = form.querySelector('[name="petName"]')?.closest('.add-pet-field');
    if (!name) { showFieldError(nameField, 'Pet name is required'); return; }
    if (!species) { showFieldError(form.querySelector('[name="species"]')?.closest('.add-pet-field'), 'Please select a species'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    const isEdit = !!editPetId;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa fa-spinner fa-spin"></i> ${isEdit ? 'Updating…' : 'Saving…'}`;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
        alert(`You must be signed in to ${isEdit ? 'update' : 'add'} a pet.`);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = isEdit ? '<i class="fa fa-check" aria-hidden="true"></i> Update' : '<i class="fa fa-check" aria-hidden="true"></i> Add Pet'; }
        return;
    }
    const petData = { name, species, breed: breed || null, sex: sex || null, age: age ? Number(age) : null, weight: weight ? Number(weight) : null, imageUrl: null };
    try {
        if (isEdit) {
            if (!confirm("Are you sure you want to update this pet's information?")) return;
            await updateDoc(doc(db, 'users', uid, 'pets', editPetId), petData);
            setPanelOpen(false);
            resetPanelForm();
            showToast('update-pet-success-toast');
        } else {
            await addDoc(petsRef(uid), { ...petData, createdAt: serverTimestamp() });
            setPanelOpen(false);
            form.reset();
            clearFormErrors();
            showToast('add-pet-success-toast');
        }
    } catch (err) {
        console.error(isEdit ? 'Update pet error:' : 'Add pet error:', err);
        const code = String(err?.code || err?.message || '');
        if (code.includes('permission-denied') || code.includes('PERMISSION_DENIED')) {
            alert('Permission denied. Please add Firestore rules for users/{userId}/pets in Firebase Console.');
        } else {
            alert(`Failed to ${isEdit ? 'update' : 'add'} pet: ${err?.message || 'Please try again.'}`);
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = isEdit ? '<i class="fa fa-check" aria-hidden="true"></i> Update' : '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
        }
    }
}

document.addEventListener('DOMContentLoaded', init);
