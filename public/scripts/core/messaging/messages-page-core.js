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
    wireMessageAttachmentThumbnails,
    createAttachmentPreviewController,
    buildMessageFooterHtml,
} from './messages-ui-core.js';
import {
    collection, doc, getDoc, addDoc, updateDoc,
    query, orderBy, onSnapshot, serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const $ = id => document.getElementById(id);
const isMobileView = () => window.matchMedia('(max-width: 768px)').matches;

/* ─────────────────────────────────────────────────────────────────────────
   Factory
───────────────────────────────────────────────────────────────────────── */
export function createMessaging(config) {
    const {
        readField, deliveredField, selfReadField,
        incomingDeliveredField,
        selfUnreadCountField, peerUnreadCountField,
        sentAvatarIcon, receivedAvatarIcon, buildConvItem,
    } = config;

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
        pageBootstrap:       $('messages-page-bootstrap'),
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
        selectedTimestampMessageId: null,
        defaultTimestampMessageId:  null,
        sentAvatarUrl:              '',
        receivedAvatarUrl:          '',
        incomingDeliveredTimer:     null,
        peerMessagesFingerprint:    null,
        threadMarkReadTimer:        null,
        threadDeliveryPrimed:     false,
        listDeliveryFingerprints:   new Map(),
        listDeliveryTimers:         new Map(),
    };

    /* ── List / chat view ──────────────────────────────────────────── */
    function setPageBootstrap(active) {
        if (!refs.pageBootstrap) return;
        refs.pageBootstrap.classList.toggle('is-hidden', !active);
        refs.pageBootstrap.setAttribute('aria-hidden', active ? 'false' : 'true');
        if (active) refs.pageBootstrap.setAttribute('aria-busy', 'true');
        else refs.pageBootstrap.removeAttribute('aria-busy');
    }

    function setListState(loading, empty, hasItems) {
        refs.listLoading?.classList.toggle('is-hidden', !loading);
        refs.listEmpty?.classList.toggle('is-hidden', !empty);
        if (refs.listRoot) refs.listRoot.style.display = hasItems ? '' : 'none';
        refs.emptySinglePanel?.classList.toggle('is-hidden', !empty);
        refs.messagesWrapper?.classList.toggle('is-hidden', empty);
        if (!loading) setPageBootstrap(false);
    }

    function setChatView(active) {
        /* Always target live nodes: SPA swaps main content; stale refs would toggle detached elements
           so the list updates (fresh getElementById in render) but the chat pane stays on the placeholder. */
        const chatWelcome = document.getElementById('messages-chat-welcome');
        const chatActive = document.getElementById('messages-chat-active');
        const wrap = document.getElementById('messages-wrapper');
        chatWelcome?.classList.toggle('is-hidden', active);
        chatActive?.classList.toggle('is-hidden', !active);
        if (wrap && isMobileView()) {
            wrap.classList.toggle('messages-wrapper--conversation-open', active);
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
            const avatarUrl = isSent ? state.sentAvatarUrl : state.receivedAvatarUrl;
            const avatarInner = avatarUrl
                ? `<img src="${escapeHtml(avatarUrl)}" alt="" class="message-row-avatar-img">`
                : `<i class="fa ${avatarIcon}" aria-hidden="true"></i>`;
            const row        = document.createElement('div');
            row.className    = `message-row message-row--${side}`;
            row.setAttribute('role', 'article');
            row.setAttribute('aria-label', 'Message');
            row.innerHTML = `
                <div class="message-row-avatar">${avatarInner}</div>
                <div class="message-bubble message-bubble--${side}" data-message-id="${escapeHtml(msg.id)}">
                    ${msg.attachment ? renderAttachment(msg.attachment, isSending) : ''}
                    ${bubbleText ? `<div>${escapeHtml(bubbleText)}</div>` : ''}
                    ${footerHtml}
                </div>
            `;
            body.appendChild(row);
        });

        wireMessageAttachmentThumbnails(body);
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

    function resolveUnreadCount(conv) {
        if (!selfUnreadCountField || conv.id === state.currentConvId) return 0;
        const n = conv[selfUnreadCountField];
        if (typeof n === 'number' && !Number.isNaN(n)) {
            if (n > 0) return Math.min(Math.floor(n), 999);
            return 0;
        }
        if (selfReadField && timestampToMs(conv.lastMessageAt) > timestampToMs(conv[selfReadField])) return 1;
        return 0;
    }

    function renderConversationList() {
        if (!refs.listRoot) return;
        refs.listRoot.innerHTML = '';
        const unique = [...new Map(state.conversations.map(c => [c.id, c])).values()];
        unique.forEach(conv => {
            const unreadCount = resolveUnreadCount(conv);
            const isUnread = unreadCount > 0;
            const item = document.createElement('li');
            item.className = 'messages-conversation-item'
                + (conv.id === state.currentConvId ? ' is-active' : '')
                + (isUnread ? ' is-unread' : '');
            item.setAttribute('role', 'listitem');
            item.dataset.convId = conv.id;
            item.innerHTML = buildConvItem(conv, { unreadCount });
            refs.listRoot.appendChild(item);
        });
        refs.listRoot.style.display = unique.length ? '' : 'none';
    }

    /* ── Message subscription ──────────────────────────────────────── */
    /** Stable across sentAt resolution and peer sending→sent; avoids resetting the delivery timer every snapshot. */
    function fingerprintPeerMessages(messages, uid) {
        if (!uid) return '';
        return messages
            .filter(m => m.senderId !== uid)
            .map(m => m.id)
            .sort()
            .join(',');
    }

    /**
     * When the peer sends, the conversation list snapshot still updates even if this user never
     * opens the thread. Writing incomingDeliveredField here matches “delivered to their app/session.”
     */
    function onConversationListUpdated(conversations) {
        const myId = auth.currentUser?.uid;
        if (!incomingDeliveredField || !myId || !conversations?.length) return;

        for (const conv of conversations) {
            const sid = conv.lastMessageSenderId;
            if (sid == null || sid === '') continue;
            if (String(sid) === String(myId)) continue;

            const fp = `${timestampToMs(conv.lastMessageAt)}|${sid}`;
            if (state.listDeliveryFingerprints.get(conv.id) === fp) continue;
            state.listDeliveryFingerprints.set(conv.id, fp);

            const prevT = state.listDeliveryTimers.get(conv.id);
            if (prevT) clearTimeout(prevT);
            state.listDeliveryTimers.set(
                conv.id,
                setTimeout(() => {
                    state.listDeliveryTimers.delete(conv.id);
                    updateDoc(doc(db, 'conversations', conv.id), {
                        [incomingDeliveredField]: serverTimestamp(),
                    }).catch(() => {});
                }, 400)
            );
        }
    }

    function clearListDeliveryScheduling() {
        for (const t of state.listDeliveryTimers.values()) clearTimeout(t);
        state.listDeliveryTimers.clear();
        state.listDeliveryFingerprints.clear();
    }

    function subscribeMessages(conv, myId, markReadFn) {
        state.peerMessagesFingerprint = null;
        state.threadDeliveryPrimed = false;
        if (state.incomingDeliveredTimer) {
            clearTimeout(state.incomingDeliveredTimer);
            state.incomingDeliveredTimer = null;
        }
        if (state.threadMarkReadTimer) {
            clearTimeout(state.threadMarkReadTimer);
            state.threadMarkReadTimer = null;
        }
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
                const hasPeerMessage = Boolean(myId && messages.some(m => m.senderId !== myId));
                const fp = fingerprintPeerMessages(messages, myId);
                const peerChanged = fp !== state.peerMessagesFingerprint;
                state.peerMessagesFingerprint = fp;

                /* Delivery: peer has this thread open and their listener saw peer-authored messages.
                   Primed path covers first snapshot (fp goes null→ids) so opening the thread always
                   acks delivery once; peerChanged covers new messages while staying open. */
                if (incomingDeliveredField && hasPeerMessage && (peerChanged || !state.threadDeliveryPrimed)) {
                    state.threadDeliveryPrimed = true;
                    if (state.incomingDeliveredTimer) clearTimeout(state.incomingDeliveredTimer);
                    state.incomingDeliveredTimer = setTimeout(() => {
                        state.incomingDeliveredTimer = null;
                        if (state.currentConvId !== conv.id) return;
                        updateDoc(doc(db, 'conversations', conv.id), {
                            [incomingDeliveredField]: serverTimestamp(),
                        }).catch(() => {});
                    }, 400);
                }

                /* Read/unread: debounce after delivery so lastDeliveredAt can commit before lastReadAt
                   (otherwise UI never shows double-check — read always wins in Firestore ordering). */
                if (state.threadMarkReadTimer) clearTimeout(state.threadMarkReadTimer);
                state.threadMarkReadTimer = setTimeout(() => {
                    state.threadMarkReadTimer = null;
                    if (state.currentConvId !== conv.id) return;
                    markReadFn().catch(() => {});
                }, 900);

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
        if (state.incomingDeliveredTimer) {
            clearTimeout(state.incomingDeliveredTimer);
            state.incomingDeliveredTimer = null;
        }
        if (state.threadMarkReadTimer) {
            clearTimeout(state.threadMarkReadTimer);
            state.threadMarkReadTimer = null;
        }
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
    function getComposeInputEl() {
        return document.getElementById('messages-compose-input') || refs.composeInput;
    }

    function resizeComposeInput() {
        const el = getComposeInputEl();
        if (!el) return;
        el.style.height = 'auto';
        const lh = parseFloat(getComputedStyle(el).lineHeight) || el.scrollHeight;
        el.style.height = Math.min(Math.max(el.scrollHeight, lh), lh * 5) + 'px';
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
        const composeEl = getComposeInputEl();
        const text = (composeEl?.value || refs.composeInput?.value || '').trim();
        const fileToUpload = attachmentPreview.getPending();
        if ((!text && !fileToUpload) || !state.currentConvId || !auth.currentUser) return;

        const textSnapshot = text;
        composeEl.value = '';
        if (refs.composeInput && refs.composeInput !== composeEl) refs.composeInput.value = '';
        resizeComposeInput();

        state.isSendingMessage = true;
        emojiPicker?.close();
        if (refs.sendBtn) { refs.sendBtn.disabled = true; refs.sendBtn.setAttribute('aria-busy', 'true'); }

        const resetSending = () => {
            state.isSendingMessage = false;
            if (refs.sendBtn) { refs.sendBtn.disabled = false; refs.sendBtn.removeAttribute('aria-busy'); }
        };
        const lastPreview  = textSnapshot || (fileToUpload ? `\uD83D\uDCCE ${fileToUpload.name}` : '');
        const safetyTimer  = setTimeout(resetSending, 15000);

        try {
            const attachPlaceholder = fileToUpload
                ? { name: fileToUpload.name, type: getAttachmentKind(fileToUpload) }
                : null;
            const msgRef = await addDoc(collection(db, 'conversations', state.currentConvId, 'messages'), {
                senderId: auth.currentUser.uid,
                text:     textSnapshot || '',
                sentAt:   serverTimestamp(),
                status:   'sending',
                ...(attachPlaceholder && { attachment: attachPlaceholder }),
            });
            const convUpdate = {
                lastMessage: lastPreview,
                lastMessageAt: serverTimestamp(),
                lastMessageSenderId: auth.currentUser.uid,
            };
            if (selfReadField) convUpdate[selfReadField] = serverTimestamp();
            if (peerUnreadCountField) convUpdate[peerUnreadCountField] = increment(1);
            await updateDoc(doc(db, 'conversations', state.currentConvId), convUpdate);

            const conv = state.conversations.find(c => c.id === state.currentConvId);
            if (conv) { conv.lastMessage = lastPreview; conv.lastMessageAt = new Date(); renderConversationList(); }

            attachmentPreview.clear();
            /* Do not call focus() here on mobile — it causes keyboard dismiss + reopen. Keep focus on
               the textarea by preventing the send button from taking focus (pointerdown/touchstart). */

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
                            status: 'sent', text: (textSnapshot || '') + (err?.message ? ' (upload failed)' : ''),
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
            const el = getComposeInputEl();
            if (el && textSnapshot) el.value = textSnapshot;
            resizeComposeInput();
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
        setPageBootstrap(true);
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

        /* Back: always update UI here. Mobile used history.back() so popstate would run, but the SPA
           router handles popstate first with stopImmediatePropagation and navigate() no-ops for same
           page — so goBackToList() never ran and the thread stayed open. */
        refs.chatBack?.addEventListener('click', () => {
            goBackToList();
            if (isMobileView() && history.state && history.state.conv) {
                history.back();
            }
        });
        /* Capture phase runs before the SPA router’s popstate listener so hardware back leaves the thread. */
        window.addEventListener('popstate', () => {
            if (isMobileView() && state.currentConvId) goBackToList();
        }, true);

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
        /* Defer shrinking .messages-main: sync blur used to reflow before click/touchend on Send finished,
           moving the button so the first tap missed (especially with keyboard open). */
        refs.composeInput?.addEventListener('blur', () => {
            if (!isMobileView()) {
                document.body.classList.remove('messages-input-focused');
                return;
            }
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const wrap = document.querySelector('.messages-chat-compose');
                    const ae = document.activeElement;
                    if (wrap && ae && wrap.contains(ae)) return;
                    document.body.classList.remove('messages-input-focused');
                });
            });
        });
        if (window.visualViewport) {
            let vvTimer = null;
            const vvCollapseIfKeyboardClosed = () => {
                if (!isMobileView() || !window.visualViewport) return;
                if (window.visualViewport.height <= window.innerHeight * 0.75) return;
                clearTimeout(vvTimer);
                vvTimer = setTimeout(() => {
                    vvTimer = null;
                    if (!window.visualViewport || window.visualViewport.height <= window.innerHeight * 0.75) return;
                    const wrap = document.querySelector('.messages-chat-compose');
                    const ae = document.activeElement;
                    if (wrap && ae && wrap.contains(ae)) return;
                    document.body.classList.remove('messages-input-focused');
                    const ci = getComposeInputEl();
                    if (ci && document.activeElement === ci) ci.blur();
                }, 180);
            };
            window.visualViewport.addEventListener('resize', vvCollapseIfKeyboardClosed);
            window.visualViewport.addEventListener('scroll', vvCollapseIfKeyboardClosed);
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

        /* Send: first tap with keyboard open — layout reflow from blur could lose the delayed click.
           Touch path uses pointerup/touchend + preventDefault so send runs before reflow; suppress duplicate click.
           pointerdown/touchstart preventDefault keeps focus on the textarea so the keyboard does not dismiss. */
        if (refs.sendBtn) {
            const keepComposeFocusedOnSendTap = (e) => {
                if (!isMobileView()) return;
                if (window.PointerEvent) {
                    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
                }
                e.preventDefault();
            };
            if (window.PointerEvent) {
                refs.sendBtn.addEventListener('pointerdown', keepComposeFocusedOnSendTap, { passive: false });
            } else {
                refs.sendBtn.addEventListener('touchstart', (e) => {
                    if (!isMobileView()) return;
                    e.preventDefault();
                }, { passive: false });
            }
            let suppressNextClick = false;
            const sendFromTouchLike = (e) => {
                if (!isMobileView()) return;
                if (!refs.sendBtn.contains(e.target)) return;
                if (e.button != null && e.button !== 0) return;
                suppressNextClick = true;
                setTimeout(() => { suppressNextClick = false; }, 450);
                e.preventDefault();
                doSendMessage();
            };
            if (window.PointerEvent) {
                refs.sendBtn.addEventListener('pointerup', (e) => {
                    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
                    sendFromTouchLike(e);
                }, { passive: false });
            } else {
                refs.sendBtn.addEventListener('touchend', sendFromTouchLike, { passive: false });
            }
            refs.sendBtn.addEventListener('click', (e) => {
                if (isMobileView() && suppressNextClick) {
                    e.preventDefault();
                    return;
                }
                doSendMessage();
            });
        }

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
        setListState, setPageBootstrap, setChatView, showPlaceholder, showChat,
        renderChatMessages, renderConversationList,
        subscribeMessages, goBackToList,
        onConversationListUpdated, clearListDeliveryScheduling,
        showModalError, setTriggerText, openModal, closeModal,
        resizeComposeInput,
        doSendMessage, initSharedUI,
    };
}

/** SPA: unsubscribe Firestore + reset chat so a previous visit’s listeners cannot drive the DOM. */
if (typeof window !== 'undefined' && !window.__telehealthMessagesSpaLeaveWired) {
    window.__telehealthMessagesSpaLeaveWired = true;
    window.addEventListener('spa:beforeleave', () => {
        try {
            window.__telehealthMessagesTeardown?.();
        } catch (_) { /* ignore */ }
    });
}

