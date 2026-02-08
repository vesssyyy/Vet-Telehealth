/**
 * Televet Health — Pet Manager
 * Handles pet CRUD, Firestore sync, and dashboard UI updates
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection,
    doc,
    addDoc,
    updateDoc,
    onSnapshot,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const SPECIES_OPTIONS = ['Dog', 'Cat'];
const SEX_OPTIONS = ['Male', 'Female'];

let currentUserId = null;
let currentPetId = null;
let currentPet = null;
let editPetId = null;
let petsUnsubscribe = null;

/**
 * Get pets collection reference for current user
 */
const petsRef = (uid) => collection(db, 'users', uid, 'pets');

/**
 * Initialize pet manager: listen to auth and pets, render UI
 */
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
                    if (!currentPetId || !pets.some((p) => p.id === currentPetId)) {
                        currentPetId = pets[0].id;
                    }
                    currentPet = pets.find((p) => p.id === currentPetId) || pets[0];
                    renderPetProfile(pets);
                }
            },
            (err) => {
                console.error('Pet snapshot error:', err);
                renderEmptyState();
            }
        );
    });
}

/**
 * Render empty state when user has no pets
 */
function renderEmptyState() {
    const card = document.querySelector('.pet-profile-card');
    if (!card) return;

    card.innerHTML = `
        <div class="pet-empty-state">
            <div class="pet-empty-icon" aria-hidden="true"><i class="fa fa-paw"></i></div>
            <h2 class="pet-empty-title">You don't have any pets yet…</h2>
            <p class="pet-empty-desc">looks like it's a little too quiet here 😄 Add one now!</p>
            <button type="button" class="btn btn-primary btn-add-pet" aria-label="Add pet">
                <i class="fa fa-plus" aria-hidden="true"></i> Add Pet
            </button>
        </div>
    `;
    bindAddPetButton(card);
}

/**
 * Render pet profile bar with switch dropdown
 */
function renderPetProfile(pets) {
    const card = document.querySelector('.pet-profile-card');
    if (!card) return;

    const active = pets.find((p) => p.id === currentPetId) || pets[0];
    if (!active) return;

    currentPet = active;

    const avatarUrl = active.imageUrl || '';
    const fallbackClass = avatarUrl ? '' : ' visible';
    const speciesIcon = (active.species || '').toLowerCase() === 'cat' ? '<i class="fa-solid fa-cat" aria-hidden="true"></i>' : '<i class="fa fa-paw" aria-hidden="true"></i>';

    const getSpeciesIcon = (species) => (species || '').toLowerCase() === 'cat' ? '<i class="fa-solid fa-cat dropdown-item-icon" aria-hidden="true"></i>' : '<i class="fa fa-paw dropdown-item-icon" aria-hidden="true"></i>';

    const petsForDropdown = [...pets].sort((a, b) => (a.id === currentPetId ? -1 : 0) - (b.id === currentPetId ? -1 : 0));
    const dropdownItems = petsForDropdown
        .map(
            (p) =>
                `<button type="button" class="dropdown-item ${p.id === currentPetId ? 'active' : ''}" role="menuitem" data-pet-id="${p.id}">${getSpeciesIcon(p.species)}<span>${escapeHtml(p.name)}</span></button>`
        )
        .join('');

    card.innerHTML = `
        <div class="pet-profile-header">
            <div class="pet-profile-left">
                <div class="pet-avatar-wrap">
                    <img class="pet-avatar-img" src="${escapeHtml(avatarUrl) || '#'}" alt="${escapeHtml(active.name)}" onerror="this.style.display='none';this.nextElementSibling.classList.add('visible')">
                    <span class="pet-avatar-fallback${fallbackClass}" aria-hidden="true">${speciesIcon}</span>
                </div>
                <div class="pet-info">
                    <h2 class="pet-name">${escapeHtml(active.name)}</h2>
                    <div class="pet-meta">
                        <span class="pet-meta-item"><i class="fa fa-birthday-cake" aria-hidden="true"></i> ${formatAge(active.age)}</span>
                        <span class="pet-meta-item"><i class="fa fa-balance-scale" aria-hidden="true"></i> ${formatWeight(active.weight)}</span>
                        <span class="pet-meta-item">${speciesIcon} ${escapeHtml(active.species || '—')}</span>
                    </div>
                </div>
            </div>
            <div class="pet-actions">
                ${pets.length > 1 ? `
                <div class="dropdown pet-switch-dropdown">
                    <button type="button" class="btn btn-secondary dropdown-trigger" aria-expanded="false" aria-haspopup="true" aria-label="Switch pet" title="Switch to another pet">
                        <i class="fa fa-exchange" aria-hidden="true"></i> Switch Pet
                        <i class="fa fa-chevron-down dropdown-caret" aria-hidden="true"></i>
                    </button>
                    <div class="dropdown-menu" role="menu" aria-label="Pet list">${dropdownItems}</div>
                </div>
                ` : ''}
                <button type="button" class="btn btn-outline btn-add-pet" title="Add a new pet"><i class="fa fa-plus" aria-hidden="true"></i> Add Pet</button>
            </div>
        </div>
    `;

    if (avatarUrl) {
        const img = card.querySelector('.pet-avatar-img');
        if (img) img.src = avatarUrl;
    } else {
        const img = card.querySelector('.pet-avatar-img');
        if (img) img.style.display = 'none';
    }

    bindAddPetButton(card);
    bindPetSwitch(card, pets);
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatAge(age) {
    if (age == null || age === '') return '—';
    const n = Number(age);
    if (Number.isNaN(n)) return String(age);
    return n === 1 ? '1 Year' : `${n} Years`;
}

function formatWeight(weight) {
    if (weight == null || weight === '') return '—';
    const n = Number(weight);
    if (Number.isNaN(n)) return String(weight);
    return `${n} kg`;
}

function bindAddPetButton(container) {
    container?.querySelector('.btn-add-pet')?.addEventListener('click', () => openAddPetPanel());
}

/**
 * Edit Pet Info card: open edit panel with current pet or add panel if none
 */
function bindEditPetInfoButton() {
    document.getElementById('edit-pet-info-btn')?.addEventListener('click', () => {
        if (currentPet) {
            openEditPetPanel(currentPet);
        } else {
            openAddPetPanel();
        }
    });
}

/**
 * Open the panel in edit mode with pet data prefilled
 */
function openEditPetPanel(pet) {
    editPetId = pet.id;
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');

    if (titleEl) titleEl.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i> Edit Pet';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Update';

    populateSpeciesSelect();
    const speciesSelect = document.getElementById('add-pet-species');
    if (speciesSelect && speciesSelect.options.length > 1) {
        const opt = Array.from(speciesSelect.options).find((o) => o.value === (pet.species || ''));
        if (opt) speciesSelect.value = opt.value;
    }

    const nameInput = form?.querySelector('[name="petName"]');
    const breedInput = form?.querySelector('[name="breed"]');
    const sexSelect = form?.querySelector('[name="sex"]');
    const ageInput = form?.querySelector('[name="age"]');
    const weightInput = form?.querySelector('[name="weight"]');
    if (nameInput) nameInput.value = pet.name || '';
    if (breedInput) breedInput.value = pet.breed || '';
    if (sexSelect) sexSelect.value = pet.sex || '';
    if (ageInput) ageInput.value = pet.age != null && pet.age !== '' ? String(pet.age) : '';
    if (weightInput) weightInput.value = pet.weight != null && pet.weight !== '' ? String(pet.weight) : '';

    panel?.classList.add('is-open');
    overlay?.classList.add('is-open');
    overlay?.setAttribute('aria-hidden', 'false');
    panel?.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => nameInput?.focus(), 100);
}

