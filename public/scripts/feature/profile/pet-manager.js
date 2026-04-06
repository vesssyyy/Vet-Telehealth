/**
 * Televet Health — Pet Manager: CRUD, Firestore sync, dashboard UI
 */
import { auth, db, storage } from '../../core/firebase/firebase-config.js';
import { escapeHtml, formatDisplayName } from '../../core/app/utils.js';
import { openProfilePhotoCrop } from '../../core/app/profile-photo-crop.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
    onSnapshot,
    serverTimestamp,
    getDocs,
    query,
    where,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';
import { APPOINTMENTS_COLLECTION } from '../appointment/shared/constants.js';
import { appointmentBlocksRemoval } from '../appointment/shared/appointment-blocking.js';
import { appAlertError, appConfirm } from '../../core/ui/app-dialog.js';

const SPECIES_OPTIONS = ['Dog', 'Cat'];
/** Filipino native first; other breeds common locally (≥5 each); last option is always “Others”. */
const BREED_DOG_OPTIONS = ['Aspin', 'Poodle', 'Shih Tzu', 'Beagle', 'Chihuahua'];
const BREED_CAT_OPTIONS = ['Puspin', 'Persian', 'Siamese', 'British Shorthair', 'Maine Coon'];
const BREED_OTHER_VALUE = '__other__';
/** Shown when the select is closed; `disabled` + `hidden` keeps it out of the dropdown list. */
function selectPlaceholderOptionHtml(label) {
    return `<option value="" disabled hidden selected>${escapeHtml(label)}</option>`;
}
const SELECTED_PET_STORAGE_KEY = 'telehealthSelectedPetId';
const TOAST_DURATION = 3500;

const pathname = typeof window !== 'undefined' ? (window.location.pathname || '') : '';
const IS_PROFILE_PETS_PAGE = /petowner\/profile\.html$/i.test(pathname) || /\/profile\.html$/i.test(pathname);
const IS_DASHBOARD_PAGE = /dashboard\.html$/i.test(pathname);

let currentUserId = null;
let currentPetId = null;
let currentPet = null;
let editPetId = null;
let petsUnsubscribe = null;
let firstPetsLoadDone = false;
/** Pending cropped pet photo (create or edit). Cleared on cancel/panel close. */
let pendingPetPhoto = null; // { file: File, objectUrl: string } | null
/** When editing: user chose to remove the current pet photo. */
let petPhotoRemoved = false;
/** Pet currently shown in Manage Pet modal (for delete). */
let managePetTarget = null;

const petsRef = (uid) => collection(db, 'users', uid, 'pets');
const appointmentsCol = () => collection(db, APPOINTMENTS_COLLECTION);

/**
 * True if the pet has any ongoing or upcoming appointment for this owner.
 * Uses owner-only query to avoid composite index requirement.
 */
