import { escapeHtml } from '../../../core/app/utils.js';

export function buildSharedMediaMarkup(mediaUrls = []) {
    return mediaUrls.map((url, index) => {
        const ext = (url || '').split('.').pop()?.toLowerCase();
        const isImage = /^(jpg|jpeg|png|gif|webp|bmp)$/.test(ext || '');
        if (isImage) {
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-thumb"><img src="${escapeHtml(url)}" alt="Shared image ${index + 1}" loading="lazy"></a>`;
        }
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-file"><i class="fa fa-file-o"></i> File ${index + 1}</a>`;
    }).join('');
}

