// Messaging UI helpers: timestamps, delivery icons, emoji picker, lightbox, skin-analysis card HTML.
import { escapeHtml, timestampToMs } from '../app/utils.js';
import { appAlertError } from '../ui/app-dialog.js';
import { downloadMessageAttachmentFile } from './attachments.js';
import { skinAnalysisSavedAtToMs } from '../../feature/skin-disease/skin-analysis-repository.js';

function formatSkinShareDateTime(ms) {
    try {
        return new Date(ms).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return '';
    }
}

// Timestamp formatting
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

// Status icon (sent/delivered/seen)
export function renderMessageStatusIcon({ msg, convData, readField, deliveredField, isLastSent }) {
    if (!isLastSent) return '';
    if ((msg.status || 'sent') === 'sending') {
        return '<span class="message-status message-status--sending" aria-label="Sending"><i class="fa fa-spinner fa-spin"></i></span>';
    }
    const msgMs = timestampToMs(msg.sentAt);
    // Pending local/server write: sentAt is often null until the snapshot resolves; comparing to 0
    // would wrongly show delivered/seen against any historical read/delivery timestamp.
    if (!msgMs) {
        return '<span class="message-status message-status--sent" aria-label="Sent"><i class="fa fa-check"></i></span>';
    }
    const lastReadMs  = timestampToMs(convData?.[readField]);
    const lastDelivMs = timestampToMs(convData?.[deliveredField]);
    // Require positive read/delivery ms; “seen” needs read after delivery so open-thread read does not hide delivered.
    const readCovers    = lastReadMs > 0 && lastReadMs >= msgMs;
    const delivCovers   = lastDelivMs > 0 && lastDelivMs >= msgMs;
    const seenAfterDeliv = readCovers && delivCovers && lastReadMs > lastDelivMs;
    if (seenAfterDeliv) {
        return '<span class="message-status message-status--seen" aria-label="Seen"><i class="fa fa-eye"></i></span>';
    }
    if (delivCovers) {
        // fa-check-double is not in FA4; messages pages load FA4 after FA6 and override .fa.
        return '<span class="message-status message-status--delivered" aria-label="Delivered"><span class="message-status-dbl" aria-hidden="true"><i class="fa fa-check"></i><i class="fa fa-check"></i></span></span>';
    }
    if (readCovers) {
        return '<span class="message-status message-status--seen" aria-label="Seen"><i class="fa fa-eye"></i></span>';
    }
    return '<span class="message-status message-status--sent" aria-label="Sent"><i class="fa fa-check"></i></span>';
}

// Emoji picker
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

// HTML block for a skin analysis shared inside a message bubble (layout matches appointment details attached skin).
export function renderSkinAnalysisShare(share) {
    if (!share || typeof share !== 'object') return '';
    const url = escapeHtml(String(share.imageUrl || ''));
    const conf = typeof share.confidence === 'number' && !Number.isNaN(share.confidence) ? share.confidence : 0;
    const confPct = Math.round(conf * 100);
    const condRaw = String(share.conditionName || '').trim();
    const condDisplay = escapeHtml(condRaw || 'Skin analysis');
    const notesRaw = String(share.notes || '').trim();
    const pet = String(share.petType || '').trim();
    const petLabel = pet === 'dog' ? 'Dog' : pet === 'cat' ? 'Cat' : pet;
    const historyMs = skinAnalysisSavedAtToMs(share);
    const historyDateTimeStr = historyMs != null ? formatSkinShareDateTime(historyMs) : '';
    const notesHtml = notesRaw
        ? `<p class="details-attached-skin-notes">${escapeHtml(notesRaw)}</p>`
        : '';
    const petHtml = petLabel
        ? `<span class="details-attached-skin-pet">${escapeHtml(petLabel)}</span>`
        : '';
    const imgBlock = url
        ? `<button type="button" class="details-attached-skin-img-btn message-skin-analysis-img-btn" data-skin-full-image-url="${url}" aria-label="View image larger"><img src="${url}" alt="" class="details-attached-skin-thumb message-skin-analysis-img" loading="lazy" width="120" height="120"></button>`
        : '';
    return `<div class="message-skin-analysis-card" role="group" aria-label="Shared skin analysis">
        <div class="message-skin-analysis-header"><i class="fa fa-stethoscope" aria-hidden="true"></i><span>Skin health analysis</span></div>
        <div class="details-attached-skin-card">
            ${imgBlock}
            <div class="details-attached-skin-body">
                <div class="details-attached-skin-match-block">
                    <span class="details-attached-skin-kicker">Suggested match</span>
                    <strong class="details-attached-skin-title">${condDisplay}</strong>
                </div>
                <span class="details-attached-skin-confidence">${confPct}% Confidence</span>
                ${historyDateTimeStr ? `<span class="details-attached-skin-saved-at">${escapeHtml(historyDateTimeStr)}</span>` : ''}
                ${petHtml}
                ${notesHtml}
            </div>
        </div>
    </div>`;
}

