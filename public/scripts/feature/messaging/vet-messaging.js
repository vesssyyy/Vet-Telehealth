import { auth, db } from '../../core/firebase/firebase-config.js';
import { escapeHtml, formatConversationMeta, formatDisplayName, withDr, timestampToMs } from '../../core/app/utils.js';
import { createMessaging } from '../../core/messaging/messages-page-core.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc,
    query, where, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { normalizeId, ownerDisplayName, getCurrentVetDisplayName } from './shared-messaging.js';
import {
    wireMessagesProfileModal,
    buildPeerProfileRows,
    buildPetProfileRows,
    getPeerProfileTitle,
    getPetProfileTitle,
} from './messages-profile-modal.js';
import { setHeaderChipAvatar, setPetHeaderChipAvatar } from './messages-chat-header-avatars.js';

const $ = id => document.getElementById(id);

async function fetchUserProfile(uid) {
    if (!uid) return null;
    try {
        const snap = await getDoc(doc(db, 'users', uid));
        return snap.exists() ? snap.data() : null;
    } catch (_) {
        return null;
    }
}

async function fetchPetProfile(ownerId, petId) {
    if (!ownerId || !petId) return null;
    try {
        const snap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } catch (_) {
        return null;
    }
}

const photoCache = new Map();

async function fetchPhotoURL(uid) {
    if (!uid) return '';
    if (photoCache.has(uid)) return photoCache.get(uid);
    try {
        const snap = await getDoc(doc(db, 'users', uid));
        const url = snap.exists() ? (snap.data().photoURL || snap.data().photoUrl || '') : '';
        photoCache.set(uid, url);
        return url;
    } catch (_) {
        photoCache.set(uid, '');
        return '';
    }
}

async function getAppointmentsForConv(conv) {
    const user = auth.currentUser;
    if (!user?.uid || !conv?.ownerId || !conv?.petId) return [];
    try {
        const snap = await getDocs(query(collection(db, 'appointments'), where('vetId', '==', user.uid)));
        return snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(apt => String(apt.ownerId) === String(conv.ownerId) && String(apt.petId) === String(conv.petId));
    } catch (_) {
        return [];
    }
}

