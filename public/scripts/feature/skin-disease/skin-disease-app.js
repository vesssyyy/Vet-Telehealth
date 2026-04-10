// Skin health UI + saved analyses (Firestore/Storage): inference, manual save, history.
import { auth } from '../../core/firebase/firebase-config.js';
import { appConfirm } from '../../core/ui/app-dialog.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    uploadSkinAnalysisImage,
    saveSkinAnalysisRecord,
    subscribeSkinAnalyses,
    deleteSkinAnalysisRecord,
    savedAtToMs,
} from './skin-analysis-repository.js';

const $ = (id) => document.getElementById(id);

/**
 * Setting aria-hidden on an overlay while focus stays inside triggers a browser a11y warning
 * (and confuses screen readers). Move focus to a control outside `overlay` first.
 * @param {HTMLElement | null} overlay
 * @param {...(string | HTMLElement | null | undefined)} fallbackIdsOrEls - getElementById ids or elements
 */
function moveFocusOutOfSkinOverlay(overlay, ...fallbackIdsOrEls) {
    if (!overlay || typeof overlay.contains !== 'function') return;
    if (!overlay.contains(document.activeElement)) return;
    for (const item of fallbackIdsOrEls) {
        if (!item) continue;
        const el = typeof item === 'string' ? $(item) : item;
        if (!el || overlay.contains(el) || typeof el.focus !== 'function') continue;
        if ('disabled' in el && el.disabled) continue;
        try {
            el.focus({ preventScroll: true });
        } catch {
            try {
                el.focus();
            } catch {
                continue;
            }
        }
        if (!overlay.contains(document.activeElement)) return;
    }
    const hadTabIndex = document.body.getAttribute('tabindex');
    document.body.setAttribute('tabindex', '-1');
    try {
        document.body.focus({ preventScroll: true });
    } catch {
        // ignore
    }
    if (hadTabIndex === null) document.body.removeAttribute('tabindex');
}

const DEFAULT_SKIN_PAGE_HEADING = 'Skin Health Analysis';

function setSkinPageHeading(text) {
    const el = $('skin-page-heading');
    if (el) el.textContent = text || DEFAULT_SKIN_PAGE_HEADING;
}

/**
 * Selection: title bar + subtitle + History.
 * Identify (after species pick): title bar hidden — heading lives in the species banner card.
 */
function updateSkinPageChrome() {
    const sel = $('skin-selection-view');
    const idv = $('skin-identify-view');
    const btn = $('skin-history-open-btn');
    const sub = $('skin-detection-heading');
    const titleBar = document.querySelector('.skin-page-title-bar');

    const onSelection = sel && !sel.classList.contains('is-hidden');
    const onIdentify = idv && !idv.classList.contains('is-hidden');

    if (sub) sub.classList.toggle('is-hidden', !onSelection);
    if (titleBar) titleBar.classList.toggle('is-hidden', onIdentify);

    if (!onSelection && $('skin-history-list-overlay')?.classList.contains('is-open')) {
        closeHistoryListModal();
    }
    if (btn) {
        btn.classList.toggle('is-hidden', !onSelection);
        if (!onSelection) btn.setAttribute('aria-expanded', 'false');
    }
}

function getPageConfig() {
    const el = document.querySelector('.skin-content-wrapper');
    let base = (el && el.dataset.skinAssets) || '../../assets/';
    if (base.slice(-1) !== '/') base += '/';
    const fallbackApi = (el && el.dataset.skinApiFallback) || 'http://localhost:5000';
    return { assetsBase: base, apiFallback: String(fallbackApi).replace(/\/$/, '') };
}

function getApiBase() {
    let winBase = typeof window !== 'undefined' && window.TELEHEALTH_SKIN_API_BASE;
    winBase = String(winBase || '').trim();
    if (winBase) {
        if (winBase.slice(-1) === '/') winBase = winBase.slice(0, -1);
        return winBase;
    }
    return getPageConfig().apiFallback;
}

