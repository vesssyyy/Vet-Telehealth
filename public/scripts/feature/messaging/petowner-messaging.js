import { auth, db } from '../../core/firebase/firebase-config.js';
import { escapeHtml, formatConversationMeta, formatDisplayName, timestampToMs, withDr } from '../../core/app/utils.js';
import { createMessaging } from '../../core/messaging/messages-page-core.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc,
    query, where, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { loadPets, loadVets } from '../appointment/petowner/services.js';
import { normalizeId, getCurrentOwnerDisplayName, vetDisplayName } from './shared-messaging.js';
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
    if (!user?.uid || !conv?.vetId || !conv?.petId) return [];
    try {
        const snap = await getDocs(query(collection(db, 'appointments'), where('ownerId', '==', user.uid)));
        return snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(apt => String(apt.vetId) === String(conv.vetId) && String(apt.petId) === String(conv.petId));
    } catch (_) {
        return [];
    }
}

export function initPetownerMessagingPage() {
    const shared = createMessaging({
        readField:             'lastReadAt_vetId',
        deliveredField:        'lastDeliveredAt_vetId',
        incomingDeliveredField: 'lastDeliveredAt_ownerId',
        selfReadField:         'lastReadAt_ownerId',
        selfUnreadCountField:  'unreadCount_owner',
        peerUnreadCountField:  'unreadCount_vet',
        sentAvatarIcon:        'fa-user',
        receivedAvatarIcon:    'fa-user-md',
        allowSkinAnalysisShare: true,
        getAppointmentsForConv,
        buildConvItem: (conv, { unreadCount = 0 } = {}) => {
            const badge = unreadCount > 0
                ? `<span class="messages-conv-unread-badge" aria-label="${unreadCount} unread">${unreadCount > 99 ? '99+' : unreadCount}</span>`
                : '';
            const peerPhoto = conv._peerPhotoURL || '';
            const avatarInner = peerPhoto
                ? `<img src="${escapeHtml(peerPhoto)}" alt="" class="messages-conv-avatar-img">`
                : `<i class="fa fa-user-md" aria-hidden="true"></i>`;
            return `
            <div class="messages-conv-avatar">${avatarInner}</div>
            <div class="messages-conv-body">
                <div class="messages-conv-title">
                    <span class="conv-pet">${escapeHtml(conv.petName ? formatDisplayName(conv.petName) : '')}</span>
                    <span class="conv-plus"> + </span>
                    <span class="conv-vet">${escapeHtml(withDr(conv.vetName || ''))}</span>
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

    function updateChatHeader(conv) {
        const peerNameEl = $('messages-chat-peer-name');
        const petNameEl  = $('messages-chat-pet-name');
        if (peerNameEl) peerNameEl.textContent = withDr(conv.vetName || '');
        if (petNameEl) petNameEl.textContent = conv.petName ? formatDisplayName(conv.petName) : '';

        const peerPhoto = conv._peerPhotoURL || photoCache.get(conv.vetId) || '';
        setHeaderChipAvatar($('messages-chat-peer-img'), $('messages-chat-peer-fallback'), peerPhoto);

        const petImg = $('messages-chat-pet-img');
        const petFb  = $('messages-chat-pet-fallback');
        const uid    = auth.currentUser?.uid;
        const convId = conv.id;
        setPetHeaderChipAvatar(
            petImg,
            petFb,
            uid,
            conv.petId,
            fetchPetProfile,
            () => state.currentConvId === convId
        );
    }

    async function loadModalData() {
        const user = auth.currentUser;
        if (!user) return;
        const petMenu = $('new-conv-pet-menu');
        const vetMenu = $('new-conv-vet-menu');
        if (!petMenu || !vetMenu) return;
        try {
            const [pets, vets] = await Promise.all([loadPets(user.uid), loadVets()]);
            petMenu.innerHTML = pets.length === 0
                ? '<div class="new-conv-empty">Add a pet in your profile first.</div>'
                : pets.map((p) => {
                    const pn = p.name ? formatDisplayName(p.name) : 'Unnamed';
                    return `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(pn)}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(pn)}</span></button>`;
                }).join('');
            vetMenu.innerHTML = vets.length === 0
                ? '<div class="new-conv-empty">No veterinarians available.</div>'
                : vets.map((v) => {
                    const vn = formatDisplayName(v.name || '');
                    return `<button type="button" class="new-conv-item" role="menuitem" data-vet-id="${escapeHtml(v.id)}" data-vet-name="${escapeHtml(vn)}" data-vet-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-user-md dropdown-item-icon"></i><span>${escapeHtml(vn)}${v.clinic ? ' – ' + escapeHtml(v.clinic) : ''}</span></button>`;
                }).join('');

            petMenu.querySelectorAll('.new-conv-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    $('new-conv-pet').value = btn.dataset.petId;
                    setTriggerText('new-conv-pet-trigger', btn.dataset.petName || 'Select Pet');
                    $('new-conv-pet-dropdown')?.classList.remove('is-open');
                });
            });
            vetMenu.querySelectorAll('.new-conv-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    $('new-conv-vet').value = btn.dataset.vetId;
                    setTriggerText('new-conv-vet-trigger',
                        (btn.dataset.vetName || '') + (btn.dataset.vetClinic ? ' – ' + btn.dataset.vetClinic : '') || 'Select Vet');
                    $('new-conv-vet-dropdown')?.classList.remove('is-open');
                });
            });
        } catch (err) {
            console.error('Load pets/vets for messages:', err);
            showModalError('Failed to load pets and vets. Please try again.');
        }
    }

    const doOpenModal  = () => openModal(loadModalData);
    const doCloseModal = () => closeModal(() => {
        [$('new-conv-pet'), $('new-conv-vet'), $('new-conv-message')].forEach(el => el && (el.value = ''));
        setTriggerText('new-conv-pet-trigger', 'Select Pet');
        setTriggerText('new-conv-vet-trigger', 'Select Vet');
    });

    async function openConversation(conv) {
        state.currentConvId   = conv.id;
        state.currentConvData = conv;

        const localConv = state.conversations.find(c => c.id === conv.id);
        if (localConv) localConv.unreadCount_owner = 0;
        renderConversationList();

        if (shared.isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
        updateChatHeader(conv);
        shared.showChat();
        prepareThreadPaneForOpen();

        const myId = auth.currentUser?.uid;
        const [myPhoto, peerPhoto] = await Promise.all([
            fetchPhotoURL(myId),
            fetchPhotoURL(conv.vetId),
        ]);

        if (state.currentConvId !== conv.id) return;

        state.sentAvatarUrl = myPhoto;
        state.receivedAvatarUrl = peerPhoto;

        // Defer mark-read to subscribeMessages so delivery timestamps are not overwritten by an eager read.
        subscribeMessages(conv, myId, () => updateDoc(doc(db, 'conversations', conv.id), {
            lastReadAt_ownerId: serverTimestamp(),
            unreadCount_owner: 0,
        }));
    }

    async function ensureConvPhotos(convs) {
        const vetIds = [...new Set(convs.map(c => c.vetId).filter(Boolean))];
        await Promise.all(vetIds.map(id => fetchPhotoURL(id)));
        convs.forEach(c => { if (c.vetId) c._peerPhotoURL = photoCache.get(c.vetId) || ''; });
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
            query(collection(db, 'conversations'), where('ownerId', '==', user.uid), orderBy('lastMessageAt', 'desc')),
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
                await ensureConvPhotos(state.conversations);
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

    async function handleFormSubmit(e) {
        e.preventDefault();
        const petId = normalizeId($('new-conv-pet')?.value);
        const vetId = normalizeId($('new-conv-vet')?.value);
        if (!petId || !vetId) { showModalError('Please select both a pet and a veterinarian.'); return; }

        const submitBtn = $('new-conversation-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Starting…'; }

        const user = auth.currentUser;
        if (!user) { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; } return; }

        try {
            const existingSnap = await getDocs(query(collection(db, 'conversations'), where('ownerId', '==', user.uid)));
            const existingDoc  = existingSnap.docs.find(d => { const data = d.data(); return data.vetId === vetId && data.petId === petId; });
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
            const vetTrigger = ($('new-conv-vet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent || '').trim();
            const initMsg    = ($('new-conv-message')?.value || '').trim();
            const ownerName  = await getCurrentOwnerDisplayName();
            const petNameNew = petTrigger ? formatDisplayName(petTrigger) : 'Pet';

            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId: user.uid, ownerName, vetId, petId,
                petName: petNameNew, vetName: withDr(vetTrigger || 'Vet'), vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: initMsg || '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
                ...(initMsg ? { lastMessageSenderId: user.uid } : {}),
                unreadCount_owner: 0,
                unreadCount_vet: initMsg ? 1 : 0,
            });
            if (initMsg) {
                await addDoc(collection(db, 'conversations', convRef.id, 'messages'), { senderId: user.uid, text: initMsg, sentAt: serverTimestamp() });
            }

            doCloseModal();
            const newConv = {
                id: convRef.id, ownerId: user.uid, ownerName, vetId, petId,
                petName: petNameNew, vetName: withDr(vetTrigger || 'Vet'), vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: initMsg || '', lastMessageAt: new Date(), createdAt: new Date(),
                unreadCount_owner: 0,
                unreadCount_vet: initMsg ? 1 : 0,
            };
            if (!state.conversations.find(c => c.id === newConv.id)) state.conversations = [newConv, ...state.conversations];
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

    let hasHandledParams = false;
    async function tryOpenConversationFromParams() {
        const params = new URLSearchParams(location.search);
        if (!params.get('vetId') && !params.get('petId') && !params.get('appointmentId')) return;
        if (hasHandledParams) return;
        let vetId = normalizeId(params.get('vetId') || '');
        let petId = normalizeId(params.get('petId') || '');
        const appointmentId = params.get('appointmentId') || '';

        if ((!vetId || !petId) && appointmentId) {
            try {
                const aptSnap = await getDoc(doc(db, 'appointments', appointmentId));
                if (aptSnap.exists()) {
                    const apt = aptSnap.data() || {};
                    vetId = vetId || normalizeId(apt.vetId || apt.vetID || '');
                    petId = petId || normalizeId(apt.petId || apt.petID || '');
                }
            } catch (_) {}
        }
        if (!vetId || !petId || !auth.currentUser) return;
        hasHandledParams = true;

        const user = auth.currentUser;
        const petNameRaw = (params.get('petName') || 'Pet').trim();
        const petName = petNameRaw ? formatDisplayName(petNameRaw) : 'Pet';
        let vetName = (params.get('vetName') || '').trim();
        if (!vetName || vetName === 'Vet') {
            try {
                const vs = await getDoc(doc(db, 'users', vetId));
                if (vs.exists()) vetName = vetDisplayName(vs.data(), withDr);
            } catch (_) { /* vetName stays empty; withDr fallback below */ }
        }
        vetName = withDr(vetName || 'Veterinarian');
        let conv = state.conversations.find(c => String(c.vetId) === String(vetId) && String(c.petId) === String(petId));
        if (conv) {
            openConversation(conv);
            history.replaceState(null, '', location.pathname);
            return;
        }
        try {
            const existingSnap = await getDocs(query(collection(db, 'conversations'), where('ownerId', '==', user.uid)));
            const existingDoc = existingSnap.docs.find(d => {
                const data = d.data();
                return String(data.vetId) === String(vetId) && String(data.petId) === String(petId);
            });
            if (existingDoc) {
                conv = { id: existingDoc.id, ...existingDoc.data() };
                if (!state.conversations.find(c => c.id === conv.id)) {
                    state.conversations = [conv, ...state.conversations];
                    setListState(false, false, true);
                    renderConversationList();
                }
                openConversation(conv);
                history.replaceState(null, '', location.pathname);
                return;
            }
            const ownerName = await getCurrentOwnerDisplayName();
            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId: user.uid, ownerName, vetId, petId,
                petName, vetName, vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
                unreadCount_owner: 0,
                unreadCount_vet: 0,
            });
            conv = {
                id: convRef.id, ownerId: user.uid, ownerName, vetId, petId,
                petName, vetName, vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: '', lastMessageAt: new Date(), createdAt: new Date(),
                unreadCount_owner: 0,
                unreadCount_vet: 0,
            };
            if (!state.conversations.find(c => c.id === conv.id)) {
                state.conversations = [conv, ...state.conversations];
                setListState(false, false, true);
                renderConversationList();
            }
            openConversation(conv);
            history.replaceState(null, '', location.pathname);
        } catch (err) {
            console.error('Open conversation from params:', err);
            hasHandledParams = false;
        }
    }

    initSharedUI({
        doOpenModal,
        doCloseModal,
        onFormSubmit: handleFormSubmit,
        onConvClick:  openConversation,
        dropdownIds:  ['new-conv-pet', 'new-conv-vet'],
    });

    $('messages-chat-peer-profile')?.addEventListener('click', async () => {
        const conv = state.conversations.find(c => c.id === state.currentConvId) || state.currentConvData;
        if (!conv?.vetId) return;
        const data = await fetchUserProfile(conv.vetId);
        profileModal.open(getPeerProfileTitle(data || {}), buildPeerProfileRows(data || {}));
    });
    $('messages-chat-pet-profile')?.addEventListener('click', async () => {
        const conv = state.conversations.find(c => c.id === state.currentConvId) || state.currentConvData;
        const uid = auth.currentUser?.uid;
        if (!conv?.petId || !uid) return;
        const pet = await fetchPetProfile(uid, conv.petId);
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
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPetownerMessagingPage);
    else initPetownerMessagingPage();
}