function bindPetSwitch(card, pets) {
    const dropdown = card.querySelector('.pet-switch-dropdown');
    if (!dropdown) return;

    const trigger = dropdown.querySelector('.dropdown-trigger');
    const items = dropdown.querySelectorAll('.dropdown-item');

    const setOpen = (open) => {
        dropdown.classList.toggle('is-open', open);
        trigger?.setAttribute('aria-expanded', open);
    };

    trigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(!dropdown.classList.contains('is-open'));
    });
    dropdown.addEventListener('click', (e) => e.stopPropagation());

    items.forEach((item) => {
        item.addEventListener('click', function () {
            currentPetId = this.dataset.petId || null;
            if (pets.length > 0) {
                renderPetProfile(pets);
            }
            setOpen(false);
        });
    });
}

/**
 * Add Pet panel: open, close, form handling
 */
function bindAddPetPanel() {
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const openBtn = document.querySelector('.btn-add-pet');
    const closeBtn = document.getElementById('add-pet-close');
    const form = document.getElementById('add-pet-form');
    const cancelBtn = document.getElementById('add-pet-cancel');

    const open = () => {
        panel?.classList.add('is-open');
        overlay?.classList.add('is-open');
        overlay?.setAttribute('aria-hidden', 'false');
        panel?.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        populateSpeciesSelect();
        setTimeout(() => form?.querySelector('[name="petName"]')?.focus(), 100);
    };

    const close = () => {
        editPetId = null;
        panel?.classList.remove('is-open');
        overlay?.classList.remove('is-open');
        overlay?.setAttribute('aria-hidden', 'true');
        panel?.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        form?.reset();
        clearFormErrors();
        const titleEl = document.getElementById('add-pet-title');
        const submitBtn = form?.querySelector('button[type="submit"]');
        if (titleEl) titleEl.innerHTML = '<i class="fa fa-paw" aria-hidden="true"></i> Add Pet';
        if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
    };

    overlay?.addEventListener('click', close);
    closeBtn?.addEventListener('click', close);
    cancelBtn?.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel?.classList.contains('is-open')) close();
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleAddPetSubmit(form);
    });
}