function scabies(dog) {
    const p = dog ? 'Dogs' : 'Pets';
    return {
        name: 'Scabies',
        icon: 'fa-bug',
        desc: 'Mite infestation causing itch and skin changes',
        moreInfo:
            'Scabies (sarcoptic mange) is caused by microscopic mites that burrow into the skin. ' +
            p +
            ' often show intense itching, hair loss, redness, and crusting, especially on the ears, face, and elbows. It can spread between animals and sometimes to humans. A vet can confirm with a skin scrape and prescribe antiparasitic treatment.',
    };
}
const flea = {
    name: 'Flea Allergy Dermatitis',
    icon: 'fa-paw',
    desc: 'Allergic reaction to flea bites',
    moreInfo:
        'Flea allergy dermatitis (FAD) is an allergic reaction to flea saliva. Even one or two bites can trigger severe itching, leading to scratching, hair loss, and skin damage. Affected areas are often along the back, tail base, and hind legs. Consistent flea control and sometimes anti-itch or anti-inflammatory medication are needed.',
};
const ringworm = {
    name: 'Ringworm',
    icon: 'fa-circle-o',
    desc: 'Fungal infection; circular skin lesions',
    moreInfo:
        'Ringworm is a fungal infection (not a worm) that causes circular, scaly, sometimes hairless patches. It is contagious to other pets and people. Lesions may appear anywhere and can be itchy. Diagnosis is by culture or UV light; treatment usually includes topical and sometimes oral antifungal medication and cleaning the environment.',
};
const demodicosis = {
    name: 'Demodicosis',
    icon: 'fa-eyedropper',
    desc: 'Mite-related skin disease (demodex)',
    moreInfo:
        'Demodicosis is caused by Demodex mites that live in hair follicles. Localized cases often show small bald, scaly patches (especially on the face or legs); generalized cases can involve large areas and secondary infections. It is not contagious. Treatment depends on severity and may include topical or oral antiparasitics and treating any bacterial infection.',
};
const healthyInfo = {
    name: 'Healthy Skin',
    icon: 'fa-check-circle-o',
    desc: 'No strong match to a disease pattern was found.',
    moreInfo:
        'The model classified this image as closer to healthy skin than any of the trained conditions. This is a statistical estimate from a photo only — not a clinical diagnosis. If your pet shows symptoms such as redness, itching, or hair loss, consult a veterinarian regardless of this result.',
};

const SCOPE = { cat: [scabies(false), flea, ringworm], dog: [scabies(true), flea, ringworm, demodicosis] };

const LABEL_MAP = {
    Healthy: healthyInfo,
    Flea_Allergy_Dermatitis: flea,
    Ringworm: ringworm,
    Scabies: null,
    Demodicosis: demodicosis,
};

let cameraStream = null;
let predictAbort = null;
let lastResultObjectUrl = null;
/** @type {Blob|null} */
let lastAnalysisBlob = null;
let currentApiLabel = '';
let currentConfidence = 0;
let currentPetType = 'cat';
let currentConditionName = '';
let currentResultSaved = false;
let historyUnsub = null;
// Latest full list from Firestore (before species filter).
let historyItemsAll = [];
/** @type {'all'|'cat'|'dog'} */
let historyPetFilter = 'all';
// Row shown in history detail modal (for delete).
let historyDetailOpenRecord = null;

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

/** @param {string} [raw] */
function trimSavedName(raw) {
    const s = (raw != null ? String(raw) : '').trim();
    if (!s) return '';
    return s.slice(0, 120);
}

function setBackBtnVisible(visible) {
    const backBtn = $('skin-back-btn');
    if (!backBtn) return;
    backBtn.classList.toggle('is-hidden', !visible);
    if (visible) {
        backBtn.setAttribute('aria-hidden', 'false');
        backBtn.removeAttribute('tabindex');
    } else {
        backBtn.setAttribute('aria-hidden', 'true');
        backBtn.setAttribute('tabindex', '-1');
    }
}

function revokeResultPreview() {
    if (lastResultObjectUrl) {
        URL.revokeObjectURL(lastResultObjectUrl);
        lastResultObjectUrl = null;
    }
    const ph = $('skin-result-photo');
    if (ph) {
        ph.removeAttribute('src');
        ph.alt = 'Image analyzed';
    }
}

function setStepperStep(activeStep) {
    document.querySelectorAll('.skin-step[data-skin-step]').forEach((li) => {
        const n = parseInt(li.getAttribute('data-skin-step'), 10);
        li.classList.toggle('is-active', n === activeStep);
        li.classList.toggle('is-complete', n < activeStep);
        if (n === activeStep) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
    });
}

function currentPetTypeFromDom() {
    const idv = $('skin-identify-view');
    return (idv && idv.getAttribute('data-current-pet')) || 'cat';
}

