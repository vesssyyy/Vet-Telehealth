/**
 * HTML for attached skin analysis in appointment details (pet owner + vet).
 * Thumbnail opens details-media-lightbox via delegated click on .details-attached-skin-img-btn.
 */
import { escapeHtml } from '../../../core/app/utils.js';
import { skinAnalysisSavedAtToMs } from '../../skin-disease/skin-analysis-repository.js';

function formatAnalysisHistoryDateTime(ms) {
    try {
        return new Date(ms).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return '';
    }
}

/**
 * Date line uses skin analysis history only (savedAt / savedAtMs on attachment or loaded from history).
 * @param {Record<string, unknown>} s
 * @returns {string}
 */
export function buildDetailsAttachedSkinAnalysisHtml(s) {
    if (!s || !s.imageUrl) return '';
    const imgUrl = escapeHtml(String(s.imageUrl));
    const condRaw = String(s.conditionName || '').trim();
    const cond = condRaw || '—';
    const conf = typeof s.confidence === 'number' && !Number.isNaN(s.confidence) ? s.confidence : 0;
    const confPct = Math.round(conf * 100);
    const notes = (s.notes && String(s.notes).trim()) || '';
    const pet = (s.petType || '').trim();
    const petLabel = pet === 'dog' ? 'Dog' : pet === 'cat' ? 'Cat' : pet;
    const historyMs = skinAnalysisSavedAtToMs(s);
    const historyDateTimeStr = historyMs != null ? formatAnalysisHistoryDateTime(historyMs) : '';

    return (
        `<div class="details-attached-skin-card">` +
        `<button type="button" class="details-attached-skin-img-btn" data-skin-full-image-url="${imgUrl}" aria-label="View image larger">` +
        `<img src="${imgUrl}" alt="" class="details-attached-skin-thumb" width="120" height="120" loading="lazy">` +
        `</button>` +
        `<div class="details-attached-skin-body">` +
        `<div class="details-attached-skin-match-block">` +
        `<span class="details-attached-skin-kicker">Suggested match</span>` +
        `<strong class="details-attached-skin-title">${escapeHtml(cond)}</strong>` +
        `</div>` +
        `<span class="details-attached-skin-confidence">${confPct}% Confidence</span>` +
        (historyDateTimeStr
            ? `<span class="details-attached-skin-saved-at">${escapeHtml(historyDateTimeStr)}</span>`
            : '') +
        (petLabel ? `<span class="details-attached-skin-pet">${escapeHtml(petLabel)}</span>` : '') +
        (notes ? `<p class="details-attached-skin-notes">${escapeHtml(notes)}</p>` : '') +
        `</div></div>`
    );
}

/** Fade in thumbnails after load (call after setting innerHTML on the skin inner container). */
export function wireDetailsAttachedSkinThumbnails(containerEl) {
    if (!containerEl) return;
    containerEl.querySelectorAll('.details-attached-skin-thumb').forEach((img) => {
        const reveal = () => img.classList.add('is-loaded');
        img.addEventListener('load', reveal);
        img.addEventListener('error', reveal);
        if (img.complete) reveal();
    });
}
