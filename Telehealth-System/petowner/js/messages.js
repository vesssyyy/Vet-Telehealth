/**
 * Televet Health — Pet Owner Messages UI
 * Firestore integration for real-time conversations.
 */
import { auth, db } from '../../shared/js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc,
    query, where, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { loadPets, loadVets } from './appointment-manager.js';

const $ = (id) => document.getElementById(id);
const refs = {
    overlay: $('new-conversation-overlay'),
    modal: $('new-conversation-modal'),
    closeBtn: $('new-conversation-close'),
    cancelBtn: $('new-conversation-cancel'),
    form: $('new-conversation-form'),
    listLoading: $('messages-list-loading'),
    listEmpty: $('messages-list-empty'),
    listRoot: $('messages-conversation-list'),
    emptySinglePanel: $('messages-empty-single-panel'),
    messagesWrapper: $('messages-wrapper'),
    chatWelcome: $('messages-chat-welcome'),
    chatActive: $('messages-chat-active'),
    chatBack: $('messages-chat-back'),
    composeInput: $('messages-compose-input'),
    sendBtn: $('messages-send-btn'),
};

let conversations = [];
let currentConvId = null;
let messagesUnsubscribe = null;
let isSendingMessage = false;

const isMobileView = () => window.matchMedia('(max-width: 768px)').matches;

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function setTriggerText(triggerId, text) {
    const el = $(triggerId)?.querySelector('.new-conv-trigger-text');
    if (el) el.textContent = text;
}

function showModalError(msg) {
    const el = $('new-conversation-error');
    if (el) {
        el.textContent = msg;
        el.classList.remove('is-hidden');
    }
}

function openModal() {
    if (!refs.overlay || !refs.modal) return;
    $('new-conversation-error')?.classList.add('is-hidden');
    [refs.overlay, refs.modal].forEach((el) => {
        el?.classList.add('is-open');
        el?.setAttribute('aria-hidden', 'false');
    });
    document.body.style.overflow = 'hidden';
    refs.modal.focus();
    loadModalData();
}

function closeModal() {
    [refs.overlay, refs.modal].forEach((el) => {
        el?.classList.remove('is-open');
        el?.setAttribute('aria-hidden', 'true');
    });
    document.body.style.overflow = '';
    [$('new-conv-pet'), $('new-conv-vet'), $('new-conv-message')].forEach((el) => el && (el.value = ''));
    setTriggerText('new-conv-pet-trigger', 'Select Pet');
    setTriggerText('new-conv-vet-trigger', 'Select Vet');
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
            : pets.map((p) => `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${escapeHtml(p.id)}" data-pet-name="${escapeHtml(p.name || 'Unnamed')}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(p.name || 'Unnamed')}</span></button>`).join('');
        vetMenu.innerHTML = vets.length === 0
            ? '<div class="new-conv-empty">No veterinarians available.</div>'
            : vets.map((v) => `<button type="button" class="new-conv-item" role="menuitem" data-vet-id="${escapeHtml(v.id)}" data-vet-name="${escapeHtml(v.name)}" data-vet-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-user-md dropdown-item-icon"></i><span>${escapeHtml(v.name)}${v.clinic ? ' – ' + escapeHtml(v.clinic) : ''}</span></button>`).join('');
        petMenu.querySelectorAll('.new-conv-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                $('new-conv-pet').value = btn.dataset.petId;
                setTriggerText('new-conv-pet-trigger', btn.dataset.petName || 'Select Pet');
                $('new-conv-pet-dropdown')?.classList.remove('is-open');
            });
        });
        vetMenu.querySelectorAll('.new-conv-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const text = (btn.dataset.vetName || '') + (btn.dataset.vetClinic ? ' – ' + btn.dataset.vetClinic : '');
                $('new-conv-vet').value = btn.dataset.vetId;
                setTriggerText('new-conv-vet-trigger', text || 'Select Vet');
                $('new-conv-vet-dropdown')?.classList.remove('is-open');
            });
        });
    } catch (err) {
        console.error('Load pets/vets for messages:', err);
        showModalError('Failed to load pets and vets. Please try again.');
    }
}