function hideAll() {
    ['skin-selection-view', 'skin-identify-view', 'skin-analyzing-view', 'skin-results-view', 'skin-error-view'].forEach((id) => {
        const el = $(id);
        if (el) el.classList.add('is-hidden');
    });
}

function showView(selectionVisible) {
    if (selectionVisible) {
        revokeResultPreview();
        lastAnalysisBlob = null;
    }
    hideAll();
    const sel = $('skin-selection-view');
    const id = $('skin-identify-view');
    if (sel) sel.classList.toggle('is-hidden', !selectionVisible);
    if (id) id.classList.toggle('is-hidden', selectionVisible);
    setBackBtnVisible(!selectionVisible);
    setStepperStep(selectionVisible ? 1 : 2);
    if (selectionVisible) {
        setSkinPageHeading(DEFAULT_SKIN_PAGE_HEADING);
        closeSaveNameModal();
    }
    updateSkinPageChrome();
}

function showIdentifyView(petType) {
    const { assetsBase } = getPageConfig();
    const PET_IMAGES = { cat: `${assetsBase}cat-skin-detection.png`, dog: `${assetsBase}dog-skin-detection.png` };
    const label = petType === 'cat' ? 'Cat' : 'Dog';
    const img = $('skin-identify-pet-img');
    if (img) {
        img.src = PET_IMAGES[petType] || '';
        img.alt = label;
    }
    setSkinPageHeading(`${label} Skin Health Analysis`);
    const speciesTitle = $('skin-identify-species-title');
    if (speciesTitle) speciesTitle.textContent = `${label} Skin Health Analysis`;
    const listEl = $('skin-scope-list');
    const conditions = SCOPE[petType] || SCOPE.cat;
    if (listEl) {
        listEl.innerHTML = conditions
            .map(
                (c) =>
                    `<li class="skin-scope-item">` +
                    `<span class="skin-scope-icon"><i class="fa ${c.icon}" aria-hidden="true"></i></span>` +
                    `<div class="skin-scope-text">` +
                    `<strong class="skin-scope-name">${escapeHtml(c.name)}</strong>` +
                    (c.desc ? `<span class="skin-scope-desc">${escapeHtml(c.desc)}</span>` : '') +
                    (c.moreInfo ? `<p class="skin-scope-more">${escapeHtml(c.moreInfo)}</p>` : '') +
                    `</div></li>`
            )
            .join('');
    }
    hideAll();
    const idv = $('skin-identify-view');
    if (idv) {
        idv.classList.remove('is-hidden');
        idv.setAttribute('data-current-pet', petType);
    }
    setBackBtnVisible(true);
    setStepperStep(2);
    updateSkinPageChrome();
}

function showAnalyzingView() {
    closeSaveNameModal();
    hideAll();
    const an = $('skin-analyzing-view');
    if (an) an.classList.remove('is-hidden');
    setBackBtnVisible(true);
    setStepperStep(3);
    {
        const pt = currentPetTypeFromDom();
        const lbl = pt === 'dog' ? 'Dog' : 'Cat';
        setSkinPageHeading(`${lbl} Skin Health Analysis`);
    }
    updateSkinPageChrome();
}

function updateSavePanelState() {
    const banner = $('skin-save-status');
    const saveBtn = $('skin-save-btn');
    const scanAnother = $('skin-result-scan-another');
    const resultsView = $('skin-results-view');
    const visible = resultsView && !resultsView.classList.contains('is-hidden');

    if (banner) {
        banner.classList.toggle('is-hidden', !visible || !currentResultSaved);
    }
    if (saveBtn) {
        saveBtn.disabled = !visible || currentResultSaved || !lastAnalysisBlob;
        saveBtn.classList.toggle('is-hidden', currentResultSaved);
    }
    if (scanAnother) {
        scanAnother.disabled = false;
    }
}

