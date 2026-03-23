/**
 * Televet Health — Shared Messaging UI
 *
 * Creates a fully configured messaging instance via createMessaging(config).
 * Each role page (pet owner / vet) calls this factory inside its init() function
 * and then adds only its role-specific logic on top.
 *
 * @param {object}   config
 * @param {string}   config.readField          Firestore read-at field name
 * @param {string}   config.deliveredField      Firestore delivered-at field name
 * @param {string}   config.sentAvatarIcon      FA class for sent-message avatar
 * @param {string}   config.receivedAvatarIcon  FA class for received-message avatar
 * @param {function} config.buildConvItem       (conv) → inner HTML for a list item
 */

import { auth, db } from './firebase-config.js';
import { escapeHtml, timestampToMs } from './utils.js';
import {
    validateAttachment, getAttachmentKind,
    uploadMessageAttachment, renderAttachment,
} from './message-attachments.js';
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
    const { readField, deliveredField, sentAvatarIcon, receivedAvatarIcon, buildConvItem, getAppointmentsForConv } = config;

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
        pendingAttachment:          null,
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
    function renderMessageStatusIcon(msg, conv, isLastSent) {
        if (!isLastSent) return '';
        if ((msg.status || 'sent') === 'sending') {
            return '<span class="message-status message-status--sending" aria-label="Sending"><i class="fa fa-spinner fa-spin"></i></span>';
        }
        const convData    = conv || state.currentConvData || {};
        const msgMs       = timestampToMs(msg.sentAt);
        const lastReadMs  = timestampToMs(convData[readField]);
        const lastDelivMs = timestampToMs(convData[deliveredField]);
        if (lastReadMs  >= msgMs) return '<span class="message-status message-status--seen"      aria-label="Seen"><i class="fa fa-eye"></i></span>';
        if (lastDelivMs >= msgMs) return '<span class="message-status message-status--delivered" aria-label="Delivered"><i class="fa fa-check-double"></i></span>';
        return '<span class="message-status message-status--sent" aria-label="Sent"><i class="fa fa-check"></i></span>';
    }

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

        messages.forEach((msg, index) => {
            // System message for terminated calls — do not render in the UI.
            if (msg.type === 'session_ended') return;

            const bubbleText = msg.text || '';
            const isSent     = msg.senderId === uid;
            const isSending  = msg.status === 'sending';
            const side       = isSent ? 'sent' : 'received';
            const avatarIcon = isSent ? sentAvatarIcon : receivedAvatarIcon;
            const statusIcon = isSent ? renderMessageStatusIcon(msg, convData, msg.id === lastSentId) : '';
            const showTime   = msg.id === state.defaultTimestampMessageId || msg.id === state.selectedTimestampMessageId;
            const timeText   = showTime ? formatBubbleTimestamp(msg.sentAt) : '';
            const footerHtml = (timeText || statusIcon)
                ? `<div class="message-bubble-footer">
                    ${timeText ? `<span class="message-bubble-time">${escapeHtml(timeText)}</span>` : ''}
                    ${statusIcon}
                </div>`
                : '';
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

        // Intentionally no click-to-reveal timestamp behavior.

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

    function formatBubbleTimestamp(ts) {
        if (!ts?.toDate) return '';
        const d = ts.toDate();
        if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekStart = new Date(today);
        const day = weekStart.getDay(); // Sunday=0
        const diffToMonday = day === 0 ? 6 : day - 1;
        weekStart.setDate(weekStart.getDate() - diffToMonday);
        const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

        if (msgDay.getTime() === today.getTime()) return timePart;
        if (msgDay.getTime() === yesterday.getTime()) return `Yesterday - ${timePart}`;
        if (msgDay >= weekStart) {
            const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
            return `${weekday} - ${timePart}`;
        }
        const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        return `${datePart} - ${timePart}`;
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
    /**
     * Subscribe to a conversation's doc + messages sub-collection.
     * Cleans up previous listeners automatically.
     * @param {object}   conv
     * @param {string}   myId
     * @param {function} markReadFn   async () → updateDoc for lastReadAt
     */
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

    /* ── Attachment preview ────────────────────────────────────────── */
    function showAttachPreview(file) {
        state.pendingAttachment = file;
        if (refs.attachPreview && refs.attachPreviewName) {
            refs.attachPreviewName.textContent = file.name || 'File';
            refs.attachPreview.classList.remove('is-hidden');
        }
    }
    function clearAttachPreview() {
        state.pendingAttachment = null;
        if (refs.attachInput) refs.attachInput.value = '';
        refs.attachPreview?.classList.add('is-hidden');
        if (refs.attachPreviewName) refs.attachPreviewName.textContent = '';
    }

    /* ── Emoji picker ──────────────────────────────────────────────── */
    const EMOJI_LIST = ['😀','😊','😁','😂','🤣','😃','😄','😅','😉','😍','😘','🥰','🙂','🤗','😋','😜','😎','🤔','😐','😏','🙄','😌','😔','😴','😷','🤒','🤢','🤧','😵','😤','😡','👍','👎','👏','🙌','🙏','✌️','🤞','👌','❤️','🧡','💛','💚','💙','💜','🖤','💕','💖','💪','🐾','🐕','🐈','🦴','⭐','🔥','✨','💯'];
    let emojiPickerEl = null;

    function getOrCreateEmojiPicker() {
        if (emojiPickerEl) return emojiPickerEl;
        emojiPickerEl = document.createElement('div');
        emojiPickerEl.id = 'messages-emoji-picker';
        emojiPickerEl.className = 'messages-emoji-picker';
        emojiPickerEl.setAttribute('role', 'listbox');
        emojiPickerEl.setAttribute('aria-label', 'Choose emoji');
        EMOJI_LIST.forEach(emoji => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'messages-emoji-picker-item';
            btn.textContent = emoji;
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-label', `Insert ${emoji}`);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                insertEmojiAtCursor(emoji);
                closeEmojiPicker();
            });
            emojiPickerEl.appendChild(btn);
        });
        document.body.appendChild(emojiPickerEl);
        document.addEventListener('click', (e) => {
            if (emojiPickerEl?.classList.contains('is-open') && !emojiPickerEl.contains(e.target) && e.target !== refs.emojiBtn) {
                closeEmojiPicker();
            }
        });
        return emojiPickerEl;
    }

    function insertEmojiAtCursor(emoji) {
        const input = refs.composeInput;
        if (!input) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        const newVal = before + emoji + after;
        if (newVal.length > (input.getAttribute('maxlength') || 2000)) return;
        input.value = newVal;
        const newPos = start + emoji.length;
        input.setSelectionRange(newPos, newPos);
        input.focus();
        resizeComposeInput();
    }

    function toggleEmojiPicker() {
        const picker = getOrCreateEmojiPicker();
        const isOpen = picker.classList.toggle('is-open');
        refs.emojiBtn?.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            const wrap = refs.composeInput?.closest('.messages-chat-compose');
            if (wrap) {
                const br = wrap.getBoundingClientRect();
                const margin = 8;
                const maxH = 220;
                let left = Math.max(margin, br.left);
                const maxW = Math.min(320, window.innerWidth - margin * 2);
                let width = Math.min(br.width, maxW, window.innerWidth - left - margin);
                if (left + width > window.innerWidth - margin) {
                    width = window.innerWidth - left - margin;
                }
                left = Math.min(left, window.innerWidth - width - margin);
                const bottomFromCompose = window.innerHeight - br.top + margin;
                const bottom = Math.min(bottomFromCompose, window.innerHeight - maxH - margin);
                picker.style.left = `${left}px`;
                picker.style.width = `${Math.max(width, 200)}px`;
                picker.style.bottom = `${bottom}px`;
                picker.style.top = '';
                picker.style.right = '';
            }
        }
    }

    function closeEmojiPicker() {
        emojiPickerEl?.classList.remove('is-open');
        refs.emojiBtn?.setAttribute('aria-expanded', 'false');
    }

    /* ── Send message ──────────────────────────────────────────────── */
    async function doSendMessage() {
        if (state.isSendingMessage) return;
        const text         = (refs.composeInput?.value || '').trim();
        const fileToUpload = state.pendingAttachment;
        if ((!text && !fileToUpload) || !state.currentConvId || !auth.currentUser) return;

        state.isSendingMessage = true;
        closeEmojiPicker();
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

            clearAttachPreview();
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
            alert(err?.message || 'Failed to send message.');
            clearTimeout(safetyTimer);
            resetSending();
        }
    }

    /* ── Lightbox ──────────────────────────────────────────────────── */
    function initLightbox() {
        const lb      = $('messages-image-lightbox');
        const lbImg   = lb?.querySelector('.messages-image-lightbox-img');
        const lbTab   = lb?.querySelector('.messages-image-lightbox-open-tab');

        const openLB  = src => {
            if (!lb || !lbImg) return;
            lbImg.src = src; lbImg.alt = 'Enlarged image';
            if (lbTab) lbTab.href = src;
            lb.classList.remove('is-hidden'); lb.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        };
        const closeLB = () => {
            if (!lb) return;
            lb.classList.add('is-hidden'); lb.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
            if (lbImg) lbImg.removeAttribute('src');
        };

        lb?.querySelector('.messages-image-lightbox-close')?.addEventListener('click', closeLB);
        lb?.querySelector('.messages-image-lightbox-backdrop')?.addEventListener('click', closeLB);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) {
                closeLB(); e.stopImmediatePropagation();
            }
        });
        $('messages-chat-body')?.addEventListener('click', e => {
            const wrap = e.target.closest('.message-attachment--image');
            if (!wrap) return;
            const img = wrap.querySelector('.message-attachment-img');
            if (!img?.src) return;
            e.preventDefault(); openLB(img.src);
        });
    }

    /* ── Init shared UI ────────────────────────────────────────────── */
    /**
     * Wire all shared event listeners.
     * @param {object}   opts
     * @param {function} opts.doOpenModal   () => void
     * @param {function} opts.doCloseModal  () => void
     * @param {function} opts.onFormSubmit  async (e) => void
     * @param {function} opts.onConvClick   (conv) => void
     * @param {string[]} opts.dropdownIds   IDs of the new-conv dropdown wrappers (without -trigger/-menu suffixes)
     */
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

        /* Click-to-reveal message timestamp
         * - Last message timestamp stays visible by default.
         * - One additional clicked message can show its timestamp.
         */
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
            toggleEmojiPicker();
        });

        /* Attachment */
        refs.attachBtn?.addEventListener('click', () => refs.attachInput?.click());
        refs.attachPreviewRemove?.addEventListener('click', clearAttachPreview);
        refs.attachInput?.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (!file) return;
            const v = validateAttachment(file);
            if (!v.ok) { alert(v.error); refs.attachInput.value = ''; return; }
            showAttachPreview(file);
        });

        /* Send button */
        refs.sendBtn?.addEventListener('click', doSendMessage);
        refs.sendBtn?.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
        refs.sendBtn?.addEventListener('touchend', e => { if (e.target.closest('#messages-send-btn')) doSendMessage(); });

        /* Dropdown toggles
         * Each entry in dropdownIds is a base prefix (e.g. 'new-conv-pet').
         * Expects DOM ids: {base}-dropdown, {base}-trigger, {base}-menu. */
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
        resizeComposeInput, showAttachPreview, clearAttachPreview,
        doSendMessage, initSharedUI,
    };
}
