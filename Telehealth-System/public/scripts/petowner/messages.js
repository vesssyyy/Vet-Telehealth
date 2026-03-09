/**
 * Televet Health — Pet Owner Messages UI
 * Role-specific logic layered on top of core/messages-shared.js.
 */
import { auth, db } from '../core/firebase-config.js';
import { escapeHtml, formatConversationMeta, timestampToMs } from '../core/utils.js';
import { createMessaging } from '../core/messages-shared.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc,
    query, where, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { loadPets, loadVets } from './appointment-manager.js';

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

/* ── Shared messaging instance ─────────────────────────────────────── */
const shared = createMessaging({
    readField:             'lastReadAt_vetId',
    deliveredField:        'lastDeliveredAt_vetId',
    sentAvatarIcon:        'fa-user',
    receivedAvatarIcon:    'fa-user-md',
    getAppointmentsForConv,
    buildConvItem: conv => `
        <div class="messages-conv-avatar"><i class="fa fa-user-md" aria-hidden="true"></i></div>
        <div class="messages-conv-body">
            <div class="messages-conv-title">
                <span class="conv-pet">${escapeHtml(conv.petName)}</span>
                <span class="conv-plus"> + </span>
                <span class="conv-vet">${escapeHtml(conv.vetName)}</span>
            </div>
            <div class="messages-conv-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</div>
            <div class="messages-conv-meta">${formatConversationMeta(conv.lastMessageAt)}</div>
        </div>`,
});

const { refs, state, setListState, showChat, renderChatMessages,
        renderConversationList, subscribeMessages, goBackToList,
        showModalError, setTriggerText, openModal, closeModal,
        initSharedUI } = shared;

const $ = id => document.getElementById(id);

/* ── Chat header ───────────────────────────────────────────────────── */
function updateChatHeader(conv) {
    const vetNameEl   = $('messages-chat-vet-name');
    const specialtyEl = $('messages-chat-specialty');
    const petBadgeEl  = $('messages-chat-pet-badge');
    if (vetNameEl)   vetNameEl.textContent   = conv.vetName     || '';
    if (specialtyEl) specialtyEl.textContent = conv.vetSpecialty || conv.clinic || 'Veterinarian';
    if (petBadgeEl)  petBadgeEl.textContent  = conv.petName     || '';
}

/* ── New conversation modal ────────────────────────────────────────── */
async function loadModalData() {
    const user   = auth.currentUser;
    if (!user) return;
    const petMenu = $('new-conv-pet-menu');
    const vetMenu = $('new-conv-vet-menu');
    if (!petMenu || !vetMenu) return;
    try {
        const [pets, vets] = await Promise.all([loadPets(user.uid), loadVets()]);
        petMenu.innerHTML = pets.length === 0
            ? '<div class="new-conv-empty">Add a pet in your profile first.</div>'
            : pets.map(p => `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(p.name || 'Unnamed')}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(p.name || 'Unnamed')}</span></button>`).join('');
        vetMenu.innerHTML = vets.length === 0
            ? '<div class="new-conv-empty">No veterinarians available.</div>'
            : vets.map(v => `<button type="button" class="new-conv-item" role="menuitem" data-vet-id="${escapeHtml(v.id)}" data-vet-name="${escapeHtml(v.name)}" data-vet-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-user-md dropdown-item-icon"></i><span>${escapeHtml(v.name)}${v.clinic ? ' \u2013 ' + escapeHtml(v.clinic) : ''}</span></button>`).join('');

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
                    (btn.dataset.vetName || '') + (btn.dataset.vetClinic ? ' \u2013 ' + btn.dataset.vetClinic : '') || 'Select Vet');
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

/* ── Open conversation ─────────────────────────────────────────────── */
async function openConversation(conv) {
    state.currentConvId   = conv.id;
    state.currentConvData = conv;
    if (shared.isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
    updateChatHeader(conv);

    const myId = auth.currentUser?.uid;
    if (myId && conv.ownerId === myId) {
        updateDoc(doc(db, 'conversations', conv.id), { lastReadAt_ownerId: serverTimestamp() })
            .catch(e => console.warn('Update seen on open:', e));
    }

    subscribeMessages(conv, myId,
        () => updateDoc(doc(db, 'conversations', conv.id), { lastReadAt_ownerId: serverTimestamp() })
    );
}

/* ── Subscribe to conversations ────────────────────────────────────── */
function subscribeToConversations() {
    const user = auth.currentUser;
    if (!user) return;
    setListState(true, false, false);
    return onSnapshot(
        query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid), orderBy('lastMessageAt', 'desc')),
        snap => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            state.conversations = [...new Map(docs.map(c => [c.id, c])).values()];
            setListState(false, state.conversations.length === 0, state.conversations.length > 0);
            renderConversationList();

            const myId = user.uid;
            state.conversations.forEach(conv => {
                if (conv.ownerId !== myId) return;
                if (timestampToMs(conv.lastMessageAt) <= timestampToMs(conv.lastDeliveredAt_ownerId)) return;
                if (state.deliveredUpdateTimeouts.has(conv.id)) return;
                const t = setTimeout(() => {
                    state.deliveredUpdateTimeouts.delete(conv.id);
                    updateDoc(doc(db, 'conversations', conv.id), { lastDeliveredAt_ownerId: serverTimestamp() }).catch(() => {});
                }, 800);
                state.deliveredUpdateTimeouts.set(conv.id, t);
            });

            if (state.currentConvId) {
                const conv = state.conversations.find(c => c.id === state.currentConvId);
                if (conv) { updateChatHeader(conv); state.currentConvData = conv; renderChatMessages(state.lastRenderedMessages, conv); }
            }
            tryOpenConversationFromParams();
        },
        err => { console.error('Conversations listener error:', err); setListState(false, true, false); }
    );
}