function showResultsView(apiLabel, confidence, petType, imageObjectUrl) {
    let info = LABEL_MAP[apiLabel];
    if (info === null) info = petType === 'dog' ? scabies(true) : scabies(false);
    if (!info) {
        info = {
            name: String(apiLabel || 'Unknown').replace(/_/g, ' '),
            desc: 'Best match among the trained classes.',
        };
    }
    const pct = typeof confidence === 'number' && !Number.isNaN(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;

    currentApiLabel = apiLabel;
    currentConfidence = pct;
    currentPetType = petType;
    currentConditionName = info.name;
    currentResultSaved = false;
    closeSaveNameModal();

    const labEl = $('skin-result-label');
    const confEl = $('skin-result-confidence');
    const bar = $('skin-result-bar');
    const descEl = $('skin-result-desc');
    const photo = $('skin-result-photo');
    const wrap = $('skin-result-photo-wrap');

    if (labEl) labEl.textContent = info.name;
    if (confEl) confEl.textContent = `${(pct * 100).toFixed(1)}% confidence`;
    if (bar) bar.style.width = `${(pct * 100).toFixed(1)}%`;
    if (descEl) descEl.textContent = info.desc || '';

    if (photo && imageObjectUrl) {
        photo.src = imageObjectUrl;
        photo.alt = 'Photo used for this analysis';
    }
    if (wrap) wrap.classList.toggle('is-hidden', !imageObjectUrl);

    hideAll();
    const res = $('skin-results-view');
    if (res) res.classList.remove('is-hidden');
    setBackBtnVisible(true);
    setStepperStep(4);
    {
        const lbl = petType === 'dog' ? 'Dog' : 'Cat';
        setSkinPageHeading(`${lbl} Skin Health Analysis`);
    }
    updateSavePanelState();
    updateSkinPageChrome();
}

function showErrorView(message) {
    const msgEl = $('skin-error-msg');
    if (msgEl) msgEl.textContent = message || 'Something went wrong. Please try again.';
    hideAll();
    const err = $('skin-error-view');
    if (err) err.classList.remove('is-hidden');
    setBackBtnVisible(true);
    setStepperStep(3);
    {
        const pt = currentPetTypeFromDom();
        const lbl = pt === 'dog' ? 'Dog' : 'Cat';
        setSkinPageHeading(`${lbl} Skin Health Analysis`);
    }
    updateSkinPageChrome();
}

function resetToIdentifyView() {
    closeSaveNameModal();
    if (predictAbort) {
        predictAbort.abort();
        predictAbort = null;
    }
    lastAnalysisBlob = null;
    currentResultSaved = false;
    revokeResultPreview();
    updateSavePanelState();
    showIdentifyView(currentPetTypeFromDom());
}

function showSkinToast(message) {
    const el = $('skin-app-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('is-hidden');
    el.setAttribute('aria-hidden', 'false');
    clearTimeout(showSkinToast._t);
    showSkinToast._t = setTimeout(() => {
        el.classList.add('is-hidden');
        el.setAttribute('aria-hidden', 'true');
    }, 3200);
}

function closeSaveNameModal() {
    const ov = $('skin-save-name-overlay');
    const input = $('skin-save-name-input');
    const confirmBtn = $('skin-save-name-confirm');
    if (!ov) {
        if (input) input.value = '';
        return;
    }
    if (!ov.classList.contains('is-open')) {
        if (input) input.value = '';
        return;
    }
    moveFocusOutOfSkinOverlay(ov, 'skin-save-btn', 'skin-result-scan-another', 'skin-back-btn');
    ov.classList.remove('is-open');
    ov.setAttribute('aria-hidden', 'true');
    if (input) input.value = '';
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.removeAttribute('aria-busy');
    }
    syncBodyScrollLock();
}

function openSaveNameModal() {
    const user = auth.currentUser;
    if (!user) {
        showSkinToast('Sign in to save analyses.');
        return;
    }
    if (!lastAnalysisBlob || currentResultSaved) return;
    const ov = $('skin-save-name-overlay');
    const input = $('skin-save-name-input');
    if (!ov || !input) return;
    input.value = '';
    ov.classList.add('is-open');
    ov.setAttribute('aria-hidden', 'false');
    syncBodyScrollLock();
    requestAnimationFrame(() => input.focus());
}

async function confirmSaveAnalysisWithName() {
    const user = auth.currentUser;
    if (!user || !lastAnalysisBlob || currentResultSaved) return;
    const savedName = trimSavedName($('skin-save-name-input')?.value);
    if (!savedName) {
        showSkinToast('Enter a name to save.');
        $('skin-save-name-input')?.focus();
        return;
    }
    const confirmBtn = $('skin-save-name-confirm');
    const saveBtn = $('skin-save-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.setAttribute('aria-busy', 'true');
    }
    if (saveBtn) saveBtn.setAttribute('aria-busy', 'true');
    try {
        const { imageUrl, imageStoragePath } = await uploadSkinAnalysisImage(user.uid, lastAnalysisBlob, lastAnalysisBlob.type || 'image/jpeg');
        await saveSkinAnalysisRecord(user.uid, {
            imageUrl,
            imageStoragePath,
            apiLabel: currentApiLabel,
            conditionName: currentConditionName,
            confidence: currentConfidence,
            petType: currentPetType,
            savedName,
        });
        currentResultSaved = true;
        closeSaveNameModal();
        updateSavePanelState();
        showSkinToast('Analysis saved.');
    } catch (err) {
        console.error('Save skin analysis:', err);
        showSkinToast(err?.message || 'Could not save. Try again.');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.removeAttribute('aria-busy');
        }
        if (saveBtn) saveBtn.removeAttribute('aria-busy');
        updateSavePanelState();
    }
}

