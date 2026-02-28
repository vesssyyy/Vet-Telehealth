/**
 * Televet Health — Veterinarian Messages UI
 * Firestore integration: vet sees conversations with pet owners.
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    addDoc,
    updateDoc,
    query,
    where,
    orderBy,
    onSnapshot,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

const overlay = $('new-conversation-overlay');
const modal = $('new-conversation-modal');
const closeBtn = $('new-conversation-close');
const cancelBtn = $('new-conversation-cancel');
const form = $('new-conversation-form');
const listLoading = $('messages-list-loading');
const listEmpty = $('messages-list-empty');
const listRoot = $('messages-conversation-list');
const emptySinglePanel = $('messages-empty-single-panel');
const messagesWrapper = $('messages-wrapper');
const chatWelcome = $('messages-chat-welcome');
const chatActive = $('messages-chat-active');
const chatBack = $('messages-chat-back');
const composeInput = $('messages-compose-input');
const sendBtn = $('messages-send-btn');
const messagesWrapperEl = $('messages-wrapper');

let conversations = [];
let currentConvId = null;
let messagesUnsubscribe = null;
let isSendingMessage = false;

function isMobileView() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function openModal() {
    if (!overlay || !modal) return;
    $('new-conversation-error')?.classList.add('is-hidden');
    overlay.classList.add('is-open');
    modal.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modal.focus();
    loadModalData();
}

function closeModal() {
    if (overlay) overlay.classList.remove('is-open');
    if (modal) modal.classList.remove('is-open');
    if (overlay) overlay.setAttribute('aria-hidden', 'true');
    if (modal) modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    const ownerInput = $('new-conv-owner');
    const petInput = $('new-conv-pet');
    const messageInput = $('new-conv-message');
    if (ownerInput) ownerInput.value = '';
    if (petInput) petInput.value = '';
    if (messageInput) messageInput.value = '';
    const ownerTriggerText = $('new-conv-owner-trigger')?.querySelector('.new-conv-trigger-text');
    const petTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text');
    if (ownerTriggerText) ownerTriggerText.textContent = 'Select Pet Owner';
    if (petTriggerText) petTriggerText.textContent = 'Select Pet';
}

function ownerDisplayName(data) {
    return (data?.displayName || '').trim()
        || [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim()
        || (data?.email || '').split('@')[0]
        || 'Pet Owner';
}

async function ensureOwnerNames(convs) {
    const toFetch = convs.filter((c) => !c.ownerName && c.ownerId);
    await Promise.all(toFetch.map(async (conv) => {
        try {
            const snap = await getDoc(doc(db, 'users', conv.ownerId));
            if (snap.exists()) {
                const name = ownerDisplayName(snap.data());
                conv.ownerName = name;
                try {
                    await updateDoc(doc(db, 'conversations', conv.id), { ownerName: name });
                } catch (_) { /* ignore update errors */ }
            }
        } catch (e) {
            console.warn('Fetch owner name error:', e);
        }
    }));
}

async function loadPetOwners() {
    const snap = await getDocs(query(
        collection(db, 'users'),
        where('role', '==', 'petOwner')
    ));
    return snap.docs
        .filter((d) => !d.data().disabled)
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (ownerDisplayName(a) || '').localeCompare(ownerDisplayName(b) || ''));
}

