/**
 * Video consultation — convo list rendering and lightbox wiring.
 * Uses core messaging attachment rendering + download initializer.
 */
import { escapeHtml } from '../../../core/app/utils.js';
import { renderAttachment } from '../../../core/messaging/attachments.js';
import { initMessagingFileAttachmentDownload } from '../../../core/messaging/messages-ui-core.js';

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

        // Reveal image attachments once loaded
        convoMessagesList.querySelectorAll('.message-attachment-img').forEach((img) => {
            const wrap = img.closest('.message-attachment--image');
            if (!wrap) return;
            img.loading = 'eager';
            const reveal = () => wrap.classList.add('is-loaded');
            img.addEventListener('load', reveal);
            img.addEventListener('error', reveal);
            if (img.complete) reveal(); else setTimeout(reveal, 3000);
        });

        if (convoBody) convoBody.scrollTop = convoBody.scrollHeight;
    }

    return { renderConvoMessages };
}

export function initVideoCallConvoLightbox(options = {}) {
    const { $ = (id) => document.getElementById(id), convoBody } = options;
    if (!convoBody) return { closeLightbox: () => {} };

    initMessagingFileAttachmentDownload(convoBody);

    convoBody.addEventListener('click', (e) => {
        const wrap = e.target.closest('.message-attachment--image');
        if (!wrap) return;
        const img = wrap.querySelector('.message-attachment-img');
        if (!img?.src) return;
        e.preventDefault();
        const lb = $('messages-image-lightbox');
        const lbImg = lb?.querySelector('.messages-image-lightbox-img');
        const lbTab = lb?.querySelector('.messages-image-lightbox-open-tab');
        if (lb && lbImg) {
            lbImg.style.opacity = '0';
            lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
            lbImg.src = img.src;
            lbImg.alt = 'Enlarged image';
            if (lbTab) lbTab.href = img.src;
            lb.classList.remove('is-hidden');
            lb.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        }
    });

    const closeLightbox = () => {
        const lb = $('messages-image-lightbox');
        if (!lb) return;
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        const lbImg = lb.querySelector('.messages-image-lightbox-img');
        setTimeout(() => { if (lbImg) lbImg.removeAttribute('src'); }, 280);
    };

    $('messages-image-lightbox')?.querySelector('.messages-image-lightbox-close')?.addEventListener('click', closeLightbox);
    $('messages-image-lightbox')?.querySelector('.messages-image-lightbox-backdrop')?.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
        const lb = $('messages-image-lightbox');
        if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) {
            closeLightbox();
            e.stopImmediatePropagation();
        }
    });

    return { closeLightbox };
}