function formatHistoryDate(ms) {
    if (!ms) return '—';
    try {
        return new Date(ms).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return '—';
    }
}

function applyHistoryPetFilter(items) {
    if (historyPetFilter === 'all') return items;
    return items.filter((row) => String(row.petType || '').toLowerCase() === historyPetFilter);
}

function syncHistoryFilterButtons() {
    document.querySelectorAll('[data-skin-history-filter]').forEach((btn) => {
        const v = btn.getAttribute('data-skin-history-filter');
        const on = v === historyPetFilter;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function refreshHistoryListView() {
    renderHistoryList(applyHistoryPetFilter(historyItemsAll));
}

async function confirmAndDeleteSkinAnalysis(record) {
    const user = auth.currentUser;
    if (!user || !record?.id) return;
    if (!(await appConfirm('Delete this saved analysis? This cannot be undone.', { confirmText: 'Yes', cancelText: 'No' }))) return;
    const delBtn = $('skin-history-detail-delete');
    if (delBtn) {
        delBtn.disabled = true;
        delBtn.setAttribute('aria-busy', 'true');
    }
    try {
        await deleteSkinAnalysisRecord(user.uid, record);
        showSkinToast('Analysis deleted.');
        if (historyDetailOpenRecord?.id === record.id) closeHistoryDetail();
    } catch (err) {
        console.error('Delete skin analysis:', err);
        showSkinToast(err?.message || 'Could not delete. Try again.');
    } finally {
        if (delBtn) {
            delBtn.disabled = false;
            delBtn.removeAttribute('aria-busy');
        }
    }
}

function renderHistoryList(items) {
    const list = $('skin-history-modal-list');
    const empty = $('skin-history-modal-empty');
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '';
        if (empty) {
            empty.classList.remove('is-hidden');
            empty.textContent =
                historyItemsAll.length === 0
                    ? 'No saved analyses yet.'
                    : 'No analyses match this filter.';
        }
        return;
    }
    if (empty) {
        empty.classList.add('is-hidden');
        if (historyItemsAll.length === 0) empty.textContent = 'No saved analyses yet.';
    }
    list.innerHTML = items
        .map((row) => {
            const ms = savedAtToMs(row.savedAt);
            const conf = typeof row.confidence === 'number' ? row.confidence : 0;
            const thumb = row.imageUrl ? escapeHtml(String(row.imageUrl)) : '';
            const savedName = (row.savedName && String(row.savedName).trim()) || '';
            const cond = String(row.conditionName || '—');
            const titleEsc = escapeHtml(savedName || cond);
            const pct = (conf * 100).toFixed(1);
            const matchLine = `${escapeHtml(cond)} : ${pct}% Confidence`;
            const idEsc = escapeHtml(row.id);
            return (
                `<li class="skin-history-card" data-skin-history-id="${idEsc}">` +
                `<button type="button" class="skin-history-card-inner" aria-label="View analysis details">` +
                `<div class="skin-history-card-thumb-wrap">` +
                (thumb
                    ? `<img class="skin-history-card-thumb" src="${thumb}" alt="" loading="lazy" width="80" height="80">`
                    : `<div class="skin-history-card-thumb skin-history-card-thumb--empty" aria-hidden="true"><i class="fa fa-image"></i></div>`) +
                `</div>` +
                `<div class="skin-history-card-body">` +
                `<span class="skin-history-card-title">${titleEsc}</span>` +
                `<span class="skin-history-card-match-line">${matchLine}</span>` +
                `<span class="skin-history-card-date">${escapeHtml(formatHistoryDate(ms))}</span>` +
                `</div></button>` +
                `<button type="button" class="skin-history-card-delete" data-skin-history-id="${idEsc}" aria-label="Delete saved analysis"><i class="fa fa-trash-o" aria-hidden="true"></i></button>` +
                `</li>`
            );
        })
        .join('');

    list.querySelectorAll('.skin-history-card-inner').forEach((inner) => {
        const card = inner.closest('.skin-history-card');
        const id = card?.getAttribute('data-skin-history-id');
        const open = () => {
            const found = historyItemsAll.find((x) => x.id === id);
            if (found) openHistoryDetail(found);
        };
        inner.addEventListener('click', open);
        inner.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });
    });

    list.querySelectorAll('.skin-history-card-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-skin-history-id');
            const found = historyItemsAll.find((x) => x.id === id);
            if (found) confirmAndDeleteSkinAnalysis(found);
        });
    });
}