async function petHasBlockingAppointments(ownerId, petId) {
    if (!ownerId || !petId) return false;
    const snap = await getDocs(query(appointmentsCol(), where('ownerId', '==', ownerId)));
    return snap.docs.some((d) => {
        const x = d.data();
        const pid = x.petId ?? x.petID ?? '';
        if (String(pid) !== String(petId)) return false;
        return appointmentBlocksRemoval(x);
    });
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

function breedOptionsForSpecies(species) {
    const s = (species || '').trim().toLowerCase();
    if (s === 'cat') return BREED_CAT_OPTIONS;
    return BREED_DOG_OPTIONS;
}

function populateBreedSelectForSpecies(species) {
    const select = document.getElementById('add-pet-breed-select');
    const otherWrap = document.getElementById('add-pet-breed-other-wrap');
    const otherInput = document.getElementById('add-pet-breed-other');
    if (!select) return;
    const sp = (species || '').trim();
    if (!sp) {
        select.disabled = true;
        select.innerHTML = selectPlaceholderOptionHtml('Select species first…');
        if (otherWrap) otherWrap.hidden = true;
        if (otherInput) otherInput.value = '';
        onBreedSelectChange();
        return;
    }
    select.disabled = false;
    const breeds = breedOptionsForSpecies(sp);
    select.innerHTML =
        selectPlaceholderOptionHtml('Select breed…') +
        breeds.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('') +
        `<option value="${BREED_OTHER_VALUE}">Others</option>`;
    if (otherWrap) otherWrap.hidden = true;
    if (otherInput) otherInput.value = '';
    onBreedSelectChange();
}

function onBreedSelectChange() {
    const select = document.getElementById('add-pet-breed-select');
    const wrap = document.getElementById('add-pet-breed-other-wrap');
    const otherInput = document.getElementById('add-pet-breed-other');
    if (!wrap) return;
    if (!select || select.disabled) {
        wrap.hidden = true;
        if (otherInput) otherInput.value = '';
        return;
    }
    const isOther = select.value === BREED_OTHER_VALUE;
    wrap.hidden = !isOther;
    if (!isOther && otherInput) otherInput.value = '';
    if (isOther) {
        queueMicrotask(() => {
            wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            otherInput?.focus();
        });
    }
}

function syncBreedUiToSpecies() {
    const species = (document.getElementById('add-pet-species')?.value || '').trim();
    populateBreedSelectForSpecies(species);
}

function resolveBreedFromForm(form) {
    const select = form.querySelector('[name="breedSelect"]');
    const other = form.querySelector('[name="breedOther"]');
    if (!select || select.disabled) return '';
    const v = (select.value || '').trim();
    if (!v || v === BREED_OTHER_VALUE) {
        return v === BREED_OTHER_VALUE ? (other?.value || '').trim() : '';
    }
    return v;
}

/** After options exist, set select + optional “Others” text from stored breed string. */
function applyStoredBreedToForm(petBreed, species) {
    populateBreedSelectForSpecies(species);
    const select = document.getElementById('add-pet-breed-select');
    const otherInput = document.getElementById('add-pet-breed-other');
    const breed = (petBreed || '').trim();
    if (!breed || !select || select.disabled) return;
    const match = Array.from(select.options).find((o) => o.value === breed);
    if (match) {
        select.value = breed;
        if (otherInput) otherInput.value = '';
        onBreedSelectChange();
        return;
    }
    select.value = BREED_OTHER_VALUE;
    if (otherInput) otherInput.value = breed;
    onBreedSelectChange();
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
function clearPendingPetPhoto() {
    if (pendingPetPhoto?.objectUrl) URL.revokeObjectURL(pendingPetPhoto.objectUrl);
    pendingPetPhoto = null;
    petPhotoRemoved = false;
}

function updatePetImageBoxUI(displayUrl) {
    const preview = document.getElementById('add-pet-image-preview');
    const placeholder = document.getElementById('add-pet-image-placeholder');
    const actions = document.getElementById('add-pet-image-actions');
    const hasPhoto = Boolean(displayUrl);
    const revealPreview = () => {
        preview?.classList.remove('is-loading');
        if (preview) preview.onload = null;
        placeholder?.classList.add('is-hidden');
    };
    if (preview) {
        preview.onload = null;
        preview.onerror = null;
        preview.classList.remove('is-loading');
        if (hasPhoto) {
            preview.classList.remove('is-hidden');
            preview.classList.add('is-loading');
            placeholder?.classList.remove('is-hidden');
            preview.onload = () => {
                revealPreview();
            };
            preview.onerror = () => {
                preview.onerror = null;
                preview.onload = null;
                preview.classList.remove('is-loading');
                preview.removeAttribute('src');
                preview.classList.add('is-hidden');
                placeholder?.classList.remove('is-hidden');
                actions?.classList.remove('is-hidden');
            };
            preview.src = displayUrl;
            if (preview.complete && preview.naturalWidth > 0) {
                revealPreview();
            }
        } else {
            preview.removeAttribute('src');
            preview.classList.add('is-hidden');
        }
    }
    if (placeholder && !hasPhoto) placeholder.classList.remove('is-hidden');
    if (actions) actions.classList.toggle('is-hidden', !hasPhoto);
}

function resetPanelForm() {
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');
    editPetId = null;
    clearPendingPetPhoto();
    updatePetImageBoxUI(null);
    form?.reset();
    clearFormErrors();
    populateSpeciesSelect(true);
    syncBreedUiToSpecies();
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

function setManagePetModalOpen(open) {
    const overlay = document.getElementById('manage-pet-overlay');
    const modal = document.getElementById('manage-pet-modal');
    const method = open ? 'add' : 'remove';
    overlay?.classList[method]('is-open');
    modal?.classList[method]('is-open');
    overlay?.setAttribute('aria-hidden', !open);
    modal?.setAttribute('aria-hidden', !open);
    if (!open) managePetTarget = null;
}

async function refreshManagePetDeleteState() {
    const delBtn = document.getElementById('manage-pet-delete');
    const hint = document.getElementById('manage-pet-delete-hint');
    const pet = managePetTarget;
    const uid = currentUserId;
    if (!delBtn || !hint || !pet || !uid) return;
    delBtn.disabled = true;
    delBtn.textContent = 'Checking…';
    hint.classList.add('is-hidden');
    try {
        const blocked = await petHasBlockingAppointments(uid, pet.id);
        if (blocked) {
            hint.textContent = 'This pet cannot be removed while they have an ongoing or upcoming appointment. Once those visits are completed, you can remove them.';
            hint.classList.remove('is-hidden');
            delBtn.disabled = true;
        } else {
            delBtn.disabled = false;
        }
    } catch (err) {
        console.error('Manage pet — appointment check:', err);
        hint.textContent = 'Could not verify appointments. Please try again.';
        hint.classList.remove('is-hidden');
        delBtn.disabled = true;
    } finally {
        delBtn.textContent = 'Remove pet';
    }
}

function openManagePetModal(pet) {
    if (!pet?.id) return;
    managePetTarget = pet;
    const titleEl = document.getElementById('manage-pet-title');
    const introEl = document.getElementById('manage-pet-intro');
    if (titleEl) titleEl.textContent = `Remove ${pet.name ? formatDisplayName(pet.name) : 'this pet'}?`;
    if (introEl) {
        introEl.textContent = 'You can remove a pet when they have no ongoing or upcoming visits. Completed past appointments do not block removal. Use Edit to change their details.';
    }
    const delBtn = document.getElementById('manage-pet-delete');
    if (delBtn) delBtn.disabled = true;
    document.getElementById('manage-pet-delete-hint')?.classList.add('is-hidden');
    setManagePetModalOpen(true);
    refreshManagePetDeleteState();
}

function bindManagePetModal() {
    const overlay = document.getElementById('manage-pet-overlay');
    const cancel = document.getElementById('manage-pet-cancel');
    const delBtn = document.getElementById('manage-pet-delete');
    overlay?.addEventListener('click', () => setManagePetModalOpen(false));
    cancel?.addEventListener('click', () => setManagePetModalOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('manage-pet-modal')?.classList.contains('is-open')) {
            setManagePetModalOpen(false);
        }
    });
    delBtn?.addEventListener('click', async () => {
        const pet = managePetTarget;
        const uid = auth.currentUser?.uid;
        if (!pet?.id || !uid) return;
        if (delBtn.disabled) return;
        if (await petHasBlockingAppointments(uid, pet.id)) {
            await appAlertError('This pet still has an ongoing or upcoming appointment and cannot be removed yet.');
            refreshManagePetDeleteState();
            return;
        }
        if (!(await appConfirm(`Remove ${pet.name ? formatDisplayName(pet.name) : 'this pet'} from your account? This cannot be undone.`, { confirmText: 'Yes', cancelText: 'No' }))) return;
        delBtn.disabled = true;
        delBtn.textContent = 'Removing…';
        try {
            const path = `pet-photos/${uid}/${pet.id}`;
            try { await deleteObject(ref(storage, path)); } catch (_) { /* may not exist */ }
            await deleteDoc(doc(db, 'users', uid, 'pets', pet.id));
            try {
                if (currentPetId === pet.id) {
                    currentPetId = null;
                    localStorage.removeItem(`${SELECTED_PET_STORAGE_KEY}:${uid}`);
                }
            } catch (_) {}
            setManagePetModalOpen(false);
            showToast('remove-pet-success-toast');
        } catch (err) {
            console.error('Remove pet error:', err);
            await appAlertError(err?.message || 'Could not remove this pet. Please try again.');
        } finally {
            delBtn.disabled = false;
            delBtn.textContent = 'Remove pet';
        }
    });
}

function init() {
    bindAddPetPanel();
    if (IS_DASHBOARD_PAGE) bindEditPetInfoButton();
    if (IS_PROFILE_PETS_PAGE) {
        bindManagePetModal();
        document.getElementById('profile-add-pet-btn')?.addEventListener('click', () => openAddPetPanel());
    }
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
            if (IS_DASHBOARD_PAGE) renderEmptyState();
            if (IS_PROFILE_PETS_PAGE) renderProfilePetsList([]);
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
                if (IS_PROFILE_PETS_PAGE) {
                    renderProfilePetsList(pets);
                } else if (IS_DASHBOARD_PAGE) {
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
                        window.dispatchEvent(new CustomEvent('petChanged', { detail: { petId: currentPetId } }));
                    }
                }
                const fromServer = !snapshot.metadata?.fromCache;
                if (fromServer && !firstPetsLoadDone) {
                    firstPetsLoadDone = true;
                    window.dispatchEvent(new CustomEvent('petsReady'));
                }
            },
            (err) => {
                console.error('Pet snapshot error:', err);
                if (IS_DASHBOARD_PAGE) renderEmptyState();
                if (IS_PROFILE_PETS_PAGE) renderProfilePetsList([]);
                if (!firstPetsLoadDone) {
                    firstPetsLoadDone = true;
                    window.dispatchEvent(new CustomEvent('petsReady'));
                }
            }
        );
    });
}