/* ── Form submit ───────────────────────────────────────────────────── */
async function handleFormSubmit(e) {
    e.preventDefault();
    const petId = $('new-conv-pet')?.value;
    const vetId = $('new-conv-vet')?.value;
    if (!petId || !vetId) { showModalError('Please select both a pet and a veterinarian.'); return; }

    const submitBtn = $('new-conversation-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Starting\u2026'; }

    const user = auth.currentUser;
    if (!user) { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; } return; }

    try {
        const existingSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid)));
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

        const petTrigger = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        const vetTrigger = $('new-conv-vet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        const initMsg    = ($('new-conv-message')?.value || '').trim();
        const ownerSnap  = await getDoc(doc(db, 'users', user.uid));
        const ownerData  = ownerSnap.exists() ? ownerSnap.data() : {};
        const ownerName  = (ownerData.displayName || '').trim()
            || [ownerData.firstName, ownerData.lastName].filter(Boolean).join(' ').trim()
            || (ownerData.email || '').split('@')[0] || 'Pet Owner';

        const convRef = await addDoc(collection(db, 'conversations'), {
            ownerId: user.uid, ownerName, vetId, petId,
            petName: petTrigger || 'Pet', vetName: vetTrigger || 'Vet', vetSpecialty: '',
            participants: [user.uid, vetId],
            lastMessage: initMsg || '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
        });
        if (initMsg) {
            await addDoc(collection(db, 'conversations', convRef.id, 'messages'), {
                senderId: user.uid, text: initMsg, sentAt: serverTimestamp(),
            });
        }
        doCloseModal();
        const newConv = {
            id: convRef.id, ownerId: user.uid, ownerName, vetId, petId,
            petName: petTrigger || 'Pet', vetName: vetTrigger || 'Vet', vetSpecialty: '',
            participants: [user.uid, vetId],
            lastMessage: initMsg || '', lastMessageAt: new Date(), createdAt: new Date(),
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

/* ── Open conversation from URL (e.g. from appointment details Message button) ── */
let hasHandledParams = false;
async function tryOpenConversationFromParams() {
    if (hasHandledParams) return;
    const params = new URLSearchParams(location.search);
    const vetId = params.get('vetId');
    const petId = params.get('petId');
    if (!vetId || !petId || !auth.currentUser) return;
    hasHandledParams = true;
    const user = auth.currentUser;
    const petName = params.get('petName') || 'Pet';
    const vetName = params.get('vetName') || 'Vet';
    let conv = state.conversations.find(c => c.vetId === vetId && c.petId === petId);
    if (conv) {
        openConversation(conv);
        history.replaceState(null, '', location.pathname);
        return;
    }
    try {
        const existingSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid)));
        const existingDoc = existingSnap.docs.find(d => { const data = d.data(); return data.vetId === vetId && data.petId === petId; });
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
        const ownerSnap = await getDoc(doc(db, 'users', user.uid));
        const ownerData = ownerSnap.exists() ? ownerSnap.data() : {};
        const ownerName = (ownerData.displayName || '').trim()
            || [ownerData.firstName, ownerData.lastName].filter(Boolean).join(' ').trim()
            || (ownerData.email || '').split('@')[0] || 'Pet Owner';
        const convRef = await addDoc(collection(db, 'conversations'), {
            ownerId: user.uid, ownerName, vetId, petId,
            petName, vetName, vetSpecialty: '',
            participants: [user.uid, vetId],
            lastMessage: '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
        });
        conv = {
            id: convRef.id, ownerId: user.uid, ownerName, vetId, petId,
            petName, vetName, vetSpecialty: '',
            participants: [user.uid, vetId],
            lastMessage: '', lastMessageAt: new Date(), createdAt: new Date(),
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

/* ── Init ──────────────────────────────────────────────────────────── */
function init() {
    initSharedUI({
        doOpenModal,
        doCloseModal,
        onFormSubmit: handleFormSubmit,
        onConvClick:  openConversation,
        dropdownIds:  ['new-conv-pet', 'new-conv-vet'],
    });

    onAuthStateChanged(auth, user => {
        if (user) subscribeToConversations();
        else setListState(false, true, false);
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
