/**
 * Televet Health — Messaging (messages page) shared UI
 *
 * Factory used by petowner/vet messaging pages. Kept stable to avoid page regressions.
 */

import { auth, db } from '../firebase/firebase-config.js';
import { escapeHtml, timestampToMs } from '../app/utils.js';
import {
    validateAttachment, getAttachmentKind,
    uploadMessageAttachment, renderAttachment,
} from './attachments.js';
import { appAlertError } from '../ui/app-dialog.js';
import {
    formatBubbleTimestamp,
    renderMessageStatusIcon as renderMessageStatusIconCore,
    createEmojiPicker,
    initMessagingImageLightbox,
    initMessagingFileAttachmentDownload,
    createAttachmentPreviewController,
    buildMessageFooterHtml,
} from './messages-ui-core.js';
import {
    collection, doc, getDoc, addDoc, updateDoc,
    query, orderBy, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const $ = id => document.getElementById(id);
const isMobileView = () => window.matchMedia('(max-width: 768px)').matches;

/* ─────────────────────────────────────────────────────────────────────────
   Factory
───────────────────────────────────────────────────────────────────────── */
export function createMessaging(config) {
    const { readField, deliveredField, sentAvatarIcon, receivedAvatarIcon, buildConvItem } = config;

    /* ── DOM refs ──────────────────────────────────────────────────── */
    const refs = {
        overlay:             $('new-conversation-overlay'),
        modal:               $('new-conversation-modal'),
        closeBtn:            $('new-conversation-close'),
        cancelBtn:           $('new-conversation-cancel'),
        form:                $('new-conversation-form'),
        listLoading:         $('messages-list-loading'),
        listEmpty:           $('messages-list-empty'),
        listRoot:            $('messages-conversation-list'),
        emptySinglePanel:    $('messages-empty-single-panel'),
        messagesWrapper:     $('messages-wrapper'),
        chatWelcome:         $('messages-chat-welcome'),
        chatActive:          $('messages-chat-active'),
        chatBack:            $('messages-chat-back'),
        composeInput:        $('messages-compose-input'),
        sendBtn:             $('messages-send-btn'),
        attachInput:         $('messages-attach-input'),
        attachBtn:           $('messages-attach-btn'),
        emojiBtn:            $('messages-emoji-btn'),
        attachPreview:       $('messages-attach-preview'),
        attachPreviewName:   $('messages-attach-preview-name'),
        attachPreviewRemove: $('messages-attach-preview-remove'),
    };

    /* ── Shared mutable state ──────────────────────────────────────── */
    const state = {
        conversations:              [],
        currentConvId:              null,
        messagesUnsubscribe:        null,
        conversationDocUnsubscribe: null,
        isSendingMessage:           false,
        lastRenderedMessages:       [],
        currentConvData:            undefined,
        deliveredUpdateTimeouts:    new Map(),
        selectedTimestampMessageId: null,
        defaultTimestampMessageId:  null,
    };

    /* ── List / chat view ──────────────────────────────────────────── */
    function setListState(loading, empty, hasItems) {
        refs.listLoading?.classList.toggle('is-hidden', !loading);
        refs.listEmpty?.classList.toggle('is-hidden', !empty);
        if (refs.listRoot) refs.listRoot.style.display = hasItems ? '' : 'none';
        refs.emptySinglePanel?.classList.toggle('is-hidden', !empty);
        refs.messagesWrapper?.classList.toggle('is-hidden', empty);
    }

    function setChatView(active) {
        refs.chatWelcome?.classList.toggle('is-hidden', active);
        refs.chatActive?.classList.toggle('is-hidden', !active);
        if (refs.messagesWrapper && isMobileView()) {
            refs.messagesWrapper.classList.toggle('messages-wrapper--conversation-open', active);
        }
    }
    const showPlaceholder = () => setChatView(false);
    const showChat        = () => setChatView(true);

    /* ── Render helpers ────────────────────────────────────────────── */
    function renderChatMessages(messages, conv) {
        const body = $('messages-chat-body');
        if (!body) return;
        const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
        const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
        state.lastRenderedMessages = messages;
        state.currentConvData      = conv;
        body.innerHTML = '';
        const uid      = auth.currentUser?.uid;
        const convData = conv || state.currentConvData || {};
        const visibleMessages = messages.filter(m => m.type !== 'session_ended');
        const defaultTimestampMsg = visibleMessages.length ? visibleMessages[visibleMessages.length - 1] : null;
        state.defaultTimestampMessageId = defaultTimestampMsg?.id || null;
        if (
            state.selectedTimestampMessageId &&
            !visibleMessages.some(m => m.id === state.selectedTimestampMessageId)
        ) {
            state.selectedTimestampMessageId = null;
        }

        let lastSentId = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].senderId === uid) { lastSentId = messages[i].id; break; }
        }

        messages.forEach((msg) => {
            // System message for terminated calls — do not render in the UI.
            if (msg.type === 'session_ended') return;

            const bubbleText = msg.text || '';
            const isSent     = msg.senderId === uid;
            const isSending  = msg.status === 'sending';
            const side       = isSent ? 'sent' : 'received';
            const avatarIcon = isSent ? sentAvatarIcon : receivedAvatarIcon;
            const statusIcon = isSent
                ? renderMessageStatusIconCore({
                    msg,
                    convData,
                    readField,
                    deliveredField,
                    isLastSent: msg.id === lastSentId,
                })
                : '';
            const showTime = msg.id === state.defaultTimestampMessageId || msg.id === state.selectedTimestampMessageId;
            const timeText = showTime ? formatBubbleTimestamp(msg.sentAt) : '';
            const footerHtml = buildMessageFooterHtml({ timeText, statusIconHtml: statusIcon });
            const row        = document.createElement('div');
            row.className    = `message-row message-row--${side}`;
            row.setAttribute('role', 'article');
            row.setAttribute('aria-label', 'Message');
            row.innerHTML = `
                <div class="message-row-avatar"><i class="fa ${avatarIcon}" aria-hidden="true"></i></div>
                <div class="message-bubble message-bubble--${side}" data-message-id="${escapeHtml(msg.id)}">
                    ${msg.attachment ? renderAttachment(msg.attachment, isSending) : ''}
                    ${bubbleText ? `<div>${escapeHtml(bubbleText)}</div>` : ''}
                    ${footerHtml}
                </div>
            `;
            body.appendChild(row);
        });

        body.querySelectorAll('.message-attachment-img').forEach(img => {
            const wrap = img.closest('.message-attachment--image');
            if (!wrap) return;
            const onLoad = () => wrap.classList.add('is-loaded');
            img.addEventListener('load', onLoad);
            if (img.complete) onLoad();
        });
        if (wasNearBottom) {
            body.scrollTop = body.scrollHeight;
        } else {
            requestAnimationFrame(() => {
                const newScrollHeight = body.scrollHeight;
                const newClientHeight = body.clientHeight;
                const targetScrollTop = Math.max(0, newScrollHeight - newClientHeight - distanceFromBottom);
                body.scrollTop = targetScrollTop;
            });
        }
    }

    function renderConversationList() {
        if (!refs.listRoot) return;
        refs.listRoot.innerHTML = '';
        const unique = [...new Map(state.conversations.map(c => [c.id, c])).values()];
        unique.forEach(conv => {
            const item = document.createElement('li');
            item.className = 'messages-conversation-item' + (conv.id === state.currentConvId ? ' is-active' : '');
            item.setAttribute('role', 'listitem');
            item.dataset.convId = conv.id;
            item.innerHTML = buildConvItem(conv);
            refs.listRoot.appendChild(item);
        });
        refs.listRoot.style.display = unique.length ? '' : 'none';
    }

    /* ── Message subscription ──────────────────────────────────────── */
    function subscribeMessages(conv, myId, markReadFn) {
        if (state.conversationDocUnsubscribe) state.conversationDocUnsubscribe();
        state.conversationDocUnsubscribe = onSnapshot(
            doc(db, 'conversations', conv.id),
            snap => {
                if (!snap.exists()) return;
                state.currentConvData = { id: snap.id, ...snap.data() };
                renderChatMessages(state.lastRenderedMessages, state.currentConvData);
            },
            err => console.warn('Conversation doc listener:', err)
        );

        if (state.messagesUnsubscribe) state.messagesUnsubscribe();
        state.messagesUnsubscribe = onSnapshot(
            query(collection(db, 'conversations', conv.id, 'messages'), orderBy('sentAt', 'asc')),
            snap => {
                const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if (myId && messages.some(m => m.senderId !== myId)) markReadFn().catch(() => {});
                renderChatMessages(messages, state.currentConvData || conv);
            },
            err => console.error('Messages listener error:', err)
        );

        renderConversationList();
        showChat();
    }

    /* ── Navigation ────────────────────────────────────────────────── */
    function goBackToList() {
        refs.composeInput?.blur();
        document.body.classList.remove('messages-input-focused');
        state.currentConvId = null;
        for (const key of ['conversationDocUnsubscribe', 'messagesUnsubscribe']) {
            if (state[key]) { state[key](); state[key] = null; }
        }
        showPlaceholder();
        renderConversationList();
    }

    /* ── Modal helpers ─────────────────────────────────────────────── */
    function showModalError(msg) {
        const el = $('new-conversation-error');
        if (el) { el.textContent = msg; el.classList.remove('is-hidden'); }
    }
    function setTriggerText(triggerId, text) {
        const el = $(triggerId)?.querySelector('.new-conv-trigger-text');
        if (el) el.textContent = text;
    }
    function openModal(loadDataFn) {
        if (!refs.overlay || !refs.modal) return;
        $('new-conversation-error')?.classList.add('is-hidden');
        [refs.overlay, refs.modal].forEach(el => { el?.classList.add('is-open'); el?.setAttribute('aria-hidden', 'false'); });
        document.body.style.overflow = 'hidden';
        refs.modal.focus();
        loadDataFn();
    }
    function closeModal(resetFieldsFn) {
        [refs.overlay, refs.modal].forEach(el => { el?.classList.remove('is-open'); el?.setAttribute('aria-hidden', 'true'); });
        document.body.style.overflow = '';
        resetFieldsFn();
    }

    /* ── Compose input ─────────────────────────────────────────────── */
    function resizeComposeInput() {
        if (!refs.composeInput) return;
        refs.composeInput.style.height = 'auto';
        const lh = parseFloat(getComputedStyle(refs.composeInput).lineHeight) || refs.composeInput.scrollHeight;
        refs.composeInput.style.height = Math.min(Math.max(refs.composeInput.scrollHeight, lh), lh * 5) + 'px';
    }

    /* ── Attachment preview + emoji picker (core) ──────────────────── */
    const attachmentPreview = createAttachmentPreviewController({
        attachInput: refs.attachInput,
        attachPreview: refs.attachPreview,
        attachPreviewName: refs.attachPreviewName,
        attachPreviewRemove: refs.attachPreviewRemove,
        validateAttachment,
    });
    let emojiPicker = null;

    /* ── Send message ──────────────────────────────────────────────── */
    async function doSendMessage() {
        if (state.isSendingMessage) return;
        const text         = (refs.composeInput?.value || '').trim();
        const fileToUpload = attachmentPreview.getPending();
        if ((!text && !fileToUpload) || !state.currentConvId || !auth.currentUser) return;

        state.isSendingMessage = true;
        emojiPicker?.close();
        if (refs.sendBtn) { refs.sendBtn.disabled = true; refs.sendBtn.setAttribute('aria-busy', 'true'); }

        const resetSending = () => {
            state.isSendingMessage = false;
            if (refs.sendBtn) { refs.sendBtn.disabled = false; refs.sendBtn.removeAttribute('aria-busy'); }
        };
        const lastPreview  = text || (fileToUpload ? `\uD83D\uDCCE ${fileToUpload.name}` : '');
        const safetyTimer  = setTimeout(resetSending, 15000);

        try {
            const attachPlaceholder = fileToUpload
                ? { name: fileToUpload.name, type: getAttachmentKind(fileToUpload) }
                : null;
            const msgRef = await addDoc(collection(db, 'conversations', state.currentConvId, 'messages'), {
                senderId: auth.currentUser.uid,
                text:     text || '',
                sentAt:   serverTimestamp(),
                status:   'sending',
                ...(attachPlaceholder && { attachment: attachPlaceholder }),
            });
            await updateDoc(doc(db, 'conversations', state.currentConvId), {
                lastMessage: lastPreview, lastMessageAt: serverTimestamp(),
            });

            const conv = state.conversations.find(c => c.id === state.currentConvId);
            if (conv) { conv.lastMessage = lastPreview; conv.lastMessageAt = new Date(); renderConversationList(); }

            attachmentPreview.clear();
            refs.composeInput.value = '';
            resizeComposeInput();
            if (isMobileView()) refs.composeInput?.focus();

            if (!fileToUpload) {
                await updateDoc(doc(db, 'conversations', state.currentConvId, 'messages', msgRef.id), { status: 'sent' }).catch(() => {});
                clearTimeout(safetyTimer);
                resetSending();
            } else {
                (async () => {
                    try {
                        const attachData = await uploadMessageAttachment(fileToUpload, state.currentConvId);
                        await updateDoc(doc(db, 'conversations', state.currentConvId, 'messages', msgRef.id), { attachment: attachData, status: 'sent' });
                    } catch (err) {
                        console.error('Attachment upload error:', err);
                        await updateDoc(doc(db, 'conversations', state.currentConvId, 'messages', msgRef.id), {
                            status: 'sent', text: (text || '') + (err?.message ? ' (upload failed)' : ''),
                        }).catch(() => {});
                    } finally {
                        clearTimeout(safetyTimer);
                        resetSending();
                    }
                })();
            }
        } catch (err) {
            console.error('Send message error:', err);
            await appAlertError(err?.message || 'Failed to send message.');
            clearTimeout(safetyTimer);
            resetSending();
        }
    }

    /* ── Lightbox ──────────────────────────────────────────────────── */
    function initLightbox() {
        const chatBody = $('messages-chat-body');
        initMessagingImageLightbox({
            lightboxEl: $('messages-image-lightbox'),
            chatBodyEl: chatBody,
        });
        initMessagingFileAttachmentDownload(chatBody);
    }

    /* ── Init shared UI ────────────────────────────────────────────── */
    function initSharedUI({ doOpenModal, doCloseModal, onFormSubmit, onConvClick, dropdownIds = [] }) {
        setListState(false, true, false);
        showPlaceholder();

        /* Modal */
        [refs.closeBtn, refs.cancelBtn, refs.overlay].forEach(el => {
            el?.addEventListener('click', e => {
                if (el === refs.overlay && e.target !== refs.overlay) return;
                doCloseModal();
            });
        });
        $('messages-list-new-icon')?.addEventListener('click', doOpenModal);
        $('messages-empty-new-icon')?.addEventListener('click', doOpenModal);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') doCloseModal(); });

        /* Back + popstate */
        refs.chatBack?.addEventListener('click', () => {
            if (isMobileView() && state.currentConvId) history.back();
            else goBackToList();
        });
        window.addEventListener('popstate', () => { if (isMobileView() && state.currentConvId) goBackToList(); });

        /* Search */
        $('messages-search-input')?.addEventListener('input', e => {
            const q = (e.target.value || '').trim().toLowerCase();
            refs.listRoot?.querySelectorAll('.messages-conversation-item').forEach(item => {
                const text = (item.querySelector('.messages-conv-title')?.textContent || '')
                           + (item.querySelector('.messages-conv-preview')?.textContent || '');
                item.style.display = !q || text.toLowerCase().includes(q) ? '' : 'none';
            });
        });

        /* Conversation list click */
        refs.listRoot?.addEventListener('click', e => {
            const item = e.target.closest('.messages-conversation-item');
            if (!item) return;
            e.preventDefault();
            const conv = state.conversations.find(c => c.id === item.dataset.convId);
            if (conv) {
                refs.listRoot.querySelectorAll('.messages-conversation-item').forEach(i => i.classList.remove('is-active'));
                item.classList.add('is-active');
                onConvClick(conv);
            }
        });

        /* Lightbox */
        initLightbox();

        /* Click-to-reveal message timestamp */
        $('messages-chat-body')?.addEventListener('click', e => {
            const bubble = e.target.closest('.message-bubble');
            if (!bubble) return;
            const messageId = bubble.dataset.messageId;
            if (!messageId) return;
            if (messageId === state.defaultTimestampMessageId) return;
            state.selectedTimestampMessageId =
                state.selectedTimestampMessageId === messageId ? null : messageId;
            renderChatMessages(state.lastRenderedMessages, state.currentConvData);
        });

        /* Form */
        refs.form?.addEventListener('submit', onFormSubmit);

        /* Compose */
        refs.composeInput?.addEventListener('input', resizeComposeInput);
        refs.composeInput?.addEventListener('paste', () => setTimeout(resizeComposeInput, 0));
        refs.composeInput?.addEventListener('focus', () => { if (isMobileView()) document.body.classList.add('messages-input-focused'); });
        refs.composeInput?.addEventListener('blur', () => document.body.classList.remove('messages-input-focused'));
        if (window.visualViewport) {
            const syncFocus = () => {
                if (!isMobileView() || !window.visualViewport) return;
                if (window.visualViewport.height > window.innerHeight * 0.75) {
                    document.body.classList.remove('messages-input-focused');
                    refs.composeInput?.blur();
                }
            };
            window.visualViewport.addEventListener('resize', syncFocus);
            window.visualViewport.addEventListener('scroll', syncFocus);
        }
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) document.body.classList.remove('messages-input-focused');
        });

        /* Emoji */
        refs.emojiBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!emojiPicker) {
                emojiPicker = createEmojiPicker({
                    emojiBtn: refs.emojiBtn,
                    input: refs.composeInput,
                    resizeInput: resizeComposeInput,
                });
            }
            emojiPicker.toggle();
        });

        /* Attachment */
        refs.attachBtn?.addEventListener('click', () => refs.attachInput?.click());

        /* Send button */
        refs.sendBtn?.addEventListener('click', doSendMessage);
        refs.sendBtn?.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
        refs.sendBtn?.addEventListener('touchend', e => { if (e.target.closest('#messages-send-btn')) doSendMessage(); });

        /* Dropdown toggles */
        const dropdowns = dropdownIds.map(base => $(`${base}-dropdown`));
        dropdownIds.forEach((base, i) => {
            $(`${base}-trigger`)?.addEventListener('click', e => {
                e.stopPropagation();
                dropdowns[i]?.classList.toggle('is-open');
                dropdowns.filter((_, j) => j !== i).forEach(o => o?.classList.remove('is-open'));
            });
            $(`${base}-menu`)?.addEventListener('click', e => e.stopPropagation());
        });
        document.addEventListener('click', () => dropdowns.forEach(dd => dd?.classList.remove('is-open')));
    }

    return {
        refs, state, isMobileView,
        setListState, setChatView, showPlaceholder, showChat,
        renderChatMessages, renderConversationList,
        subscribeMessages, goBackToList,
        showModalError, setTriggerText, openModal, closeModal,
        resizeComposeInput,
        doSendMessage, initSharedUI,
    };
}