function renderProfilePetsList(pets) {
    const listEl = document.getElementById('profile-pets-list');
    const emptyEl = document.getElementById('profile-pets-empty');
    if (!listEl || !emptyEl) return;
    const list = Array.isArray(pets) ? pets : [];
    if (list.length === 0) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('is-hidden');
        return;
    }
    emptyEl.classList.add('is-hidden');
    listEl.innerHTML = list.map((p) => {
        const url = p.imageUrl || '';
        const avInner = url
            ? `<img src="${escapeHtml(url)}" alt="">`
            : `<span aria-hidden="true">${speciesIcon(p.species)}</span>`;
        return `<div class="profile-pet-row" data-pet-id="${escapeHtml(p.id)}">
            <div class="profile-pet-row-avatar">${avInner}</div>
            <div class="profile-pet-row-main">
                <h3 class="profile-pet-row-name">${escapeHtml(p.name ? formatDisplayName(p.name) : 'Unnamed')}</h3>
            </div>
            <div class="profile-pet-row-actions">
                <button type="button" class="btn btn-secondary profile-pet-edit-btn" data-pet-id="${escapeHtml(p.id)}"><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>
                <button type="button" class="btn btn-pet-remove profile-pet-remove-btn" data-pet-id="${escapeHtml(p.id)}"><i class="fa fa-trash-o" aria-hidden="true"></i> Remove</button>
            </div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.profile-pet-edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pet = list.find((x) => x.id === btn.dataset.petId);
            if (pet) openEditPetPanel(pet);
        });
    });
    listEl.querySelectorAll('.profile-pet-remove-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pet = list.find((x) => x.id === btn.dataset.petId);
            if (pet) openManagePetModal(pet);
        });
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
        .map((p) => `<button type="button" class="dropdown-item ${p.id === currentPetId ? 'active' : ''}" role="menuitem" data-pet-id="${p.id}">${speciesIcon(p.species, ' dropdown-item-icon')}<span>${escapeHtml(p.name ? formatDisplayName(p.name) : '')}</span></button>`)
        .join('');
    card.innerHTML = `
        <div class="pet-profile-header">
            <div class="pet-profile-left">
                <div class="pet-avatar-wrap">
                    <img class="pet-avatar-img" src="${escapeHtml(avatarUrl) || '#'}" alt="${escapeHtml(active.name ? formatDisplayName(active.name) : '')}" onerror="this.style.display='none';this.nextElementSibling.classList.add('visible')">
                    <span class="pet-avatar-fallback${fallbackClass}" aria-hidden="true">${speciesIcon(active.species)}</span>
                </div>
                <div class="pet-info">
                    <h2 class="pet-name">${escapeHtml(active.name ? formatDisplayName(active.name) : '')}</h2>
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
    if (img) {
        if (avatarUrl) {
            img.style.opacity = '0';
            img.style.transition = 'opacity 0.35s ease';
            img.onload = () => { requestAnimationFrame(() => { img.style.opacity = '1'; }); };
            img.src = avatarUrl;
            img.style.display = '';
        } else {
            img.style.display = 'none';
        }
    }
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
    clearPendingPetPhoto();
    petPhotoRemoved = false;
    updatePetImageBoxUI(pet.imageUrl || null);
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (titleEl) titleEl.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i> Edit Pet';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Update';
    populateSpeciesSelect(true);
    const speciesSelect = document.getElementById('add-pet-species');
    if (speciesSelect?.options.length > 1) {
        const opt = Array.from(speciesSelect.options).find((o) => o.value === (pet.species || ''));
        if (opt) speciesSelect.value = opt.value;
    }
    const setVal = (sel, val) => { const el = form?.querySelector(sel); if (el) el.value = val != null && val !== '' ? String(val) : ''; };
    setVal('[name="petName"]', pet.name);
    applyStoredBreedToForm(pet.breed, pet.species);
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
            window.dispatchEvent(new CustomEvent('petChanged', { detail: { petId: currentPetId } }));
            setOpen(false);
        });
    });
}

