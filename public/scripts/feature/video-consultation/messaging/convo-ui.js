/**
 * Video consultation — convo list rendering and lightbox wiring.
 * Uses core messaging attachment rendering + download initializer.
 */
import { escapeHtml } from '../../../core/app/utils.js';
import { renderAttachment } from '../../../core/messaging/attachments.js';
import {
    initMessagingFileAttachmentDownload,
    initMessagingImageLightbox,
    wireMessageAttachmentThumbnails,
} from '../../../core/messaging/messages-ui-core.js';

export function createVideoCallConvoRenderer(options = {}) {
    const {
        convoMessagesList,
        convoBody,
        isVet = false,
        uid = '',
        sentAvatarUrl = '',
        receivedAvatarUrl = '',
    } = options;

    function renderConvoMessages(messages) {
        if (!convoMessagesList) return;
        convoMessagesList.innerHTML = '';

        const sentAvatarIcon = isVet ? 'fa-user-md' : 'fa-user';
        const receivedAvatarIcon = isVet ? 'fa-user' : 'fa-user-md';

        const appendMessage = (msg) => {
            if (msg?.type === 'session_ended') return;

            const text = msg?.text || '';
            const isSent = msg?.senderId === uid;
            const side = isSent ? 'sent' : 'received';
            const avatarUrl = isSent ? sentAvatarUrl : receivedAvatarUrl;
            const avatarIcon = isSent ? sentAvatarIcon : receivedAvatarIcon;
            const avatarInner = avatarUrl
                ? `<img src="${escapeHtml(avatarUrl)}" alt="" class="video-call-msg-avatar-img">`
                : `<i class="fa ${avatarIcon}" aria-hidden="true"></i>`;
            const bubble = document.createElement('div');
            bubble.className = `video-call-msg video-call-msg--${side}`;
            bubble.innerHTML = `
                <span class="video-call-msg-avatar">${avatarInner}</span>
                <div class="video-call-msg-bubble">
                    ${msg?.attachment ? renderAttachment(msg.attachment, msg.status === 'sending') : ''}
                    ${text ? `<span class="video-call-msg-text">${escapeHtml(text)}</span>` : ''}
                </div>`;
            convoMessagesList.appendChild(bubble);
        };

        (messages || []).forEach(appendMessage);

        convoMessagesList.querySelectorAll('.message-attachment-img').forEach((img) => { img.loading = 'eager'; });
        wireMessageAttachmentThumbnails(convoMessagesList);

        if (convoBody) convoBody.scrollTop = convoBody.scrollHeight;
    }

    return { renderConvoMessages };
}

export function initVideoCallConvoLightbox(options = {}) {
    const { $ = (id) => document.getElementById(id), convoBody } = options;
    if (!convoBody) return { closeLightbox: () => {} };

    initMessagingFileAttachmentDownload(convoBody);
    const { close } = initMessagingImageLightbox({
        lightboxEl: $('messages-image-lightbox'),
        chatBodyEl: convoBody,
    });

    return { closeLightbox: close };
}