// After injecting message HTML, wire image/video thumbs (placeholders hide when ready).
export function wireMessageAttachmentThumbnails(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.message-skin-analysis-img').forEach((img) => {
        const wrap = img.closest('.message-skin-analysis-card');
        if (!wrap) return;
        const reveal = () => {
            wrap.classList.add('message-skin-analysis--loaded');
            img.classList.add('is-loaded');
        };
        img.addEventListener('load', reveal);
        img.addEventListener('error', reveal);
        if (img.complete) reveal();
    });
    rootEl.querySelectorAll('.message-attachment-img').forEach((img) => {
        const wrap = img.closest('.message-attachment--image');
        if (!wrap) return;
        const reveal = () => wrap.classList.add('is-loaded');
        img.addEventListener('load', reveal);
        img.addEventListener('error', reveal);
        if (img.complete) reveal();
    });
    rootEl.querySelectorAll('.message-attachment--video').forEach((wrap) => {
        const vid = wrap.querySelector('.message-attachment-video-thumb');
        if (!vid) return;
        const reveal = () => {
            try {
                vid.pause();
                vid.currentTime = 0;
            } catch (_) {}
            vid.classList.add('is-loaded');
            wrap.classList.add('is-loaded');
        };
        vid.addEventListener('loadeddata', reveal, { once: true });
        vid.addEventListener('error', () => { wrap.classList.add('is-loaded'); }, { once: true });
    });
}

// Image/video lightbox for message attachments (video does not autoplay).
export function initMessagingImageLightbox({ lightboxEl, chatBodyEl }) {
    const lb = lightboxEl;
    if (!lb || !chatBodyEl) return { close: () => {} };
    const lbImg = lb.querySelector('.messages-image-lightbox-img');
    const lbVideo = lb.querySelector('.messages-media-lightbox-video');
    const lbTab = lb.querySelector('.messages-image-lightbox-open-tab');

    const closeVideo = () => {
        if (!lbVideo) return;
        lbVideo.pause();
        lbVideo.removeAttribute('src');
        try { lbVideo.load?.(); } catch (_) {}
        lbVideo.classList.add('is-hidden');
    };

    const openImage = (src) => {
        closeVideo();
        if (!lbImg) return;
        lbImg.classList.remove('is-hidden');
        lbImg.style.opacity = '0';
        lbImg.onload = () => { requestAnimationFrame(() => { lbImg.style.opacity = '1'; }); };
        lbImg.src = src;
        lbImg.alt = 'Enlarged image';
        if (lbTab) {
            lbTab.href = src;
            lbTab.classList.remove('is-hidden');
        }
        lb.classList.remove('is-hidden');
        lb.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    };

    const openVideo = (src) => {
        if (lbImg) {
            lbImg.src = '';
            lbImg.classList.add('is-hidden');
        }
        if (lbTab) {
            lbTab.href = src;
            lbTab.classList.remove('is-hidden');
        }
        if (lbVideo) {
            lbVideo.autoplay = false;
            lbVideo.removeAttribute('autoplay');
            lbVideo.setAttribute('preload', 'none');
            lbVideo.src = src;
            lbVideo.classList.remove('is-hidden');
            try { lbVideo.load(); } catch (_) {}
            lbVideo.pause();
            lbVideo.addEventListener('loadedmetadata', () => {
                lbVideo.pause();
                try { lbVideo.currentTime = 0; } catch (_) {}
            }, { once: true });
        }
        lb.classList.remove('is-hidden');
        lb.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    };

    const close = () => {
        closeVideo();
        lb.classList.add('is-hidden');
        lb.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        setTimeout(() => {
            if (lbImg) {
                lbImg.removeAttribute('src');
                lbImg.classList.remove('is-hidden');
            }
        }, 280);
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
        const videoBtn = e.target.closest('.message-attachment-video-btn');
        if (videoBtn?.dataset?.videoUrl) {
            e.preventDefault();
            e.stopPropagation();
            openVideo(videoBtn.dataset.videoUrl);
            return;
        }
        const skinCard = e.target.closest('.message-skin-analysis-card');
        if (skinCard) {
            const img = skinCard.querySelector('.message-skin-analysis-img');
            if (img?.src) {
                e.preventDefault();
                e.stopPropagation();
                openImage(img.src);
            }
            return;
        }
        const wrap = e.target.closest('.message-attachment--image');
        if (!wrap) return;
        const img = wrap.querySelector('.message-attachment-img');
        if (!img?.src) return;
        e.preventDefault();
        openImage(img.src);
    });

    return { close, open: openImage, openVideo };
}

// Fetch Storage file URLs as blobs and save (anchor download is unreliable cross-origin); capture phase before other clicks.
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

// Attachment preview helpers
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

// Message bubble footer HTML
export function buildMessageFooterHtml({ timeText, statusIconHtml }) {
    if (!timeText && !statusIconHtml) return '';
    return `<div class="message-bubble-footer">
        ${timeText ? `<span class="message-bubble-time">${escapeHtml(timeText)}</span>` : ''}
        ${statusIconHtml || ''}
    </div>`;
}