function bindAddPetPanel() {
    const panel = document.getElementById('add-pet-panel');
    const overlay = document.getElementById('add-pet-overlay');
    const form = document.getElementById('add-pet-form');
    const photoInput = document.getElementById('add-pet-photo-input');
    const imageBox = document.getElementById('add-pet-image-box');
    const changePhotoBtn = document.getElementById('add-pet-change-photo');
    const removePhotoBtn = document.getElementById('add-pet-remove-photo');

    const close = () => {
        resetPanelForm();
        setPanelOpen(false);
    };
    overlay?.addEventListener('click', close);
    document.getElementById('add-pet-close')?.addEventListener('click', close);
    document.getElementById('add-pet-cancel')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel?.classList.contains('is-open')) close(); });
    form?.addEventListener('submit', (e) => { e.preventDefault(); handleAddPetSubmit(form); });
    document.getElementById('add-pet-species')?.addEventListener('change', () => {
        syncBreedUiToSpecies();
    });
    form?.addEventListener('change', (e) => {
        if (e.target?.id === 'add-pet-breed-select') onBreedSelectChange();
    });

    const triggerPhotoInput = () => photoInput?.click();
    imageBox?.addEventListener('click', (e) => {
        if (e.target === removePhotoBtn || e.target.closest('#add-pet-remove-photo')) return;
        if (e.target === changePhotoBtn || e.target.closest('#add-pet-change-photo')) return;
        triggerPhotoInput();
    });
    changePhotoBtn?.addEventListener('click', (e) => { e.stopPropagation(); triggerPhotoInput(); });
    removePhotoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearPendingPetPhoto();
        petPhotoRemoved = true;
        updatePetImageBoxUI(null);
    });

    photoInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file || !file.type.startsWith('image/')) return;
        const blob = await openProfilePhotoCrop(file);
        if (blob) {
            if (pendingPetPhoto?.objectUrl) URL.revokeObjectURL(pendingPetPhoto.objectUrl);
            const cropFile = new File([blob], 'pet.png', { type: blob.type });
            pendingPetPhoto = { file: cropFile, objectUrl: URL.createObjectURL(cropFile) };
            petPhotoRemoved = false;
            updatePetImageBoxUI(pendingPetPhoto.objectUrl);
        }
    });
}