function setChatView(active) {
    refs.chatWelcome?.classList.toggle('is-hidden', active);
    refs.chatActive?.classList.toggle('is-hidden', !active);
    if (refs.messagesWrapper && isMobileView()) {
        refs.messagesWrapper.classList.toggle('messages-wrapper--conversation-open', active);
    }
}
const showPlaceholder = () => setChatView(false);
const showChat = () => setChatView(true);

function updateChatHeader(conv) {
    const vetNameEl = $('messages-chat-vet-name');
    const specialtyEl = $('messages-chat-specialty');
    const petBadgeEl = $('messages-chat-pet-badge');
    if (vetNameEl) vetNameEl.textContent = conv.vetName || '';
    if (specialtyEl) specialtyEl.textContent = conv.vetSpecialty || conv.clinic || 'Veterinarian';
    if (petBadgeEl) petBadgeEl.textContent = conv.petName || '';
}

function setListState(loading, empty, hasItems) {
    refs.listLoading?.classList.toggle('is-hidden', !loading);
    refs.listEmpty?.classList.toggle('is-hidden', !empty);
    if (refs.listRoot) refs.listRoot.style.display = hasItems ? '' : 'none';
    refs.emptySinglePanel?.classList.toggle('is-hidden', !empty);
    refs.messagesWrapper?.classList.toggle('is-hidden', empty);
}

const formatMessageTime = (ts) => ts?.toDate ? ts.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

function formatConversationMeta(ts) {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const diff = Date.now() - d;
    if (diff < 6e4) return 'Just now';
    if (diff < 864e5) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (diff < 1728e5) return 'Yesterday';
    if (diff < 6048e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderConversationList() {
    if (!refs.listRoot) return;
    refs.listRoot.innerHTML = '';
    const uniqueConvs = [...new Map(conversations.map((c) => [c.id, c])).values()];
    uniqueConvs.forEach((conv) => {
        const item = document.createElement('li');
        item.className = 'messages-conversation-item' + (conv.id === currentConvId ? ' is-active' : '');
        item.setAttribute('role', 'listitem');
        item.dataset.convId = conv.id;
        item.innerHTML = `
            <div class="messages-conv-avatar"><i class="fa fa-user-md" aria-hidden="true"></i></div>
            <div class="messages-conv-body">
                <div class="messages-conv-title"><span class="conv-pet">${escapeHtml(conv.petName)}</span><span class="conv-plus"> + </span><span class="conv-vet">${escapeHtml(conv.vetName)}</span></div>
                <div class="messages-conv-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</div>
                <div class="messages-conv-meta">${formatConversationMeta(conv.lastMessageAt)}</div>
            </div>
        `;
        refs.listRoot.appendChild(item);
    });
    refs.listRoot.style.display = uniqueConvs.length ? '' : 'none';
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
        row.innerHTML = `
            <div class="message-row-avatar"><i class="fa ${isSent ? 'fa-user' : 'fa-user-md'}" aria-hidden="true"></i></div>
            <div class="message-bubble message-bubble--${isSent ? 'sent' : 'received'}">
                <div>${escapeHtml(msg.text || '')}</div>
                <div class="message-bubble-time">${formatMessageTime(msg.sentAt)}</div>
            </div>
        `;
        body.appendChild(row);
    });
    body.scrollTop = body.scrollHeight;
}

