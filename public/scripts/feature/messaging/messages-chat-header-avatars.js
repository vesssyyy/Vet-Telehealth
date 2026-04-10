// Messages chat header: fade-in avatars, peer/pet fallbacks, cached pet URLs to avoid list flicker.

const petHeaderAvatarCache = new Map();
/** @type {Map<string, Promise<string>>} */
const petHeaderAvatarInflight = new Map();

function petAvatarKey(ownerId, petId) {
    if (!ownerId || !petId) return '';
    return `${String(ownerId)}::${String(petId)}`;
}

function petUrlFromDoc(p) {
    if (!p || typeof p !== 'object') return '';
    const u = p.imageUrl || p.photoURL || p.photoUrl;
    return u ? String(u).trim() : '';
}

// Resolve pet image URL with cache and single in-flight fetch per owner+pet.
function loadPetAvatarUrl(ownerId, petId, fetchPetProfile) {
    const key = petAvatarKey(ownerId, petId);
    if (!key) return Promise.resolve('');
    if (petHeaderAvatarCache.has(key)) {
        return Promise.resolve(petHeaderAvatarCache.get(key));
    }
    let inflight = petHeaderAvatarInflight.get(key);
    if (!inflight) {
        inflight = fetchPetProfile(ownerId, petId)
            .then((p) => {
                const u = petUrlFromDoc(p);
                petHeaderAvatarCache.set(key, u);
                return u;
            })
            .catch(() => {
                petHeaderAvatarCache.set(key, '');
                return '';
            })
            .finally(() => {
                petHeaderAvatarInflight.delete(key);
            });
        petHeaderAvatarInflight.set(key, inflight);
    }
    return inflight;
}

// Invalidate when the owner updates a pet photo in profile (optional hook).
export function invalidatePetHeaderAvatarCache(ownerId, petId) {
    const key = petAvatarKey(ownerId, petId);
    if (key) petHeaderAvatarCache.delete(key);
}

// Set chip image or fallback; opts control pet paw vs empty ring while loading.
export function setHeaderChipAvatar(imgEl, fallbackEl, url, opts = {}) {
    if (!imgEl) return;
    const u = url && String(url).trim();
    const petHasPhoto = opts.petHasPhoto === true;
    const awaitingPetPhoto = opts.awaitingPetPhoto === true;

    const clearHandlers = () => {
        imgEl.onload = null;
        imgEl.onerror = null;
    };

    const bumpGen = () => {
        const n = (parseInt(imgEl.dataset.avatarLoadGen, 10) || 0) + 1;
        imgEl.dataset.avatarLoadGen = String(n);
        return n;
    };

    // Decode bitmap if possible, then two rAFs so the browser paints opacity:0 before --ready (smooth fade).
    const revealAvatar = (gen) => {
        if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
        const applyReady = () => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
                    imgEl.classList.add('messages-chat-avatar-img--ready');
                    fallbackEl?.classList.add('is-hidden');
                });
            });
        };
        if (typeof imgEl.decode === 'function') {
            imgEl.decode().then(applyReady).catch(applyReady);
        } else {
            applyReady();
        }
    };

    if (!u) {
        bumpGen();
        clearHandlers();
        delete imgEl.dataset.chipAvatar;
        imgEl.classList.add('is-hidden');
        imgEl.classList.remove('messages-chat-avatar-img--ready');
        imgEl.removeAttribute('src');
        if (awaitingPetPhoto) {
            fallbackEl?.classList.add('is-hidden');
        } else {
            fallbackEl?.classList.remove('is-hidden');
        }
        return;
    }

    if (imgEl.dataset.chipAvatar === u) {
        if (imgEl.classList.contains('messages-chat-avatar-img--ready')) return;
        if (imgEl.getAttribute('src') === u && imgEl.complete && imgEl.naturalWidth > 0) {
            let g = parseInt(imgEl.dataset.avatarLoadGen, 10);
            if (Number.isNaN(g)) g = bumpGen();
            revealAvatar(g);
            return;
        }
    }

    clearHandlers();
    const prevStored = imgEl.dataset.chipAvatar;
    if (prevStored && prevStored !== u) {
        imgEl.removeAttribute('src');
    }
    imgEl.dataset.chipAvatar = u;
    const gen = bumpGen();

    const onFail = () => {
        if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
        clearHandlers();
        delete imgEl.dataset.chipAvatar;
        imgEl.classList.add('is-hidden');
        imgEl.classList.remove('messages-chat-avatar-img--ready');
        imgEl.removeAttribute('src');
        fallbackEl?.classList.remove('is-hidden');
    };

    imgEl.classList.remove('is-hidden');
    imgEl.classList.remove('messages-chat-avatar-img--ready');
    if (petHasPhoto) {
        fallbackEl?.classList.add('is-hidden');
    } else {
        fallbackEl?.classList.remove('is-hidden');
    }

    imgEl.onload = () => {
        if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
        clearHandlers();
        revealAvatar(gen);
    };
    imgEl.onerror = onFail;

    const prev = imgEl.getAttribute('src') || '';
    if (prev === u && imgEl.complete && imgEl.naturalWidth > 0) {
        if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
        clearHandlers();
        revealAvatar(gen);
        return;
    }

    imgEl.src = u;
    if (imgEl.complete && imgEl.naturalWidth > 0) {
        if (parseInt(imgEl.dataset.avatarLoadGen, 10) !== gen) return;
        clearHandlers();
        revealAvatar(gen);
    }
}

// @param {() => boolean} stillValid e.g. () => state.currentConvId === conv.id
export function setPetHeaderChipAvatar(imgEl, fallbackEl, ownerId, petId, fetchPetProfile, stillValid) {
    if (!imgEl) return;
    const key = petAvatarKey(ownerId, petId);
    if (!key) {
        delete imgEl?.dataset.petHeaderKey;
        setHeaderChipAvatar(imgEl, fallbackEl, '');
        return;
    }

    if (petHeaderAvatarCache.has(key)) {
        delete imgEl?.dataset.petHeaderKey;
        const cached = petHeaderAvatarCache.get(key);
        if (cached) {
            setHeaderChipAvatar(imgEl, fallbackEl, cached, { petHasPhoto: true });
        } else {
            setHeaderChipAvatar(imgEl, fallbackEl, '');
        }
        return;
    }

    // Avoid repeated clear+fallback flicker while the same pet is still loading (e.g. list snapshots).
    if (imgEl?.dataset.petHeaderKey !== key) {
        imgEl.dataset.petHeaderKey = key;
        setHeaderChipAvatar(imgEl, fallbackEl, '', { awaitingPetPhoto: true });
    }

    loadPetAvatarUrl(ownerId, petId, fetchPetProfile).then((u) => {
        if (!stillValid()) {
            if (imgEl?.dataset.petHeaderKey === key) delete imgEl.dataset.petHeaderKey;
            return;
        }
        if (imgEl?.dataset.petHeaderKey === key) delete imgEl.dataset.petHeaderKey;
        if (u) {
            setHeaderChipAvatar(imgEl, fallbackEl, u, { petHasPhoto: true });
        } else {
            setHeaderChipAvatar(imgEl, fallbackEl, '');
        }
    });
}