function openAddPetPanel() {
    editPetId = null;
    const form = document.getElementById('add-pet-form');
    const titleEl = document.getElementById('add-pet-title');
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (titleEl) titleEl.innerHTML = '<i class="fa fa-paw" aria-hidden="true"></i> Add Pet';
    if (submitBtn) submitBtn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
    clearPendingPetPhoto();
    updatePetImageBoxUI(null);
    setPanelOpen(true);
    populateSpeciesSelect(true);
    syncBreedUiToSpecies();
    setTimeout(() => document.getElementById('add-pet-form')?.querySelector('[name="petName"]')?.focus(), 100);
}
/** @param {boolean} [force] when true, refill options even if already populated (e.g. after reset). */
function populateSpeciesSelect(force = false) {
    const select = document.getElementById('add-pet-species');
    if (!select || (!force && select.options.length > 1)) return;
    select.innerHTML =
        selectPlaceholderOptionHtml('Select species…') +
        SPECIES_OPTIONS.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

async function handleAddPetSubmit(form) {
    const get = (name) => (form.querySelector(`[name="${name}"]`)?.value || '').trim();
    const name = get('petName');
    const species = get('species');
    const breedSelect = form.querySelector('[name="breedSelect"]');
    const breedSelVal = breedSelect && !breedSelect.disabled ? (breedSelect.value || '').trim() : '';
    const breed = resolveBreedFromForm(form);
    const sex = get('sex');
    const age = get('age');
    const weight = get('weight');
    clearFormErrors();
    const nameField = form.querySelector('[name="petName"]')?.closest('.add-pet-field');
    if (!name) { showFieldError(nameField, 'Pet name is required'); return; }
    if (!species) { showFieldError(form.querySelector('[name="species"]')?.closest('.add-pet-field'), 'Please select a species'); return; }
    if (breedSelVal === BREED_OTHER_VALUE && !breed) {
        showFieldError(document.getElementById('add-pet-breed-field'), 'Please enter the breed');
        return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const isEdit = !!editPetId;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa fa-spinner fa-spin"></i> ${isEdit ? 'Updating…' : 'Saving…'}`;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
        await appAlertError(`You must be signed in to ${isEdit ? 'update' : 'add'} a pet.`);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = isEdit ? '<i class="fa fa-check" aria-hidden="true"></i> Update' : '<i class="fa fa-check" aria-hidden="true"></i> Add Pet'; }
        return;
    }
    const basePetData = { name, species, breed: breed || null, sex: sex || null, age: age ? Number(age) : null, weight: weight ? Number(weight) : null };
    try {
        if (isEdit) {
            if (!(await appConfirm("Are you sure you want to update this pet's information?", { confirmText: 'Yes', cancelText: 'No' }))) return;
            const updateData = { ...basePetData };
            if (petPhotoRemoved) {
                const path = `pet-photos/${uid}/${editPetId}`;
                try { await deleteObject(ref(storage, path)); } catch (_) { /* may not exist */ }
                updateData.imageUrl = null;
            } else if (pendingPetPhoto) {
                const path = `pet-photos/${uid}/${editPetId}`;
                const storageRef = ref(storage, path);
                const snap = await uploadBytes(storageRef, pendingPetPhoto.file, { contentType: pendingPetPhoto.file.type });
                updateData.imageUrl = await getDownloadURL(snap.ref);
            }
            await updateDoc(doc(db, 'users', uid, 'pets', editPetId), updateData);
            if (pendingPetPhoto?.objectUrl) URL.revokeObjectURL(pendingPetPhoto.objectUrl);
            pendingPetPhoto = null;
            petPhotoRemoved = false;
            setPanelOpen(false);
            resetPanelForm();
            showToast('update-pet-success-toast');
        } else {
            const docRef = await addDoc(petsRef(uid), { ...basePetData, imageUrl: null, createdAt: serverTimestamp() });
            if (pendingPetPhoto) {
                const path = `pet-photos/${uid}/${docRef.id}`;
                const storageRef = ref(storage, path);
                const snap = await uploadBytes(storageRef, pendingPetPhoto.file, { contentType: pendingPetPhoto.file.type });
                const imageUrl = await getDownloadURL(snap.ref);
                await updateDoc(doc(db, 'users', uid, 'pets', docRef.id), { imageUrl });
                if (pendingPetPhoto.objectUrl) URL.revokeObjectURL(pendingPetPhoto.objectUrl);
                pendingPetPhoto = null;
            }
            setPanelOpen(false);
            form.reset();
            clearFormErrors();
            populateSpeciesSelect(true);
            syncBreedUiToSpecies();
            updatePetImageBoxUI(null);
            showToast('add-pet-success-toast');
        }
    } catch (err) {
        console.error(isEdit ? 'Update pet error:' : 'Add pet error:', err);
        const code = String(err?.code || err?.message || '');
        if (code.includes('permission-denied') || code.includes('PERMISSION_DENIED')) {
            await appAlertError('Permission denied. Please add Firestore rules for users/{userId}/pets in Firebase Console.');
        } else {
            await appAlertError(`Failed to ${isEdit ? 'update' : 'add'} pet: ${err?.message || 'Please try again.'}`);
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = isEdit ? '<i class="fa fa-check" aria-hidden="true"></i> Update' : '<i class="fa fa-check" aria-hidden="true"></i> Add Pet';
        }
    }
}

document.addEventListener('DOMContentLoaded', init);
