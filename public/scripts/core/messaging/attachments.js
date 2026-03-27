/**
 * Televet Health — Message attachments (images, PDF, docs)
 * Shared by messages page and video call. Max 25MB per file.
 */
import { storage } from '../firebase/firebase-config.js';
import { escapeHtml } from '../app/utils.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';

/** Max file size: 25 MB */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
const ALLOWED_DOC_EXT   = ['.pdf', '.doc', '.docx'];
const ALLOWED_DOC_MIMES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/**
 * Check if a file is allowed (image, PDF, or Word doc) and within size limit.
 * @param {File} file
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateAttachment(file) {
    if (!file || !(file instanceof File)) return { ok: false, error: 'Please select a file.' };
    if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'File must be 25MB or smaller.' };
    const name   = (file.name || '').toLowerCase();
    const mime   = file.type || '';
    const isImage = ALLOWED_IMAGE_TYPES.includes(mime) || mime.startsWith('image/');
    const isDoc   = ALLOWED_DOC_EXT.some(ext => name.endsWith(ext)) || ALLOWED_DOC_MIMES.includes(mime);
    if (!isImage && !isDoc) return { ok: false, error: 'Only images, PDF, and Word documents (.doc, .docx) are allowed.' };
    return { ok: true };
}

/**
 * @param {File} file
 * @returns {'image'|'file'}
 */
export function getAttachmentKind(file) {
    const mime = file.type || '';
    return (ALLOWED_IMAGE_TYPES.includes(mime) || mime.startsWith('image/')) ? 'image' : 'file';
}

/**
 * Upload a message attachment and return its download URL + metadata.
 * Path: message-attachments/{convId}/{timestamp}_{sanitizedName}
 * @param {File}   file
 * @param {string} convId
 * @returns {Promise<{ url: string, name: string, type: 'image'|'file' }>}
 */
export async function uploadMessageAttachment(file, convId) {
    const validation = validateAttachment(file);
    if (!validation.ok) throw new Error(validation.error);
    const safeName   = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const storageRef = ref(storage, `message-attachments/${convId}/${Date.now()}_${safeName}`);
    await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' });
    const url = await getDownloadURL(storageRef);
    return { url, name: file.name || safeName, type: getAttachmentKind(file) };
}

/** Strip characters that are invalid or risky in download filenames (Windows-safe). */
function sanitizeDownloadFilename(name) {
    return String(name || 'attachment').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'attachment';
}

/**
 * Download a file from a cross-origin URL (e.g. Firebase Storage). The HTML `download`
 * attribute is ignored for cross-origin links; this uses fetch + blob + object URL.
 * @param {string} url
 * @param {string} [filename]
 * @returns {Promise<void>}
 */
export async function downloadMessageAttachmentFile(url, filename) {
    const safeName = sanitizeDownloadFilename(filename);
    try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = safeName;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

/**
 * Render an attachment as an HTML string for a chat message bubble.
 * @param {{ url?: string, name?: string, type?: string }} attachment
 * @param {boolean} isSending  True while the message is still uploading
 * @returns {string} HTML string
 */
export function renderAttachment(attachment, isSending) {
    if (!attachment) return '';
    const { url, name, type } = attachment;
    const safeName = escapeHtml(name || 'Attachment');

    if (isSending || !url) {
        const showSendingFileName = type !== 'image';
        return `<div class="message-attachment message-attachment--sending">
            <span class="message-attachment-sending-label"><i class="fa fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(isSending ? 'Sending\u2026' : 'Uploading\u2026')}</span>
            ${showSendingFileName ? `<span class="message-attachment-sending-name">${safeName}</span>` : ''}
        </div>`;
    }

    if (type === 'image') {
        return `<div class="message-attachment message-attachment--image">
            <div class="message-attachment-img-wrap">
                <div class="message-attachment-img-placeholder" aria-hidden="true"><i class="fa fa-spinner fa-spin"></i><span>Loading\u2026</span></div>
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="message-attachment-link">
                    <img src="${escapeHtml(url)}" alt="Image" class="message-attachment-img" loading="lazy">
                </a>
            </div>
        </div>`;
    }

    const ext  = (name || '').toLowerCase().split('.').pop();
    const icon = ext === 'pdf' ? 'fa-file-pdf-o' : 'fa-file-word-o';
    const dataName = escapeHtml(name || 'Attachment');
    return `<div class="message-attachment message-attachment--file">
        <a href="${escapeHtml(url)}" class="message-attachment-file-link" data-download-name="${dataName}" aria-label="Download attachment: ${safeName}">
            <i class="fa ${icon}" aria-hidden="true"></i>
            <span>${safeName}</span>
        </a>
    </div>`;
}