function openHistoryDetail(row) {
    historyDetailOpenRecord = row;
    const overlay = $('skin-history-detail-overlay');
    const img = $('skin-history-detail-img');
    const title = $('skin-history-detail-title');
    const condRow = $('skin-history-detail-condition');
    const confEl = $('skin-history-detail-confidence');
    const dateEl = $('skin-history-detail-date');
    const notesEl = $('skin-history-detail-notes');
    if (!overlay) return;
    const ms = savedAtToMs(row.savedAt);
    const conf = typeof row.confidence === 'number' ? row.confidence : 0;
    const savedName = (row.savedName && String(row.savedName).trim()) || '';
    const condName = row.conditionName || '—';
    if (img) {
        if (row.imageUrl) {
            img.src = row.imageUrl;
            img.classList.remove('is-hidden');
        } else {
            img.removeAttribute('src');
            img.classList.add('is-hidden');
        }
    }
    if (title) title.textContent = savedName || condName;
    if (condRow) {
        if (savedName) {
            condRow.textContent = `Suggested match: ${condName}`;
            condRow.classList.remove('is-hidden');
        } else {
            condRow.textContent = '';
            condRow.classList.add('is-hidden');
        }
    }
    if (confEl) confEl.textContent = `${(conf * 100).toFixed(1)}% confidence`;
    if (dateEl) dateEl.textContent = formatHistoryDate(ms);
    if (notesEl) {
        const n = (row.notes && String(row.notes).trim()) || '';
        if (n) {
            notesEl.textContent = n;
            notesEl.classList.remove('is-hidden', 'skin-history-detail-notes--empty');
        } else {
            notesEl.textContent = '';
            notesEl.classList.add('is-hidden', 'skin-history-detail-notes--empty');
        }
    }
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    syncBodyScrollLock();
}

function closeHistoryDetail() {
    historyDetailOpenRecord = null;
    const overlay = $('skin-history-detail-overlay');
    if (!overlay) return;
    const listOpen = $('skin-history-list-overlay')?.classList.contains('is-open');
    moveFocusOutOfSkinOverlay(
        overlay,
        listOpen ? 'skin-history-list-close' : null,
        'skin-history-open-btn',
        'skin-back-btn',
        'skin-upload-btn'
    );
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    syncBodyScrollLock();
}

function syncBodyScrollLock() {
    const listOpen = $('skin-history-list-overlay')?.classList.contains('is-open');
    const detailOpen = $('skin-history-detail-overlay')?.classList.contains('is-open');
    const saveNameOpen = $('skin-save-name-overlay')?.classList.contains('is-open');
    document.body.style.overflow = listOpen || detailOpen || saveNameOpen ? 'hidden' : '';
}

function openHistoryListModal() {
    const ov = $('skin-history-list-overlay');
    const btn = $('skin-history-open-btn');
    if (!ov) return;
    ov.classList.add('is-open');
    ov.setAttribute('aria-hidden', 'false');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    syncBodyScrollLock();
}

function closeHistoryListModal() {
    const ov = $('skin-history-list-overlay');
    const btn = $('skin-history-open-btn');
    if (!ov) return;
    moveFocusOutOfSkinOverlay(ov, 'skin-history-list-close', 'skin-history-open-btn', 'skin-back-btn', 'skin-upload-btn');
    ov.classList.remove('is-open');
    ov.setAttribute('aria-hidden', 'true');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    syncBodyScrollLock();
}

function startHistorySubscription(uid) {
    if (historyUnsub) {
        historyUnsub();
        historyUnsub = null;
    }
    historyUnsub = subscribeSkinAnalyses(uid, (items) => {
        historyItemsAll = items;
        refreshHistoryListView();
    });
}

