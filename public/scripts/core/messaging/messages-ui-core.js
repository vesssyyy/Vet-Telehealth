/**
 * Televet Health — Messaging core helpers
 *
 * Shared by messaging pages today; designed so video-call can adopt later.
 */
import { escapeHtml, timestampToMs } from '../app/utils.js';
import { appAlertError } from '../ui/app-dialog.js';
import { downloadMessageAttachmentFile } from './attachments.js';

/* ── Timestamp formatting ───────────────────────────────────────────── */
export function formatBubbleTimestamp(ts) {
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

/* ── Status icon (sent/delivered/seen) ──────────────────────────────── */
export function renderMessageStatusIcon({ msg, convData, readField, deliveredField, isLastSent }) {
    if (!isLastSent) return '';
    if ((msg.status || 'sent') === 'sending') {
        return '<span class="message-status message-status--sending" aria-label="Sending"><i class="fa fa-spinner fa-spin"></i></span>';
    }
    const msgMs       = timestampToMs(msg.sentAt);
    const lastReadMs  = timestampToMs(convData?.[readField]);
    const lastDelivMs = timestampToMs(convData?.[deliveredField]);
    if (lastReadMs  >= msgMs) return '<span class="message-status message-status--seen"      aria-label="Seen"><i class="fa fa-eye"></i></span>';
    if (lastDelivMs >= msgMs) return '<span class="message-status message-status--delivered" aria-label="Delivered"><i class="fa fa-check-double"></i></span>';
    return '<span class="message-status message-status--sent" aria-label="Sent"><i class="fa fa-check"></i></span>';
}

/* ── Emoji picker ───────────────────────────────────────────────────── */
export function createEmojiPicker({ emojiBtn, input, resizeInput }) {
    const EMOJI_LIST = ['😀','😊','😁','😂','🤣','😃','😄','😅','😉','😍','😘','🥰','🙂','🤗','😋','😜','😎','🤔','😐','😏','🙄','😌','😔','😴','😷','🤒','🤢','🤧','😵','😤','😡','👍','👎','👏','🙌','🙏','✌️','🤞','👌','❤️','🧡','💛','💚','💙','💜','🖤','💕','💖','💪','🐾','🐕','🐈','🦴','⭐','🔥','✨','💯'];
    let pickerEl = null;

    function insertEmojiAtCursor(emoji) {
        if (!input) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        const newVal = before + emoji + after;
        const max = Number(input.getAttribute('maxlength') || 2000);
        if (newVal.length > max) return;
        input.value = newVal;
        const newPos = start + emoji.length;
        input.setSelectionRange(newPos, newPos);
        input.focus();
        resizeInput?.();
    }

    function getOrCreate() {
        if (pickerEl) return pickerEl;
        pickerEl = document.createElement('div');
        pickerEl.id = 'messages-emoji-picker';
        pickerEl.className = 'messages-emoji-picker';
        pickerEl.setAttribute('role', 'listbox');
        pickerEl.setAttribute('aria-label', 'Choose emoji');
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
                close();
            });
            pickerEl.appendChild(btn);
        });
        document.body.appendChild(pickerEl);

        document.addEventListener('click', (e) => {
            if (pickerEl?.classList.contains('is-open') && !pickerEl.contains(e.target) && e.target !== emojiBtn) {
                close();
            }
        });
        return pickerEl;
    }

    function toggle() {
        const picker = getOrCreate();
        const isOpen = picker.classList.toggle('is-open');
        emojiBtn?.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            const wrap = input?.closest('.messages-chat-compose');
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

    function close() {
        pickerEl?.classList.remove('is-open');
        emojiBtn?.setAttribute('aria-expanded', 'false');
    }

    return { toggle, close, getOrCreateElement: () => pickerEl };
}

/* ── Image lightbox (for attachments) ───────────────────────────────── */
export function initMessagingImageLightbox({ lightboxEl, chatBodyEl }) {
    const lb = lightboxEl;
    if (!lb || !chatBodyEl) return { close: () => {} };
    const lbImg = lb.querySelector('.messages-image-lightbox-img');
    const lbTab = lb.querySelector('.messages-image-lightbox-open-tab');

    const open = (src) => {
        if (!lbImg) return;
        lbImg.src = src;
        lbImg.alt = 'Enlarged image';
        if (lbTab) lbTab.href = src;
        lb.classList.remove('is-hidden');
        lb.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    };
    const close = () => {
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        lbImg?.removeAttribute('src');
    };

    lb.querySelector('.messages-image-lightbox-close')?.addEventListener('click', close);
    lb.querySelector('.messages-image-lightbox-backdrop')?.addEventListener('click', close);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && lb && !lb.classList.contains('is-hidden')) {
            close();
            e.stopImmediatePropagation();
        }
    });
    chatBodyEl.addEventListener('click', e => {
        const wrap = e.target.closest('.message-attachment--image');
        if (!wrap) return;
        const img = wrap.querySelector('.message-attachment-img');
        if (!img?.src) return;
        e.preventDefault();
        open(img.src);
    });

    return { close, open };
}

/**
 * File attachments use cross-origin Storage URLs; the anchor `download` attribute is ignored.
 * Intercept click, fetch as blob, trigger save. Capture phase so it runs before bubble
 * handlers (e.g. timestamp toggle). Ctrl/Meta-click still opens the URL in a new tab.
 */
export function initMessagingFileAttachmentDownload(chatBodyEl) {
    if (!chatBodyEl) return;
    chatBodyEl.addEventListener('click', (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const link = e.target.closest('.message-attachment-file-link');
        if (!link?.href) return;
        e.preventDefault();
        e.stopPropagation();
        const name = link.dataset.downloadName || link.querySelector('span')?.textContent?.trim() || 'attachment';
        downloadMessageAttachmentFile(link.href, name);
    }, true);
}

/* ── Attachment preview helpers ─────────────────────────────────────── */
export function createAttachmentPreviewController({ attachInput, attachPreview, attachPreviewName, attachPreviewRemove, validateAttachment }) {
    let pendingAttachment = null;

    function show(file) {
        pendingAttachment = file;
        if (attachPreview && attachPreviewName) {
            attachPreviewName.textContent = file.name || 'File';
            attachPreview.classList.remove('is-hidden');
        }
    }
    function clear() {
        pendingAttachment = null;
        if (attachInput) attachInput.value = '';
        attachPreview?.classList.add('is-hidden');
        if (attachPreviewName) attachPreviewName.textContent = '';
    }

    attachPreviewRemove?.addEventListener('click', clear);
    attachInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const v = validateAttachment(file);
        if (!v.ok) { await appAlertError(v.error); if (attachInput) attachInput.value = ''; return; }
        show(file);
    });

    return { getPending: () => pendingAttachment, show, clear };
}

/* ── Message bubble footer HTML ─────────────────────────────────────── */
export function buildMessageFooterHtml({ timeText, statusIconHtml }) {
    if (!timeText && !statusIconHtml) return '';
    return `<div class="message-bubble-footer">
        ${timeText ? `<span class="message-bubble-time">${escapeHtml(timeText)}</span>` : ''}
        ${statusIconHtml || ''}
    </div>`;
}

