/**
 * Televet Health — Veterinarian Messages UI
 * Role-specific logic layered on top of core/messages-shared.js.
 */
import { auth, db } from '../core/firebase-config.js';
import { escapeHtml, formatConversationMeta, withDr, timestampToMs } from '../core/utils.js';
import { createMessaging } from '../core/messages-shared.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc,
    query, where, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/* ── Shared messaging instance ─────────────────────────────────────── */
const shared = createMessaging({
    readField:          'lastReadAt_ownerId',
    deliveredField:     'lastDeliveredAt_ownerId',
    sentAvatarIcon:     'fa-user-md',
    receivedAvatarIcon: 'fa-user',
    buildConvItem: conv => `
        <div class="messages-conv-avatar"><i class="fa fa-user" aria-hidden="true"></i></div>
        <div class="messages-conv-body">
            <div class="messages-conv-title">
                <span class="conv-pet">${escapeHtml(conv.petName)}</span>
                <span class="conv-plus"> + </span>
                <span class="conv-owner">${escapeHtml(conv.ownerName || 'Pet Owner')}</span>
            </div>
            <div class="messages-conv-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</div>
            <div class="messages-conv-meta">${formatConversationMeta(conv.lastMessageAt)}</div>
        </div>`,
});

const { refs, state, setListState, renderChatMessages,
        renderConversationList, subscribeMessages, goBackToList,
        showModalError, setTriggerText, openModal, closeModal,
        initSharedUI } = shared;

const $ = id => document.getElementById(id);

/* ── Display name helpers ──────────────────────────────────────────── */
function ownerDisplayName(data) {
    return (data?.displayName || '').trim()
        || [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim()
        || (data?.email || '').split('@')[0]
        || 'Pet Owner';
}

async function ensureOwnerNames(convs) {
    const toFetch = convs.filter(c => !c.ownerName && c.ownerId);
    await Promise.all(toFetch.map(async conv => {
        try {
            const snap = await getDoc(doc(db, 'users', conv.ownerId));
            if (!snap.exists()) return;
            const name = ownerDisplayName(snap.data());
            conv.ownerName = name;
            updateDoc(doc(db, 'conversations', conv.id), { ownerName: name }).catch(() => {});
        } catch (e) { console.warn('Fetch owner name error:', e); }
    }));
}

/* ── Chat header ───────────────────────────────────────────────────── */
function updateChatHeader(conv) {
    const ownerNameEl = $('messages-chat-owner-name');
    const ownerSubEl  = $('messages-chat-owner-sub');
    const petBadgeEl  = $('messages-chat-pet-badge');
    if (ownerNameEl) ownerNameEl.textContent = conv.ownerName || 'Pet Owner';
    if (ownerSubEl)  ownerSubEl.textContent  = 'Pet Owner';
    if (petBadgeEl)  { petBadgeEl.textContent = conv.petName || ''; petBadgeEl.style.display = conv.petName ? '' : 'none'; }
}

/* ── New conversation modal ────────────────────────────────────────── */
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
                    : pets.map(p => `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(p.name || 'Unnamed')}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(p.name || 'Unnamed')}</span></button>`).join('');
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

/* ── Open conversation ─────────────────────────────────────────────── */
async function openConversation(conv) {
    state.currentConvId   = conv.id;
    state.currentConvData = conv;
    if (shared.isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
    if (!conv.ownerName && conv.ownerId) await ensureOwnerNames([conv]);
    updateChatHeader(conv);

    const myId = auth.currentUser?.uid;
    if (myId && conv.vetId === myId) {
        updateDoc(doc(db, 'conversations', conv.id), { lastReadAt_vetId: serverTimestamp() })
            .catch(e => console.warn('Update seen on open:', e));
    }

    subscribeMessages(conv, myId,
        () => updateDoc(doc(db, 'conversations', conv.id), { lastReadAt_vetId: serverTimestamp() })
    );
}

/* ── Subscribe to conversations ────────────────────────────────────── */
function subscribeToConversations() {
    const user = auth.currentUser;
    if (!user) return;
    setListState(true, false, false);
    return onSnapshot(
        query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid), orderBy('lastMessageAt', 'desc')),
        async snap => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            state.conversations = [...new Map(docs.map(c => [c.id, c])).values()];
            await ensureOwnerNames(state.conversations);
            setListState(false, state.conversations.length === 0, state.conversations.length > 0);
            renderConversationList();

            const myId = user.uid;
            state.conversations.forEach(conv => {
                if (conv.vetId !== myId) return;
                if (timestampToMs(conv.lastMessageAt) <= timestampToMs(conv.lastDeliveredAt_vetId)) return;
                if (state.deliveredUpdateTimeouts.has(conv.id)) return;
                const t = setTimeout(() => {
                    state.deliveredUpdateTimeouts.delete(conv.id);
                    updateDoc(doc(db, 'conversations', conv.id), { lastDeliveredAt_vetId: serverTimestamp() }).catch(() => {});
                }, 800);
                state.deliveredUpdateTimeouts.set(conv.id, t);
            });

            if (state.currentConvId) {
                const conv = state.conversations.find(c => c.id === state.currentConvId);
                if (conv) { updateChatHeader(conv); state.currentConvData = conv; renderChatMessages(state.lastRenderedMessages, conv); }
            }
        },
        err => { console.error('Conversations listener error:', err); setListState(false, true, false); }
    );
}