function handleImageFile(file) {
    if (!file || !file.type.match(/^image\//)) return;
    let petType = currentPetTypeFromDom();
    if (petType !== 'cat' && petType !== 'dog') petType = 'cat';

    lastAnalysisBlob = file;

    if (predictAbort) predictAbort.abort();
    predictAbort = new AbortController();

    revokeResultPreview();
    const previewUrl = URL.createObjectURL(file);
    lastResultObjectUrl = previewUrl;

    showAnalyzingView();

    const endpoint = petType === 'cat' ? '/predict-cat' : '/predict-dog';
    const url = `${getApiBase()}${endpoint}`;
    const fd = new FormData();
    fd.append('image', file, file.name || 'upload.jpg');

    fetch(url, { method: 'POST', body: fd, signal: predictAbort.signal })
        .then((res) =>
            res.text().then((text) => {
                let data = {};
                try {
                    if (text) data = JSON.parse(text);
                } catch {
                    // ignore
                }
                if (!res.ok) throw new Error((data && data.error) || `Server error ${res.status}`);
                return data;
            })
        )
        .then((data) => {
            predictAbort = null;
            if (!data || typeof data.label === 'undefined') throw new Error('Unexpected response from server.');
            showResultsView(data.label, data.confidence, petType, previewUrl);
        })
        .catch((err) => {
            predictAbort = null;
            if (err && err.name === 'AbortError') return;
            lastAnalysisBlob = null;
            revokeResultPreview();
            let msg = err && err.message ? err.message : 'Unknown error.';
            if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) {
                msg =
                    'Cannot reach the analysis server. Make sure it is running (python app.py) and that TELEHEALTH_SKIN_API_BASE / fallback URL is correct.';
            }
            showErrorView(msg);
        });
}

function camErr(msg) {
    const el = $('skin-camera-error');
    if (el) {
        el.textContent = msg || 'Could not access camera.';
        el.classList.remove('is-hidden');
    }
}
function camErrHide() {
    const el = $('skin-camera-error');
    if (el) {
        el.textContent = '';
        el.classList.add('is-hidden');
    }
}

function closeCameraOverlay() {
    if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
    }
    const video = $('skin-camera-video');
    if (video && video.srcObject) video.srcObject = null;
    camErrHide();
    const overlay = $('skin-camera-overlay');
    if (overlay) {
        moveFocusOutOfSkinOverlay(overlay, 'skin-camera-close', 'skin-camera-capture', 'skin-scan-btn', 'skin-upload-btn', 'skin-back-btn');
        overlay.classList.add('is-hidden');
        overlay.setAttribute('aria-hidden', 'true');
    }
}

function openCameraOverlay() {
    const overlay = $('skin-camera-overlay');
    const video = $('skin-camera-video');
    const captureBtn = $('skin-camera-capture');
    if (!overlay || !video) return;
    camErrHide();
    overlay.classList.remove('is-hidden');
    overlay.setAttribute('aria-hidden', 'false');
    navigator.mediaDevices
        .getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
        })
        .then((stream) => {
            cameraStream = stream;
            video.srcObject = stream;
            if (captureBtn) captureBtn.disabled = false;
        })
        .catch((err) => {
            let msg = 'Camera access denied or not available.';
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Please allow camera access to take a photo.';
            else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
            camErr(msg);
            if (captureBtn) captureBtn.disabled = true;
        });
}

function captureFromCamera() {
    const video = $('skin-camera-video');
    const canvas = $('skin-camera-canvas');
    if (!video || !canvas || !video.srcObject || video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    canvas.toBlob(
        (blob) => {
            if (!blob) return;
            handleImageFile(new File([blob], `skin-scan-${Date.now()}.jpg`, { type: 'image/jpeg' }));
            closeCameraOverlay();
        },
        'image/jpeg',
        0.92
    );
}

function setupCameraOverlay() {
    const overlay = $('skin-camera-overlay');
    const closeBtn = $('skin-camera-close');
    const captureBtn = $('skin-camera-capture');
    const backdrop = overlay && overlay.querySelector('.skin-camera-backdrop');
    if (closeBtn) closeBtn.addEventListener('click', closeCameraOverlay);
    if (captureBtn) {
        captureBtn.addEventListener('click', captureFromCamera);
        captureBtn.disabled = true;
    }
    if (backdrop) backdrop.addEventListener('click', closeCameraOverlay);
}

function setupDropZone() {
    const zone = $('skin-drop-zone');
    if (!zone) return;
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('is-dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) handleImageFile(files[0]);
    });
}

