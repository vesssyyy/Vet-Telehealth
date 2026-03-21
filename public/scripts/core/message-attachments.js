/**
 * Televet Health — Message attachments (images, PDF, docs)
 * Shared by pet owner and vet messaging. Max 25MB per file.
 */
import { storage } from './firebase-config.js';
import { escapeHtml } from './utils.js';
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
        return `<div class="message-attachment message-attachment--sending">
            <span class="message-attachment-sending-label"><i class="fa fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(isSending ? 'Sending\u2026' : 'Uploading\u2026')}</span>
            <span class="message-attachment-sending-name">${safeName}</span>
        </div>`;
    }

    if (type === 'image') {
        return `<div class="message-attachment message-attachment--image">
            <div class="message-attachment-img-wrap">
                <div class="message-attachment-img-placeholder" aria-hidden="true"><i class="fa fa-spinner fa-spin"></i><span>Loading\u2026</span></div>
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="message-attachment-link">
                    <img src="${escapeHtml(url)}" alt="${safeName}" class="message-attachment-img" loading="lazy">
                </a>
            </div>
            <div class="message-bubble-time message-attachment-time">${safeName}</div>
        </div>`;
    }

    const ext  = (name || '').toLowerCase().split('.').pop();
    const icon = ext === 'pdf' ? 'fa-file-pdf-o' : 'fa-file-word-o';
    return `<div class="message-attachment message-attachment--file">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="message-attachment-file-link">
            <i class="fa ${icon}" aria-hidden="true"></i>
            <span>${safeName}</span>
        </a>
    </div>`;
}