/* ── Form submit ───────────────────────────────────────────────────── */
async function handleFormSubmit(e) {
    e.preventDefault();
    const ownerId = $('new-conv-owner')?.value;
    const petId   = $('new-conv-pet')?.value;
    if (!ownerId || !petId) { showModalError('Please select both a pet owner and a pet.'); return; }

    const submitBtn = $('new-conversation-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Starting\u2026'; }

    const user = auth.currentUser;
    if (!user) { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; } return; }

    try {
        const existingSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid)));
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

        const petTrigger = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        const initMsg    = ($('new-conv-message')?.value || '').trim();
        const ownerSnap  = await getDoc(doc(db, 'users', ownerId));
        const ownerName  = ownerDisplayName(ownerSnap.exists() ? ownerSnap.data() : {});
        const vetSnap    = await getDoc(doc(db, 'users', user.uid));
        const vetData    = vetSnap.exists() ? vetSnap.data() : {};
        const vetName    = withDr(
            (vetData.displayName || '').trim()
            || [vetData.firstName, vetData.lastName].filter(Boolean).join(' ').trim()
            || (vetData.email || '').split('@')[0]
            || 'Veterinarian'
        );

        const convRef = await addDoc(collection(db, 'conversations'), {
            ownerId, ownerName, vetId: user.uid, petId,
            petName: petTrigger || 'Pet', vetName, vetSpecialty: '',
            participants: [ownerId, user.uid],
            lastMessage: initMsg || '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
        });
        if (initMsg) {
            await addDoc(collection(db, 'conversations', convRef.id, 'messages'), {
                senderId: user.uid, text: initMsg, sentAt: serverTimestamp(),
            });
        }
        doCloseModal();
        const newConv = {
            id: convRef.id, ownerId, ownerName, vetId: user.uid, petId,
            petName: petTrigger || 'Pet', vetName, vetSpecialty: '',
            participants: [ownerId, user.uid],
            lastMessage: initMsg || '', lastMessageAt: new Date(), createdAt: new Date(),
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

/* ── Init ──────────────────────────────────────────────────────────── */
function init() {
    initSharedUI({
        doOpenModal,
        doCloseModal,
        onFormSubmit: handleFormSubmit,
        onConvClick:  openConversation,
        dropdownIds:  ['new-conv-owner', 'new-conv-pet'],
    });

    onAuthStateChanged(auth, user => {
        if (user) subscribeToConversations();
        else setListState(false, true, false);
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