async function loadPetsForOwner(ownerId) {
    if (!ownerId) return [];
    const snap = await getDocs(collection(db, 'users', ownerId, 'pets'));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadModalData() {
    const ownerMenu = $('new-conv-owner-menu');
    const petMenu = $('new-conv-pet-menu');
    if (!ownerMenu || !petMenu) return;

    try {
        const owners = await loadPetOwners();

        ownerMenu.innerHTML = owners.length === 0
            ? '<div class="new-conv-empty">No pet owners registered.</div>'
            : owners.map((o) => {
                const name = ownerDisplayName(o);
                return `<button type="button" class="new-conv-item" role="menuitem" data-owner-id="${escapeHtml(o.id)}" data-owner-name="${escapeHtml(name)}"><i class="fa fa-user dropdown-item-icon"></i><span>${escapeHtml(name)}</span></button>`;
            }).join('');

        petMenu.innerHTML = '<div class="new-conv-empty">Select a pet owner first.</div>';

        ownerMenu.querySelectorAll('.new-conv-item').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const ownerInput = $('new-conv-owner');
                const ownerTriggerText = $('new-conv-owner-trigger')?.querySelector('.new-conv-trigger-text');
                const ownerDropdownEl = $('new-conv-owner-dropdown');
                const ownerId = btn.dataset.ownerId;
                if (ownerInput) ownerInput.value = ownerId;
                if (ownerTriggerText) ownerTriggerText.textContent = btn.dataset.ownerName || 'Select Pet Owner';
                if (ownerDropdownEl) ownerDropdownEl.classList.remove('is-open');

                const petInput = $('new-conv-pet');
                const petTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text');
                if (petInput) petInput.value = '';
                if (petTriggerText) petTriggerText.textContent = 'Select Pet';

                const pets = await loadPetsForOwner(ownerId);
                petMenu.innerHTML = pets.length === 0
                    ? '<div class="new-conv-empty">No pets for this owner.</div>'
                    : pets.map((p) => `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(p.name || 'Unnamed')}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(p.name || 'Unnamed')}</span></button>`).join('');

                petMenu.querySelectorAll('.new-conv-item').forEach((pBtn) => {
                    pBtn.addEventListener('click', () => {
                        const pInput = $('new-conv-pet');
                        const pTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text');
                        const pDropdownEl = $('new-conv-pet-dropdown');
                        if (pInput) pInput.value = pBtn.dataset.petId;
                        if (pTriggerText) pTriggerText.textContent = pBtn.dataset.petName || 'Select Pet';
                        if (pDropdownEl) pDropdownEl.classList.remove('is-open');
                    });
                });
            });
        });
    } catch (err) {
        console.error('Load pet owners for messages:', err);
        const errEl = $('new-conversation-error');
        if (errEl) {
            errEl.textContent = 'Failed to load pet owners. Please try again.';
            errEl.classList.remove('is-hidden');
        }
    }
}

function showPlaceholder() {
    if (chatWelcome) chatWelcome.classList.remove('is-hidden');
    if (chatActive) chatActive.classList.add('is-hidden');
    if (messagesWrapperEl && isMobileView()) {
        messagesWrapperEl.classList.remove('messages-wrapper--conversation-open');
    }
}

function showChat() {
    if (chatWelcome) chatWelcome.classList.add('is-hidden');
    if (chatActive) chatActive.classList.remove('is-hidden');
    if (messagesWrapperEl && isMobileView()) {
        messagesWrapperEl.classList.add('messages-wrapper--conversation-open');
    }
}