function onBackClick() {
    const inAux = ['skin-analyzing-view', 'skin-results-view', 'skin-error-view'].some((id) => {
        const el = $(id);
        return el && !el.classList.contains('is-hidden');
    });
    if (inAux) {
        resetToIdentifyView();
        return;
    }
    showView(true);
}

function init() {
    const grid = document.querySelector('.pet-selection-grid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const card = e.target.closest('.pet-card');
            if (!card) return;
            e.preventDefault();
            const petType = card.getAttribute('data-pet-type');
            if (petType) showIdentifyView(petType);
        });
    }

    $('skin-back-btn')?.addEventListener('click', onBackClick);

    const scanAnother = $('skin-result-scan-another');
    if (scanAnother) scanAnother.addEventListener('click', resetToIdentifyView);

    $('skin-error-retry')?.addEventListener('click', resetToIdentifyView);

    const saveBtn = $('skin-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => openSaveNameModal());

    $('skin-history-detail-close')?.addEventListener('click', closeHistoryDetail);
    $('skin-history-detail-delete')?.addEventListener('click', () => {
        if (historyDetailOpenRecord) confirmAndDeleteSkinAnalysis(historyDetailOpenRecord);
    });
    $('skin-history-detail-overlay')?.addEventListener('click', (e) => {
        if (e.target === $('skin-history-detail-overlay')) closeHistoryDetail();
    });

    $('skin-history-open-btn')?.addEventListener('click', () => openHistoryListModal());
    $('skin-history-filter')?.addEventListener('click', (e) => {
        const filterBtn = e.target.closest('[data-skin-history-filter]');
        if (!filterBtn) return;
        const v = filterBtn.getAttribute('data-skin-history-filter');
        if (v !== 'all' && v !== 'cat' && v !== 'dog') return;
        historyPetFilter = v;
        syncHistoryFilterButtons();
        refreshHistoryListView();
    });
    $('skin-history-list-close')?.addEventListener('click', () => closeHistoryListModal());
    $('skin-history-list-overlay')?.addEventListener('click', (e) => {
        if (e.target === $('skin-history-list-overlay')) closeHistoryListModal();
    });

    $('skin-save-name-cancel')?.addEventListener('click', () => closeSaveNameModal());
    $('skin-save-name-overlay')?.addEventListener('click', (e) => {
        if (e.target === $('skin-save-name-overlay')) closeSaveNameModal();
    });
    $('skin-save-name-confirm')?.addEventListener('click', () => confirmSaveAnalysisWithName());
    $('skin-save-name-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmSaveAnalysisWithName();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const detail = $('skin-history-detail-overlay');
        if (detail?.classList.contains('is-open')) {
            closeHistoryDetail();
            return;
        }
        const listOv = $('skin-history-list-overlay');
        if (listOv?.classList.contains('is-open')) {
            closeHistoryListModal();
            return;
        }
        const saveOv = $('skin-save-name-overlay');
        if (saveOv?.classList.contains('is-open')) closeSaveNameModal();
    });

    const scanBtn = $('skin-scan-btn');
    if (scanBtn) {
        scanBtn.addEventListener('click', () => {
            if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                openCameraOverlay();
            } else {
                const o = $('skin-camera-overlay');
                if (o) {
                    o.classList.remove('is-hidden');
                    o.setAttribute('aria-hidden', 'false');
                }
                camErr('Camera not supported in this browser.');
            }
        });
    }

    const uploadBtn = $('skin-upload-btn');
    const uploadInput = $('skin-upload-input');
    if (uploadBtn && uploadInput) uploadBtn.addEventListener('click', () => uploadInput.click());
    if (uploadInput) {
        uploadInput.addEventListener('change', function () {
            if (this.files && this.files.length) handleImageFile(this.files[0]);
            this.value = '';
        });
    }

    setupCameraOverlay();
    setupDropZone();
    updateSavePanelState();
    updateSkinPageChrome();

    onAuthStateChanged(auth, (user) => {
        if (user) startHistorySubscription(user.uid);
        else {
            if (historyUnsub) {
                historyUnsub();
                historyUnsub = null;
            }
            historyItemsAll = [];
            historyPetFilter = 'all';
            syncHistoryFilterButtons();
            renderHistoryList([]);
        }
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