export function initVetMessagingPage() {
    const shared = createMessaging({
        readField:             'lastReadAt_ownerId',
        deliveredField:        'lastDeliveredAt_ownerId',
        incomingDeliveredField: 'lastDeliveredAt_vetId',
        selfReadField:         'lastReadAt_vetId',
        selfUnreadCountField:  'unreadCount_vet',
        peerUnreadCountField:  'unreadCount_owner',
        sentAvatarIcon:        'fa-user-md',
        receivedAvatarIcon:    'fa-user',
        allowSkinAnalysisShare: true,
        getAppointmentsForConv,
        buildConvItem: (conv, { unreadCount = 0 } = {}) => {
            const badge = unreadCount > 0
                ? `<span class="messages-conv-unread-badge" aria-label="${unreadCount} unread">${unreadCount > 99 ? '99+' : unreadCount}</span>`
                : '';
            const peerPhoto = conv._peerPhotoURL || '';
            const avatarInner = peerPhoto
                ? `<img src="${escapeHtml(peerPhoto)}" alt="" class="messages-conv-avatar-img">`
                : `<i class="fa fa-user" aria-hidden="true"></i>`;
            return `
            <div class="messages-conv-avatar">${avatarInner}</div>
            <div class="messages-conv-body">
                <div class="messages-conv-title">
                    <span class="conv-owner">${escapeHtml(conv.ownerName ? formatDisplayName(conv.ownerName) : 'Pet Owner')}</span>
                    <span class="conv-and"> & </span>
                    <span class="conv-pet">${escapeHtml(conv.petName ? formatDisplayName(conv.petName) : '')}</span>
                </div>
                <div class="messages-conv-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</div>
                <div class="messages-conv-footer">
                    <span class="messages-conv-meta">${formatConversationMeta(conv.lastMessageAt)}</span>
                    ${badge}
                </div>
            </div>`;
        },
    });

    const {
        state, setListState, renderChatMessages, renderConversationList,
        prepareThreadPaneForOpen, subscribeMessages,
        showModalError, setTriggerText, openModal, closeModal, initSharedUI,
        onConversationListUpdated, clearListDeliveryScheduling,
    } = shared;

    const profileModal = wireMessagesProfileModal();

    async function ensureOwnerNames(convs) {
        const toFetch = convs.filter(c => !c.ownerName && c.ownerId);
        await Promise.all(toFetch.map(async conv => {
            try {
                const snap = await getDoc(doc(db, 'users', conv.ownerId));
                if (!snap.exists()) return;
                const name = ownerDisplayName(snap.data());
                conv.ownerName = name;
                updateDoc(doc(db, 'conversations', conv.id), { ownerName: name }).catch(() => {});
            } catch (_) {}
        }));
    }

    function updateChatHeader(conv) {
        const peerNameEl = $('messages-chat-peer-name');
        const petNameEl  = $('messages-chat-pet-name');
        if (peerNameEl) peerNameEl.textContent = conv.ownerName ? formatDisplayName(conv.ownerName) : 'Pet Owner';
        if (petNameEl) petNameEl.textContent = conv.petName ? formatDisplayName(conv.petName) : '';

        const peerPhoto = conv._peerPhotoURL || photoCache.get(conv.ownerId) || '';
        setHeaderChipAvatar($('messages-chat-peer-img'), $('messages-chat-peer-fallback'), peerPhoto);

        const petImg = $('messages-chat-pet-img');
        const petFb  = $('messages-chat-pet-fallback');
        const convId = conv.id;
        setPetHeaderChipAvatar(
            petImg,
            petFb,
            conv.ownerId,
            conv.petId,
            fetchPetProfile,
            () => state.currentConvId === convId
        );
    }

    async function loadPetOwners() {
        const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'petOwner')));
        return snap.docs
            .filter(d => !d.data().disabled)
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => ownerDisplayName(a).localeCompare(ownerDisplayName(b)));
    }

    async function loadPetsForOwner(ownerId) {
        if (!ownerId) return [];
        const snap = await getDocs(collection(db, 'users', ownerId, 'pets'));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    async function loadModalData() {
        const ownerMenu = $('new-conv-owner-menu');
        const petMenu   = $('new-conv-pet-menu');
        if (!ownerMenu || !petMenu) return;
        try {
            const owners = await loadPetOwners();
            ownerMenu.innerHTML = owners.length === 0
                ? '<div class="new-conv-empty">No pet owners registered.</div>'
                : owners.map(o => {
                    const name = ownerDisplayName(o);
                    return `<button type="button" class="new-conv-item" role="menuitem" data-owner-id="${escapeHtml(o.id)}" data-owner-name="${escapeHtml(name)}"><i class="fa fa-user dropdown-item-icon"></i><span>${escapeHtml(name)}</span></button>`;
                }).join('');
            petMenu.innerHTML = '<div class="new-conv-empty">Select a pet owner first.</div>';

            ownerMenu.querySelectorAll('.new-conv-item').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const ownerId = btn.dataset.ownerId;
                    $('new-conv-owner').value = ownerId;
                    setTriggerText('new-conv-owner-trigger', btn.dataset.ownerName || 'Select Pet Owner');
                    $('new-conv-owner-dropdown')?.classList.remove('is-open');
                    $('new-conv-pet').value = '';
                    setTriggerText('new-conv-pet-trigger', 'Select Pet');

                    const pets = await loadPetsForOwner(ownerId);
                    petMenu.innerHTML = pets.length === 0
                        ? '<div class="new-conv-empty">No pets for this owner.</div>'
                        : pets.map((p) => {
                            const pn = p.name ? formatDisplayName(p.name) : 'Unnamed';
                            return `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(pn)}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(pn)}</span></button>`;
                        }).join('');
                    petMenu.querySelectorAll('.new-conv-item').forEach(pBtn => {
                        pBtn.addEventListener('click', () => {
                            $('new-conv-pet').value = pBtn.dataset.petId;
                            setTriggerText('new-conv-pet-trigger', pBtn.dataset.petName || 'Select Pet');
                            $('new-conv-pet-dropdown')?.classList.remove('is-open');
                        });
                    });
                });
            });
        } catch (err) {
            console.error('Load pet owners for messages:', err);
            showModalError('Failed to load pet owners. Please try again.');
        }
    }

    const doOpenModal  = () => openModal(loadModalData);
    const doCloseModal = () => closeModal(() => {
        [$('new-conv-owner'), $('new-conv-pet'), $('new-conv-message')].forEach(el => el && (el.value = ''));
        setTriggerText('new-conv-owner-trigger', 'Select Pet Owner');
        setTriggerText('new-conv-pet-trigger', 'Select Pet');
    });

    async function openConversation(conv) {
        state.currentConvId = conv.id;
        state.currentConvData = conv;

        const localConv = state.conversations.find(c => c.id === conv.id);
        if (localConv) localConv.unreadCount_vet = 0;
        renderConversationList();

        if (shared.isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
        if (!conv.ownerName && conv.ownerId) await ensureOwnerNames([conv]);
        updateChatHeader(conv);
        shared.showChat();
        prepareThreadPaneForOpen();

        const myId = auth.currentUser?.uid;
        const [myPhoto, peerPhoto] = await Promise.all([
            fetchPhotoURL(myId),
            fetchPhotoURL(conv.ownerId),
        ]);

        if (state.currentConvId !== conv.id) return;

        state.sentAvatarUrl = myPhoto;
        state.receivedAvatarUrl = peerPhoto;

        // Defer mark-read to subscribeMessages so delivery timestamps are not overwritten by an eager read.
        subscribeMessages(conv, myId, () => updateDoc(doc(db, 'conversations', conv.id), {
            lastReadAt_vetId: serverTimestamp(),
            unreadCount_vet: 0,
        }));
    }

    async function ensureConvPhotos(convs) {
        const ownerIds = [...new Set(convs.map(c => c.ownerId).filter(Boolean))];
        await Promise.all(ownerIds.map(id => fetchPhotoURL(id)));
        convs.forEach(c => { if (c.ownerId) c._peerPhotoURL = photoCache.get(c.ownerId) || ''; });
    }

    let conversationListUnsub = null;

    function subscribeToConversations() {
        const user = auth.currentUser;
        if (!user) return;
        if (conversationListUnsub) {
            conversationListUnsub();
            conversationListUnsub = null;
        }
        conversationListUnsub = onSnapshot(
            query(collection(db, 'conversations'), where('vetId', '==', user.uid), orderBy('lastMessageAt', 'desc')),
            async snap => {
                const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                const byId = new Map(docs.map(c => [c.id, c]));
                if (state.currentConvId && !byId.has(state.currentConvId)) {
                    const keep = state.conversations.find(c => c.id === state.currentConvId)
                        || (state.currentConvData?.id === state.currentConvId ? state.currentConvData : null);
                    if (keep) byId.set(state.currentConvId, { id: state.currentConvId, ...keep });
                }
                state.conversations = [...byId.values()].sort(
                    (a, b) => timestampToMs(b.lastMessageAt) - timestampToMs(a.lastMessageAt)
                );
                await Promise.all([ensureOwnerNames(state.conversations), ensureConvPhotos(state.conversations)]);
                setListState(false, state.conversations.length === 0, state.conversations.length > 0);
                renderConversationList();
                onConversationListUpdated(state.conversations);

                if (state.currentConvId) {
                    const conv = state.conversations.find(c => c.id === state.currentConvId);
                    if (conv) { updateChatHeader(conv); state.currentConvData = conv; renderChatMessages(state.lastRenderedMessages, conv); }
                }
                tryOpenConversationFromParams();
            },
            () => {
                setListState(false, true, false);
                tryOpenConversationFromParams();
            }
        );
        return conversationListUnsub;
    }

    let hasHandledParams = false;
    async function tryOpenConversationFromParams() {
        const params = new URLSearchParams(location.search);
        if (!params.get('ownerId') && !params.get('petId') && !params.get('appointmentId')) return;
        if (hasHandledParams) return;
        let ownerId = normalizeId(params.get('ownerId') || '');
        let petId = normalizeId(params.get('petId') || '');
        const appointmentId = params.get('appointmentId') || '';
        if ((!ownerId || !petId) && appointmentId) {
            try {
                const aptSnap = await getDoc(doc(db, 'appointments', appointmentId));
                if (aptSnap.exists()) {
                    const apt = aptSnap.data() || {};
                    ownerId = ownerId || normalizeId(apt.ownerId || apt.ownerID || '');
                    petId = petId || normalizeId(apt.petId || apt.petID || '');
                }
            } catch (_) {}
        }
        if (!ownerId || !petId || !auth.currentUser) return;
        hasHandledParams = true;

        const user = auth.currentUser;
        let conv = state.conversations.find(c => String(c.ownerId) === String(ownerId) && String(c.petId) === String(petId));
        if (conv) {
            if (!conv.ownerName && conv.ownerId) await ensureOwnerNames([conv]);
            openConversation(conv);
            history.replaceState(null, '', location.pathname);
            return;
        }
        try {
            const existingSnap = await getDocs(query(collection(db, 'conversations'), where('vetId', '==', user.uid)));
            const existingDoc = existingSnap.docs.find(d => {
                const data = d.data();
                return String(data.ownerId) === String(ownerId) && String(data.petId) === String(petId);
            });
            if (existingDoc) {
                conv = { id: existingDoc.id, ...existingDoc.data() };
                if (!state.conversations.find(c => c.id === conv.id)) {
                    state.conversations = [conv, ...state.conversations];
                    setListState(false, false, true);
                    renderConversationList();
                }
                if (!conv.ownerName && conv.ownerId) await ensureOwnerNames([conv]);
                openConversation(conv);
                history.replaceState(null, '', location.pathname);
                return;
            }
            let ownerName = params.get('ownerName') || 'Pet Owner';
            try {
                const ownerSnap = await getDoc(doc(db, 'users', ownerId));
                ownerName = ownerDisplayName(ownerSnap.exists() ? ownerSnap.data() : {});
            } catch (_) {}
            const vetName = await getCurrentVetDisplayName(withDr);
            let petName = params.get('petName') || 'Pet';
            try {
                const petSnap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
                if (petSnap.exists() && petSnap.data()?.name) petName = formatDisplayName(String(petSnap.data().name).trim());
            } catch (_) {}
            petName = petName ? formatDisplayName(String(petName).trim()) : 'Pet';
            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId, ownerName, vetId: user.uid, petId,
                petName, vetName, vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
                unreadCount_owner: 0,
                unreadCount_vet: 0,
            });
            conv = {
                id: convRef.id, ownerId, ownerName, vetId: user.uid, petId,
                petName, vetName, vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: '', lastMessageAt: new Date(), createdAt: new Date(),
                unreadCount_owner: 0,
                unreadCount_vet: 0,
            };
            state.conversations = [conv, ...state.conversations];
            setListState(false, false, true);
            renderConversationList();
            openConversation(conv);
            history.replaceState(null, '', location.pathname);
        } catch (err) {
            console.error('Open conversation from params:', err);
            hasHandledParams = false;
        }
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        const ownerId = normalizeId($('new-conv-owner')?.value);
        const petId   = normalizeId($('new-conv-pet')?.value);
        if (!ownerId || !petId) { showModalError('Please select both a pet owner and a pet.'); return; }

        const submitBtn = $('new-conversation-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Starting…'; }
        const user = auth.currentUser;
        if (!user) { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; } return; }

        try {
            const existingSnap = await getDocs(query(collection(db, 'conversations'), where('vetId', '==', user.uid)));
            const existingDoc  = existingSnap.docs.find(d => { const data = d.data(); return data.ownerId === ownerId && data.petId === petId; });
            if (existingDoc) {
                doCloseModal();
                const existing = { id: existingDoc.id, ...existingDoc.data() };
                if (!state.conversations.find(c => c.id === existing.id)) {
                    state.conversations = [existing, ...state.conversations];
                    setListState(false, false, true);
                    renderConversationList();
                }
                openConversation(existing);
                return;
            }

            const petTrigger = ($('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent || '').trim();
            const initMsg    = ($('new-conv-message')?.value || '').trim();
            const ownerSnap  = await getDoc(doc(db, 'users', ownerId));
            const ownerName  = ownerDisplayName(ownerSnap.exists() ? ownerSnap.data() : {});
            const vetName    = await getCurrentVetDisplayName(withDr);
            const petNameNew = petTrigger ? formatDisplayName(petTrigger) : 'Pet';

            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId, ownerName, vetId: user.uid, petId,
                petName: petNameNew, vetName, vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: initMsg || '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
                ...(initMsg ? { lastMessageSenderId: user.uid } : {}),
                unreadCount_owner: initMsg ? 1 : 0,
                unreadCount_vet: 0,
            });
            if (initMsg) {
                await addDoc(collection(db, 'conversations', convRef.id, 'messages'), {
                    senderId: user.uid, text: initMsg, sentAt: serverTimestamp(),
                });
            }
            doCloseModal();
            const newConv = {
                id: convRef.id, ownerId, ownerName, vetId: user.uid, petId,
                petName: petNameNew, vetName, vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: initMsg || '', lastMessageAt: new Date(), createdAt: new Date(),
                unreadCount_owner: initMsg ? 1 : 0,
                unreadCount_vet: 0,
            };
            state.conversations = [newConv, ...state.conversations];
            setListState(false, false, true);
            renderConversationList();
            openConversation(newConv);
        } catch (err) {
            console.error('Create conversation error:', err);
            showModalError(err?.message || 'Failed to start conversation. Please try again.');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; }
        }
    }

    initSharedUI({
        doOpenModal,
        doCloseModal,
        onFormSubmit: handleFormSubmit,
        onConvClick:  openConversation,
        dropdownIds:  ['new-conv-owner', 'new-conv-pet'],
    });

    $('messages-chat-peer-profile')?.addEventListener('click', async () => {
        const conv = state.conversations.find(c => c.id === state.currentConvId) || state.currentConvData;
        if (!conv?.ownerId) return;
        const data = await fetchUserProfile(conv.ownerId);
        profileModal.open(getPeerProfileTitle(data || {}), buildPeerProfileRows(data || {}));
    });
    $('messages-chat-pet-profile')?.addEventListener('click', async () => {
        const conv = state.conversations.find(c => c.id === state.currentConvId) || state.currentConvData;
        if (!conv?.ownerId || !conv?.petId) return;
        const pet = await fetchPetProfile(conv.ownerId, conv.petId);
        profileModal.open(getPetProfileTitle(pet, conv.petName), buildPetProfileRows(pet || {}));
    });

    window.__telehealthMessagesTeardown = () => {
        profileModal.close();
        if (conversationListUnsub) {
            conversationListUnsub();
            conversationListUnsub = null;
        }
        clearListDeliveryScheduling();
        shared.goBackToList();
    };

    onAuthStateChanged(auth, user => {
        if (user) {
            subscribeToConversations();
            tryOpenConversationFromParams();
            setTimeout(() => { tryOpenConversationFromParams(); }, 1500);
        }
    });
}

// Auto-init when loaded as a page script module
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initVetMessagingPage);
    else initVetMessagingPage();
}