function openConversation(conv) {
    currentConvId = conv.id;
    if (isMobileView()) history.pushState({ conv: conv.id }, '', location.href);
    updateChatHeader(conv);
    if (messagesUnsubscribe) messagesUnsubscribe();
    const messagesRef = collection(db, 'conversations', conv.id, 'messages');
    messagesUnsubscribe = onSnapshot(
        query(messagesRef, orderBy('sentAt', 'asc')),
        (snap) => renderChatMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
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
    return onSnapshot(q, (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        conversations = [...new Map(docs.map((c) => [c.id, c])).values()];
        setListState(false, conversations.length === 0, conversations.length > 0);
        renderConversationList();
        if (currentConvId) {
            const conv = conversations.find((c) => c.id === currentConvId);
            if (conv) updateChatHeader(conv);
        }
    }, (err) => {
        console.error('Conversations listener error:', err);
        setListState(false, true, false);
    });
}

function init() {
    setListState(false, true, false);
    showPlaceholder();

    [refs.closeBtn, refs.cancelBtn, refs.overlay].forEach((el) => {
        el?.addEventListener('click', (e) => {
            if (el === refs.overlay && e.target !== refs.overlay) return;
            closeModal();
        });
    });
    $('messages-list-new-icon')?.addEventListener('click', openModal);
    $('messages-empty-new-icon')?.addEventListener('click', openModal);

    function goBackToList() {
        refs.composeInput?.blur();
        document.body.classList.remove('messages-input-focused');
        currentConvId = null;
        if (messagesUnsubscribe) {
            messagesUnsubscribe();
            messagesUnsubscribe = null;
        }
        showPlaceholder();
        renderConversationList();
    }
    refs.chatBack?.addEventListener('click', () => {
        if (isMobileView() && currentConvId) history.back();
        else goBackToList();
    });
    window.addEventListener('popstate', () => {
        if (isMobileView() && currentConvId) goBackToList();
    });

    const searchInput = $('messages-search-input');
    searchInput?.addEventListener('input', () => {
        const q = (searchInput.value || '').trim().toLowerCase();
        refs.listRoot?.querySelectorAll('.messages-conversation-item').forEach((item) => {
            const title = item.querySelector('.messages-conv-title')?.textContent || '';
            const preview = item.querySelector('.messages-conv-preview')?.textContent || '';
            item.style.display = !q || (title + ' ' + preview).toLowerCase().includes(q) ? '' : 'none';
        });
    });

    refs.listRoot?.addEventListener('click', (e) => {
        const item = e.target.closest('.messages-conversation-item');
        if (!item) return;
        e.preventDefault();
        const conv = conversations.find((c) => c.id === item.dataset.convId);
        if (conv) {
            refs.listRoot.querySelectorAll('.messages-conversation-item').forEach((i) => i.classList.remove('is-active'));
            item.classList.add('is-active');
            openConversation(conv);
        }
    });

    refs.form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const petId = $('new-conv-pet')?.value;
        const vetId = $('new-conv-vet')?.value;
        const petTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        const vetTriggerText = $('new-conv-vet-trigger')?.querySelector('.new-conv-trigger-text')?.textContent;
        if (!petId || !vetId) {
            showModalError('Please select both a pet and a veterinarian.');
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
            const existingQ = query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid));
            const existingSnap = await getDocs(existingQ);
            const existingDoc = existingSnap.docs.find((d) => {
                const data = d.data();
                return data.vetId === vetId && data.petId === petId;
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
            const initialMessage = ($('new-conv-message')?.value || '').trim();
            const ownerDoc = await getDoc(doc(db, 'users', user.uid));
            const ownerData = ownerDoc.exists() ? ownerDoc.data() : {};
            const ownerName = (ownerData.displayName || '').trim()
                || [ownerData.firstName, ownerData.lastName].filter(Boolean).join(' ').trim()
                || (ownerData.email || '').split('@')[0]
                || 'Pet Owner';
            const convRef = await addDoc(collection(db, 'conversations'), {
                ownerId: user.uid, ownerName, vetId, petId,
                petName: petTriggerText || 'Pet', vetName: vetTriggerText || 'Vet', vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: initialMessage || '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
            });
            if (initialMessage) {
                await addDoc(collection(db, 'conversations', convRef.id, 'messages'), {
                    senderId: user.uid, text: initialMessage, sentAt: serverTimestamp(),
                });
            }
            closeModal();
            const newConv = {
                id: convRef.id, ownerId: user.uid, ownerName, vetId, petId,
                petName: petTriggerText || 'Pet', vetName: vetTriggerText || 'Vet', vetSpecialty: '',
                participants: [user.uid, vetId],
                lastMessage: initialMessage || '', lastMessageAt: new Date(), createdAt: new Date(),
            };
            if (!conversations.find((c) => c.id === newConv.id)) conversations = [newConv, ...conversations];
            setListState(false, false, true);
            renderConversationList();
            openConversation(newConv);
        } catch (err) {
            console.error('Create conversation error:', err);
            showModalError(err?.message || 'Failed to start conversation. Please try again.');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Start Chat';
            }
        }
    });

    function resizeComposeInput() {
        if (!refs.composeInput) return;
        refs.composeInput.style.height = 'auto';
        const lh = parseFloat(getComputedStyle(refs.composeInput).lineHeight) || refs.composeInput.scrollHeight;
        refs.composeInput.style.height = Math.min(Math.max(refs.composeInput.scrollHeight, lh), lh * 5) + 'px';
    }
    refs.composeInput?.addEventListener('input', resizeComposeInput);
    refs.composeInput?.addEventListener('paste', () => setTimeout(resizeComposeInput, 0));
    refs.composeInput?.addEventListener('focus', () => { if (isMobileView()) document.body.classList.add('messages-input-focused'); });
    refs.composeInput?.addEventListener('blur', () => document.body.classList.remove('messages-input-focused'));
    function syncInputFocusedState() {
        if (!isMobileView() || !window.visualViewport) return;
        if (window.visualViewport.height > window.innerHeight * 0.75) {
            document.body.classList.remove('messages-input-focused');
            refs.composeInput?.blur();
        }
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncInputFocusedState);
        window.visualViewport.addEventListener('scroll', syncInputFocusedState);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) document.body.classList.remove('messages-input-focused');
    });

    async function doSendMessage() {
        if (isSendingMessage) return;
        const text = (refs.composeInput?.value || '').trim();
        if (!text || !currentConvId || !auth.currentUser) return;
        isSendingMessage = true;
        if (refs.sendBtn) {
            refs.sendBtn.disabled = true;
            refs.sendBtn.setAttribute('aria-busy', 'true');
        }
        try {
            await addDoc(collection(db, 'conversations', currentConvId, 'messages'), {
                senderId: auth.currentUser.uid, text, sentAt: serverTimestamp(),
            });
            await updateDoc(doc(db, 'conversations', currentConvId), {
                lastMessage: text, lastMessageAt: serverTimestamp(),
            });
            const conv = conversations.find((c) => c.id === currentConvId);
            if (conv) {
                conv.lastMessage = text;
                conv.lastMessageAt = new Date();
                renderConversationList();
            }
            refs.composeInput.value = '';
            resizeComposeInput();
            if (isMobileView()) refs.composeInput?.focus();
        } catch (err) {
            console.error('Send message error:', err);
        } finally {
            isSendingMessage = false;
            if (refs.sendBtn) {
                refs.sendBtn.disabled = false;
                refs.sendBtn.removeAttribute('aria-busy');
            }
        }
    }
    refs.sendBtn?.addEventListener('click', doSendMessage);
    refs.sendBtn?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    refs.sendBtn?.addEventListener('touchend', (e) => {
        if (e.target.closest('#messages-send-btn')) doSendMessage();
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    const petDropdown = $('new-conv-pet-dropdown');
    const vetDropdown = $('new-conv-vet-dropdown');
    const petTrigger = $('new-conv-pet-trigger');
    const vetTrigger = $('new-conv-vet-trigger');
    const closeAllDropdowns = () => {
        petDropdown?.classList.remove('is-open');
        vetDropdown?.classList.remove('is-open');
    };
    petTrigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        petDropdown?.classList.toggle('is-open');
        vetDropdown?.classList.remove('is-open');
    });
    vetTrigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        vetDropdown?.classList.toggle('is-open');
        petDropdown?.classList.remove('is-open');
    });
    document.addEventListener('click', closeAllDropdowns);
    $('new-conv-pet-menu')?.addEventListener('click', (e) => e.stopPropagation());
    $('new-conv-vet-menu')?.addEventListener('click', (e) => e.stopPropagation());

    onAuthStateChanged(auth, (user) => {
        if (user) subscribeToConversations();
        else setListState(false, true, false);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
