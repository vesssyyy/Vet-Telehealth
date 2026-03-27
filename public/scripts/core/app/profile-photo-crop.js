/**
 * Profile photo crop — Facebook-style circular preview and crop before saving.
 * Opens a modal with drag + zoom; returns cropped Blob on Save or null on Cancel.
 */
const CROP_SIZE = 320;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

let cropModalEl = null;
let cropImgWrap = null;
let cropImg = null;
let zoomSlider = null;
let state = { scale: 1, tx: 0, ty: 0, minScale: 1, imgW: 0, imgH: 0, dragStart: null };

function getCropModal() {
    if (cropModalEl) return cropModalEl;
    cropModalEl = document.createElement('div');
    cropModalEl.id = 'profile-photo-crop-modal';
    cropModalEl.className = 'profile-crop-overlay';
    cropModalEl.setAttribute('aria-hidden', 'true');
    cropModalEl.innerHTML = `
        <div class="profile-crop-modal">
            <div class="profile-crop-loading is-hidden" aria-hidden="true">
                <div class="profile-crop-spinner"></div>
                <p class="profile-crop-loading-text">Uploading...</p>
            </div>
            <div class="profile-crop-content">
                <h3 class="profile-crop-title">Adjust your photo</h3>
                <p class="profile-crop-hint">Drag to reposition, use the slider to zoom</p>
                <div class="profile-crop-viewport">
                    <div class="profile-crop-circle">
                        <div class="profile-crop-image-wrap" role="img" aria-label="Photo preview">
                            <img class="profile-crop-image" alt="">
                        </div>
                    </div>
                </div>
                <div class="profile-crop-zoom">
                    <span class="profile-crop-zoom-label" aria-hidden="true">−</span>
                    <input type="range" class="profile-crop-slider" min="0" max="100" value="0" aria-label="Zoom">
                    <span class="profile-crop-zoom-label" aria-hidden="true">+</span>
                </div>
                <div class="profile-crop-actions">
                    <button type="button" class="profile-crop-btn profile-crop-cancel">Cancel</button>
                    <button type="button" class="profile-crop-btn profile-crop-save"><i class="fa fa-check"></i> Save photo</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(cropModalEl);
    cropImgWrap = cropModalEl.querySelector('.profile-crop-image-wrap');
    cropImg = cropModalEl.querySelector('.profile-crop-image');
    zoomSlider = cropModalEl.querySelector('.profile-crop-slider');
    return cropModalEl;
}

function applyTransform() {
    if (!cropImgWrap) return;
    const { scale, tx, ty } = state;
    cropImgWrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function pointerPosition(e) {
    const touch = e.touches?.[0] || e.changedTouches?.[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : { x: e.clientX, y: e.clientY };
}

function setupDrag() {
    const viewport = cropModalEl?.querySelector('.profile-crop-viewport');
    if (!viewport) return;

    const onStart = (e) => {
        e.preventDefault();
        state.dragStart = { x: pointerPosition(e).x - state.tx, y: pointerPosition(e).y - state.ty };
    };
    const onMove = (e) => {
        if (!state.dragStart) return;
        e.preventDefault();
        const p = pointerPosition(e);
        state.tx = p.x - state.dragStart.x;
        state.ty = p.y - state.dragStart.y;
        applyTransform();
    };
    const onEnd = () => {
        state.dragStart = null;
    };

    viewport.addEventListener('mousedown', onStart);
    viewport.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchend', onEnd);

    cropModalEl._cropCleanup = () => {
        viewport.removeEventListener('mousedown', onStart);
        viewport.removeEventListener('touchstart', onStart);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchend', onEnd);
    };
}

function setupZoom() {
    if (!zoomSlider) return;
    zoomSlider.oninput = () => {
        const t = Number(zoomSlider.value) / 100;
        state.scale = state.minScale * (MIN_ZOOM + t * (MAX_ZOOM - MIN_ZOOM));
        applyTransform();
    };
}

function initState(natW, natH) {
    const scaleCover = Math.max(CROP_SIZE / natW, CROP_SIZE / natH);
    state.minScale = scaleCover;
    state.scale = scaleCover;
    state.tx = (CROP_SIZE - natW * scaleCover) / 2;
    state.ty = (CROP_SIZE - natH * scaleCover) / 2;
    state.imgW = natW;
    state.imgH = natH;
    state.dragStart = null;
    if (cropImgWrap) {
        cropImgWrap.style.width = natW + 'px';
        cropImgWrap.style.height = natH + 'px';
    }
    zoomSlider.min = 0;
    zoomSlider.max = 100;
    zoomSlider.value = 20;
    applyTransform();
}

function getCroppedBlob() {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = CROP_SIZE;
        canvas.height = CROP_SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            resolve(null);
            return;
        }
        ctx.beginPath();
        ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.translate(state.tx, state.ty);
        ctx.scale(state.scale, state.scale);
        ctx.drawImage(cropImg, 0, 0);
        canvas.toBlob(
            (blob) => resolve(blob),
            'image/png',
            0.92
        );
    });
}

function showCropLoading(modal, show) {
    const loading = modal.querySelector('.profile-crop-loading');
    const content = modal.querySelector('.profile-crop-content');
    const saveBtn = modal.querySelector('.profile-crop-save');
    const cancelBtn = modal.querySelector('.profile-crop-cancel');
    if (loading) {
        loading.classList.toggle('is-hidden', !show);
        loading.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
    if (content) content.classList.toggle('is-hidden', show);
    if (saveBtn) saveBtn.disabled = show;
    if (cancelBtn) cancelBtn.disabled = show;
}

/**
 * Open the crop modal for the given image file.
 * @param {File} file - Image file from input
 * @param {{ onSave?: (file: File) => Promise<void> }} [options] - If onSave is provided, Save will show loading and await it before closing; blob is converted to File and passed.
 * @returns {Promise<Blob|null>} Cropped image blob on Save (when no onSave), null on Cancel or when onSave was used
 */
export function openProfilePhotoCrop(file, options = {}) {
    if (!file || !file.type.startsWith('image/')) return Promise.resolve(null);

    const modal = getCropModal();
    const url = URL.createObjectURL(file);
    const { onSave } = options;

    return new Promise((resolve) => {
        const finish = (blob) => {
            showCropLoading(modal, false);
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', onKeydown);
            modal.setAttribute('aria-hidden', 'true');
            if (modal._cropCleanup) {
                modal._cropCleanup();
                modal._cropCleanup = null;
            }
            resolve(blob);
        };

        const onSaveClick = async () => {
            const blob = await getCroppedBlob();
            if (!blob) return;
            if (onSave) {
                showCropLoading(modal, true);
                const uploadFile = new File([blob], 'profile.png', { type: blob.type });
                try {
                    await onSave(uploadFile);
                    finish(null);
                } catch (_) {
                    showCropLoading(modal, false);
                }
                return;
            }
            finish(blob);
        };
        const onCancel = () => finish(null);

        const onKeydown = (e) => {
            if (e.key === 'Escape') onCancel();
        };

        modal.querySelector('.profile-crop-save').onclick = onSaveClick;
        modal.querySelector('.profile-crop-cancel').onclick = onCancel;
        modal.onclick = (e) => { if (e.target === modal) onCancel(); };
        modal.querySelector('.profile-crop-modal').onclick = (e) => e.stopPropagation();
        document.addEventListener('keydown', onKeydown);

        cropImg.onload = () => {
            initState(cropImg.naturalWidth, cropImg.naturalHeight);
            setupZoom();
            setupDrag();
        };
        cropImg.onerror = () => finish(null);
        cropImg.src = url;

        modal.setAttribute('aria-hidden', 'false');
    });
}