function openAddPetPanel() {
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const form = document.getElementById('add-pet-form');
    if (panel && overlay) {
        panel.classList.add('is-open');
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        panel.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        populateSpeciesSelect();
        setTimeout(() => form?.querySelector('[name="petName"]')?.focus(), 100);
    }
}

function populateSpeciesSelect() {
    const select = document.getElementById('add-pet-species');
    if (!select || select.options.length > 1) return;
    select.innerHTML = '<option value="">Select species…</option>' + SPECIES_OPTIONS.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

function showAddPetSuccessToast() {
    const toast = document.getElementById('add-pet-success-toast');
    if (!toast) return;
    toast.classList.add('is-visible');
    toast.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        toast.classList.remove('is-visible');
        toast.setAttribute('aria-hidden', 'true');
    }, 3500);
}

function showUpdatePetSuccessToast() {
    const toast = document.getElementById('update-pet-success-toast');
    if (!toast) return;
    toast.classList.add('is-visible');
    toast.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        toast.classList.remove('is-visible');
        toast.setAttribute('aria-hidden', 'true');
    }, 3500);
}

function clearFormErrors() {
    document.querySelectorAll('.add-pet-field.is-error').forEach((el) => el.classList.remove('is-error'));
    document.querySelectorAll('.add-pet-error-msg').forEach((el) => el.remove());
}

function showFieldError(field, message) {
    field.classList.add('is-error');
    const msg = document.createElement('span');
    msg.className = 'add-pet-error-msg';
    msg.textContent = message;
    msg.setAttribute('role', 'alert');
    field.appendChild(msg);
}

async function handleAddPetSubmit(form) {
    const name = (form.querySelector('[name="petName"]')?.value || '').trim();
    const species = (form.querySelector('[name="species"]')?.value || '').trim();
    const breed = (form.querySelector('[name="breed"]')?.value || '').trim();
    const sex = (form.querySelector('[name="sex"]')?.value || '').trim();
    const age = (form.querySelector('[name="age"]')?.value || '').trim();
    const weight = (form.querySelector('[name="weight"]')?.value || '').trim();

    clearFormErrors();

    let hasError = false;
    const nameField = form.querySelector('[name="petName"]')?.closest('.add-pet-field');
    if (!name) {
        if (nameField) showFieldError(nameField, 'Pet name is required');
        hasError = true;
    }
    if (!species) {
        showFieldError(form.querySelector('[name="species"]')?.closest('.add-pet-field'), 'Please select a species');
        hasError = true;
    }
    if (hasError) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    const isEdit = !!editPetId;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> ' + (isEdit ? 'Updating…' : 'Saving…');
    }

    try {
        const uid = auth.currentUser?.uid;
        if (!uid) {
            alert('You must be signed in to ' + (isEdit ? 'update' : 'add') + ' a pet.');
            return;
        }

        const petData = {
            name,
            species,
            breed: breed || null,
            sex: sex || null,
            age: age ? Number(age) : null,
            weight: weight ? Number(weight) : null,
            imageUrl: null
        };

        if (isEdit) {
            if (!confirm('Are you sure you want to update this pet\'s information?')) {
                return;
            }
            const petDocRef = doc(db, 'users', uid, 'pets', editPetId);
            await updateDoc(petDocRef, petData);

            const panelEl = document.getElementById('add-pet-panel');
            const overlayEl = document.getElementById('add-pet-overlay');
            editPetId = null;
            panelEl?.classList.remove('is-open');
            overlayEl?.classList.remove('is-open');
            overlayEl?.setAttribute('aria-hidden', 'true');
            panelEl?.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
            form.reset();
            clearFormErrors();
            const titleEl = document.getElementById('add-pet-title');
            if (titleEl) titleEl.innerHTML = '<i class="fa fa-paw" aria-hidden="true"></i> Add Pet';
            showUpdatePetSuccessToast();
        } else {
            petData.createdAt = serverTimestamp();
            await addDoc(petsRef(uid), petData);

            const panelEl = document.getElementById('add-pet-panel');
            const overlayEl = document.getElementById('add-pet-overlay');
            panelEl?.classList.remove('is-open');
            overlayEl?.classList.remove('is-open');
            overlayEl?.setAttribute('aria-hidden', 'true');
            panelEl?.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
            form.reset();
            clearFormErrors();
            showAddPetSuccessToast();
        }
    } catch (err) {
        console.error(isEdit ? 'Update pet error:' : 'Add pet error:', err);
        const code = err?.code || err?.message || '';
        if (code.includes('permission-denied') || code.includes('PERMISSION_DENIED')) {
            alert('Permission denied. Please add Firestore rules to allow pets. In Firebase Console → Firestore → Rules, add rules for users/{userId}/pets.');
        } else {
            alert('Failed to ' + (isEdit ? 'update' : 'add') + ' pet: ' + (err?.message || 'Please try again.'));
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = isEdit
                ? '<i class="fa fa-check" aria-hidden="true"></i> Update'
                : '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
        }
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