function setListState(loading, empty, hasItems) {
    if (listLoading) listLoading.classList.toggle('is-hidden', !loading);
    if (listEmpty) listEmpty.classList.toggle('is-hidden', !empty);
    if (listRoot) listRoot.style.display = hasItems ? '' : 'none';
    if (emptySinglePanel) emptySinglePanel.classList.toggle('is-hidden', !empty);
    if (messagesWrapper) messagesWrapper.classList.toggle('is-hidden', empty);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatMessageTime(timestamp) {
    if (!timestamp?.toDate) return '';
    return timestamp.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatConversationMeta(timestamp) {
    if (!timestamp?.toDate) return '';
    const d = timestamp.toDate();
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 86400000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderConversationList() {
    if (!listRoot) return;
    listRoot.innerHTML = '';
    const uniqueConvs = [...new Map(conversations.map((c) => [c.id, c])).values()];
    uniqueConvs.forEach((conv) => {
        const ownerName = conv.ownerName || 'Pet Owner';
        const item = document.createElement('li');
        item.className = 'messages-conversation-item' + (conv.id === currentConvId ? ' is-active' : '');
        item.setAttribute('role', 'listitem');
        item.dataset.convId = conv.id;
        item.innerHTML = `
            <div class="messages-conv-avatar"><i class="fa fa-user" aria-hidden="true"></i></div>
            <div class="messages-conv-body">
                <div class="messages-conv-title"><span class="conv-pet">${escapeHtml(conv.petName)}</span><span class="conv-plus"> + </span><span class="conv-owner">${escapeHtml(ownerName)}</span></div>
                <div class="messages-conv-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</div>
                <div class="messages-conv-meta">${formatConversationMeta(conv.lastMessageAt)}</div>
            </div>
        `;
        listRoot.appendChild(item);
    });
    listRoot.style.display = uniqueConvs.length ? '' : 'none';
}

function renderChatMessages(messages) {
    const body = $('messages-chat-body');
    if (!body) return;
    body.innerHTML = '';
    const uid = auth.currentUser?.uid;
    messages.forEach((msg) => {
        const isSent = msg.senderId === uid;
        const row = document.createElement('div');
        row.className = `message-row message-row--${isSent ? 'sent' : 'received'}`;
        const avatarIcon = isSent ? 'fa-user-md' : 'fa-user';
        const timeStr = formatMessageTime(msg.sentAt);
        row.innerHTML = `
            <div class="message-row-avatar"><i class="fa ${avatarIcon}" aria-hidden="true"></i></div>
            <div class="message-bubble message-bubble--${isSent ? 'sent' : 'received'}">
                <div>${escapeHtml(msg.text || '')}</div>
                <div class="message-bubble-time">${timeStr}</div>
            </div>
        `;
        body.appendChild(row);
    });
    body.scrollTop = body.scrollHeight;
}

async function openConversation(conv) {
    currentConvId = conv.id;
    if (isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
    if (!conv.ownerName && conv.ownerId) {
        await ensureOwnerNames([conv]);
    }
    const ownerNameEl = $('messages-chat-owner-name');
    const ownerSubEl = $('messages-chat-owner-sub');
    const petBadgeEl = $('messages-chat-pet-badge');
    if (ownerNameEl) ownerNameEl.textContent = conv.ownerName || 'Pet Owner';
    if (ownerSubEl) ownerSubEl.textContent = 'Pet Owner';
    if (petBadgeEl) {
        petBadgeEl.textContent = conv.petName || '';
        petBadgeEl.style.display = conv.petName ? '' : 'none';
    }

    if (messagesUnsubscribe) messagesUnsubscribe();
    const messagesRef = collection(db, 'conversations', conv.id, 'messages');
    messagesUnsubscribe = onSnapshot(
        query(messagesRef, orderBy('sentAt', 'asc')),
        (snap) => {
            const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            renderChatMessages(messages);
        },
        (err) => console.error('Messages listener error:', err)
    );

    renderConversationList();
    showChat();
}

function subscribeToConversations() {
    const user = auth.currentUser;
    if (!user) return;

    setListState(true, false, false);
    const q = query(
        collection(db, 'conversations'),
        where('participants', 'array-contains', user.uid),
        orderBy('lastMessageAt', 'desc')
    );

    return onSnapshot(q, async (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        conversations = [...new Map(docs.map((c) => [c.id, c])).values()];
        await ensureOwnerNames(conversations);
        setListState(false, conversations.length === 0, conversations.length > 0);
        renderConversationList();
        if (currentConvId) {
            const conv = conversations.find((c) => c.id === currentConvId);
            if (conv) {
                const ownerNameEl = $('messages-chat-owner-name');
                const ownerSubEl = $('messages-chat-owner-sub');
                const petBadgeEl = $('messages-chat-pet-badge');
                if (ownerNameEl) ownerNameEl.textContent = conv.ownerName || 'Pet Owner';
                if (ownerSubEl) ownerSubEl.textContent = 'Pet Owner';
                if (petBadgeEl) {
                    petBadgeEl.textContent = conv.petName || '';
                    petBadgeEl.style.display = conv.petName ? '' : 'none';
                }
            }
        }
    }, (err) => {
        console.error('Conversations listener error:', err);
        setListState(false, true, false);
    });
}

function init() {
    setListState(false, true, false);
    showPlaceholder();

    [closeBtn, cancelBtn, overlay].forEach((el) => {
        el?.addEventListener('click', (e) => {
            if (el === overlay && e.target !== overlay) return;
            closeModal();
        });
    });

    $('messages-list-new-icon')?.addEventListener('click', openModal);
    $('messages-empty-new-icon')?.addEventListener('click', openModal);

    function goBackToList() {
        composeInput?.blur();
        document.body.classList.remove('messages-input-focused');
        currentConvId = null;
        if (messagesUnsubscribe) {
            messagesUnsubscribe();
            messagesUnsubscribe = null;
        }
        showPlaceholder();
        renderConversationList();
    }
    chatBack?.addEventListener('click', () => {
        if (isMobileView() && currentConvId) history.back();
        else goBackToList();
    });

    window.addEventListener('popstate', () => {
        if (isMobileView() && currentConvId) goBackToList();
    });

    const searchInput = $('messages-search-input');
    searchInput?.addEventListener('input', () => {
        const q = (searchInput.value || '').trim().toLowerCase();
        listRoot?.querySelectorAll('.messages-conversation-item').forEach((item) => {
            const title = item.querySelector('.messages-conv-title')?.textContent || '';
            const preview = item.querySelector('.messages-conv-preview')?.textContent || '';
            const text = (title + ' ' + preview).toLowerCase();
            item.style.display = !q || text.includes(q) ? '' : 'none';
        });
    });

    listRoot?.addEventListener('click', (e) => {
        const item = e.target.closest('.messages-conversation-item');
        if (item) {
            e.preventDefault();
            const convId = item.dataset.convId;
            const conv = conversations.find((c) => c.id === convId);
            if (conv) {
                listRoot.querySelectorAll('.messages-conversation-item').forEach((i) => i.classList.remove('is-active'));
                item.classList.add('is-active');
                openConversation(conv);
            }
        }
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ownerId = $('new-conv-owner')?.value;
        const petId = $('new-conv-pet')?.value;
        const ownerTriggerText = $('new-conv-owner-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        const petTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;

        if (!ownerId || !petId) {
            const errEl = $('new-conversation-error');
            if (errEl) {
                errEl.textContent = 'Please select both a pet owner and a pet.';
                errEl.classList.remove('is-hidden');
            }
            return;
        }

        const submitBtn = $('new-conversation-submit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Starting…';
        }

        const user = auth.currentUser;
        if (!user) {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start Chat'; }
            return;
        }

        try {
            const existingQ = query(
                collection(db, 'conversations'),
                where('participants', 'array-contains', user.uid)
            );
            const existingSnap = await getDocs(existingQ);
            const existingDoc = existingSnap.docs.find((d) => {
                const data = d.data();
                return data.ownerId === ownerId && data.petId === petId;
            });
            if (existingDoc) {
                closeModal();
                const existingConv = { id: existingDoc.id, ...existingDoc.data() };
                if (!conversations.find((c) => c.id === existingConv.id)) {
                    conversations = [existingConv, ...conversations];
                    setListState(false, false, true);
                    renderConversationList();
                }
                openConversation(existingConv);
                return;
            }

            const ownerDoc = await getDoc(doc(db, 'users', ownerId));
            const ownerData = ownerDoc.exists() ? ownerDoc.data() : {};
            const ownerName = ownerDisplayName(ownerData);
            const vetDoc = await getDoc(doc(db, 'users', user.uid));
            const vetData = vetDoc.exists() ? vetDoc.data() : {};
            const vetName = (vetData.displayName || '').trim()
                || [vetData.firstName, vetData.lastName].filter(Boolean).join(' ').trim()
                || (vetData.email || '').split('@')[0]
                || 'Veterinarian';
            const vetNameFormatted = /^dr\.?\s/i.test(vetName) ? vetName : `Dr. ${vetName}`;
            const initialMessage = ($('new-conv-message')?.value || '').trim();

            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId,
                ownerName,
                vetId: user.uid,
                petId,
                petName: petTriggerText || 'Pet',
                vetName: vetNameFormatted,
                vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: initialMessage || '',
                lastMessageAt: serverTimestamp(),
                createdAt: serverTimestamp(),
            });
            if (initialMessage) {
                await addDoc(collection(db, 'conversations', convRef.id, 'messages'), {
                    senderId: user.uid,
                    text: initialMessage,
                    sentAt: serverTimestamp(),
                });
            }
            closeModal();
            const newConv = {
                id: convRef.id,
                ownerId,
                ownerName,
                vetId: user.uid,
                petId,
                petName: petTriggerText || 'Pet',
                vetName: vetNameFormatted,
                vetSpecialty: '',
                participants: [ownerId, user.uid],
                lastMessage: initialMessage || '',
                lastMessageAt: new Date(),
                createdAt: new Date(),
            };
            conversations = [newConv, ...conversations];
            setListState(false, false, true);
            renderConversationList();
            openConversation(newConv);
        } catch (err) {
            console.error('Create conversation error:', err);
            const errEl = $('new-conversation-error');
            if (errEl) {
                errEl.textContent = err?.message || 'Failed to start conversation. Please try again.';
                errEl.classList.remove('is-hidden');
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Start Chat';
            }
        }
    });

    const MAX_LINES = 5;
    function resizeComposeInput() {
        if (!composeInput) return;
        composeInput.style.height = 'auto';
        const style = getComputedStyle(composeInput);
        const lineHeight = parseFloat(style.lineHeight) || composeInput.scrollHeight;
        const maxHeight = lineHeight * MAX_LINES;
        const h = Math.min(Math.max(composeInput.scrollHeight, lineHeight), maxHeight);
        composeInput.style.height = h + 'px';
    }
    composeInput?.addEventListener('input', resizeComposeInput);
    composeInput?.addEventListener('paste', () => setTimeout(resizeComposeInput, 0));

    /* On mobile, when the message input is focused, use full visible height so input sits just above keyboard (no gap). */
    composeInput?.addEventListener('focus', () => {
        if (!isMobileView()) return;
        document.body.classList.add('messages-input-focused');
    });
    composeInput?.addEventListener('blur', () => {
        document.body.classList.remove('messages-input-focused');
    });

    async function doSendMessage() {
        if (isSendingMessage) return;
        const text = (composeInput?.value || '').trim();
        if (!text || !currentConvId) return;
        const user = auth.currentUser;
        if (!user) return;

        isSendingMessage = true;
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.setAttribute('aria-busy', 'true');
        }
        try {
            await addDoc(collection(db, 'conversations', currentConvId, 'messages'), {
                senderId: user.uid,
                text,
                sentAt: serverTimestamp(),
            });
            await updateDoc(doc(db, 'conversations', currentConvId), {
                lastMessage: text,
                lastMessageAt: serverTimestamp(),
            });
            const conv = conversations.find((c) => c.id === currentConvId);
            if (conv) {
                conv.lastMessage = text;
                conv.lastMessageAt = new Date();
                renderConversationList();
            }
            composeInput.value = '';
            resizeComposeInput();
            if (isMobileView() && composeInput) composeInput.focus();
        } catch (err) {
            console.error('Send message error:', err);
        } finally {
            isSendingMessage = false;
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.removeAttribute('aria-busy');
            }
        }
    }

    sendBtn?.addEventListener('click', () => { doSendMessage(); });

    sendBtn?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    sendBtn?.addEventListener('touchend', (e) => {
        if (e.target.closest('#messages-send-btn')) doSendMessage();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    const ownerDropdown = $('new-conv-owner-dropdown');
    const petDropdown = $('new-conv-pet-dropdown');
    const ownerTrigger = $('new-conv-owner-trigger');
    const petTrigger = $('new-conv-pet-trigger');
    const ownerMenu = $('new-conv-owner-menu');
    const petMenu = $('new-conv-pet-menu');

    function closeAllDropdowns() {
        ownerDropdown?.classList.remove('is-open');
        petDropdown?.classList.remove('is-open');
    }
    ownerTrigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        ownerDropdown?.classList.toggle('is-open');
        petDropdown?.classList.remove('is-open');
    });
    petTrigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        petDropdown?.classList.toggle('is-open');
        ownerDropdown?.classList.remove('is-open');
    });
    document.addEventListener('click', closeAllDropdowns);
    ownerMenu?.addEventListener('click', (e) => e.stopPropagation());
    petMenu?.addEventListener('click', (e) => e.stopPropagation());

    onAuthStateChanged(auth, (user) => {
        if (user) {
            subscribeToConversations();
        } else {
            setListState(false, true, false);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
