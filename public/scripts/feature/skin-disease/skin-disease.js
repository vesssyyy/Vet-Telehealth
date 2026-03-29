/**
 * Skin health UI: pet selection, condition scope list, upload/camera capture,
 * inference API call (steps 3-4), results display, and error handling.
 */
(function () {
    'use strict';

    var sc = document.currentScript;
    var base = (sc && sc.getAttribute('data-assets')) || '../assets/';
    if (base.slice(-1) !== '/') base += '/';

    function getApiBase() {
        var raw = (sc && sc.getAttribute('data-api-base')) || 'http://localhost:5000';
        raw = String(raw || '').trim();
        if (raw.slice(-1) === '/') raw = raw.slice(0, -1);
        return raw;
    }

    var PET_IMAGES = { cat: base + 'cat-skin-detection.png', dog: base + 'dog-skin-detection.png' };

    /* ── Condition data ── */
    function scabies(dog) {
        var p = dog ? 'Dogs' : 'Pets';
        return {
            name: 'Scabies',
            icon: 'fa-bug',
            desc: 'Mite infestation causing itch and skin changes',
            moreInfo: 'Scabies (sarcoptic mange) is caused by microscopic mites that burrow into the skin. ' + p +
                ' often show intense itching, hair loss, redness, and crusting, especially on the ears, face, and elbows. It can spread between animals and sometimes to humans. A vet can confirm with a skin scrape and prescribe antiparasitic treatment.'
        };
    }
    var flea = {
        name: 'Flea Allergy Dermatitis',
        icon: 'fa-paw',
        desc: 'Allergic reaction to flea bites',
        moreInfo: 'Flea allergy dermatitis (FAD) is an allergic reaction to flea saliva. Even one or two bites can trigger severe itching, leading to scratching, hair loss, and skin damage. Affected areas are often along the back, tail base, and hind legs. Consistent flea control and sometimes anti-itch or anti-inflammatory medication are needed.'
    };
    var ringworm = {
        name: 'Ringworm',
        icon: 'fa-circle-o',
        desc: 'Fungal infection; circular skin lesions',
        moreInfo: 'Ringworm is a fungal infection (not a worm) that causes circular, scaly, sometimes hairless patches. It is contagious to other pets and people. Lesions may appear anywhere and can be itchy. Diagnosis is by culture or UV light; treatment usually includes topical and sometimes oral antifungal medication and cleaning the environment.'
    };
    var demodicosis = {
        name: 'Demodicosis',
        icon: 'fa-eyedropper',
        desc: 'Mite-related skin disease (demodex)',
        moreInfo: 'Demodicosis is caused by Demodex mites that live in hair follicles. Localized cases often show small bald, scaly patches (especially on the face or legs); generalized cases can involve large areas and secondary infections. It is not contagious. Treatment depends on severity and may include topical or oral antiparasitics and treating any bacterial infection.'
    };
    var healthyInfo = {
        name: 'Healthy Skin',
        icon: 'fa-check-circle-o',
        desc: 'No strong match to a disease pattern was found.',
        moreInfo: 'The model classified this image as closer to healthy skin than any of the trained conditions. This is a statistical estimate from a photo only — not a clinical diagnosis. If your pet shows symptoms such as redness, itching, or hair loss, consult a veterinarian regardless of this result.'
    };

    var SCOPE = { cat: [scabies(false), flea, ringworm], dog: [scabies(true), flea, ringworm, demodicosis] };

    var LABEL_MAP = {
        Healthy: healthyInfo,
        Flea_Allergy_Dermatitis: flea,
        Ringworm: ringworm,
        Scabies: null, /* resolved by petType */
        Demodicosis: demodicosis
    };

    /* ── State ── */
    var cameraStream = null;
    var predictAbort = null;
    var lastResultObjectUrl = null;
    var $ = function (id) { return document.getElementById(id); };

    function revokeResultPreview() {
        if (lastResultObjectUrl) {
            URL.revokeObjectURL(lastResultObjectUrl);
            lastResultObjectUrl = null;
        }
        var ph = $('skin-result-photo');
        if (ph) { ph.removeAttribute('src'); ph.alt = 'Image analyzed'; }
    }

    /* ── Helpers ── */
    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function setStepperStep(activeStep) {
        document.querySelectorAll('.skin-step[data-skin-step]').forEach(function (li) {
            var n = parseInt(li.getAttribute('data-skin-step'), 10);
            li.classList.toggle('is-active', n === activeStep);
            li.classList.toggle('is-complete', n < activeStep);
            if (n === activeStep) li.setAttribute('aria-current', 'step');
            else li.removeAttribute('aria-current');
        });
    }

    function currentPetType() {
        var idv = $('skin-identify-view');
        return (idv && idv.getAttribute('data-current-pet')) || 'cat';
    }

    /* ── View switching ── */
    function hideAll() {
        ['skin-selection-view', 'skin-identify-view',
         'skin-analyzing-view', 'skin-results-view', 'skin-error-view'].forEach(function (id) {
            var el = $(id);
            if (el) el.classList.add('is-hidden');
        });
    }

    function showView(selectionVisible) {
        if (selectionVisible) revokeResultPreview();
        hideAll();
        var sel = $('skin-selection-view');
        var id = $('skin-identify-view');
        var backBtn = $('skin-back-btn');
        if (sel) sel.classList.toggle('is-hidden', !selectionVisible);
        if (id) id.classList.toggle('is-hidden', selectionVisible);
        if (backBtn) backBtn.classList.toggle('is-hidden', selectionVisible);
        setStepperStep(selectionVisible ? 1 : 2);
    }

    function showIdentifyView(petType) {
        var label = petType === 'cat' ? 'Cat' : 'Dog';
        var img = $('skin-identify-pet-img');
        if (img) { img.src = PET_IMAGES[petType] || ''; img.alt = label; }

        var title = $('skin-identify-title');
        if (title) title.textContent = label + ' Skin Health Analysis';

        var listEl = $('skin-scope-list');
        var conditions = SCOPE[petType] || SCOPE.cat;
        if (listEl) {
            listEl.innerHTML = conditions.map(function (c) {
                return '<li class="skin-scope-item">' +
                    '<span class="skin-scope-icon"><i class="fa ' + c.icon + '" aria-hidden="true"></i></span>' +
                    '<div class="skin-scope-text">' +
                    '<strong class="skin-scope-name">' + escapeHtml(c.name) + '</strong>' +
                    (c.desc ? '<span class="skin-scope-desc">' + escapeHtml(c.desc) + '</span>' : '') +
                    (c.moreInfo ? '<p class="skin-scope-more">' + escapeHtml(c.moreInfo) + '</p>' : '') +
                    '</div></li>';
            }).join('');
        }

        hideAll();
        var idv = $('skin-identify-view');
        var backBtn = $('skin-back-btn');
        if (idv) { idv.classList.remove('is-hidden'); idv.setAttribute('data-current-pet', petType); }
        if (backBtn) backBtn.classList.remove('is-hidden');
        setStepperStep(2);
    }

    function showAnalyzingView() {
        hideAll();
        var an = $('skin-analyzing-view');
        var backBtn = $('skin-back-btn');
        if (an) an.classList.remove('is-hidden');
        if (backBtn) backBtn.classList.remove('is-hidden');
        setStepperStep(3);
    }

    function showResultsView(apiLabel, confidence, petType, imageObjectUrl) {
        var info = LABEL_MAP[apiLabel];
        if (info === null) info = petType === 'dog' ? scabies(true) : scabies(false);
        if (!info) {
            info = {
                name: String(apiLabel || 'Unknown').replace(/_/g, ' '),
                desc: 'Best match among the trained classes.'
            };
        }

        var pct = (typeof confidence === 'number' && !isNaN(confidence))
            ? Math.max(0, Math.min(1, confidence)) : 0;

        var labEl = $('skin-result-label');
        var confEl = $('skin-result-confidence');
        var bar = $('skin-result-bar');
        var descEl = $('skin-result-desc');
        var photo = $('skin-result-photo');
        var wrap = $('skin-result-photo-wrap');

        if (labEl) labEl.textContent = info.name;
        if (confEl) confEl.textContent = (pct * 100).toFixed(1) + '% confidence';
        if (bar) bar.style.width = (pct * 100).toFixed(1) + '%';
        if (descEl) descEl.textContent = info.desc || '';

        if (photo && imageObjectUrl) {
            photo.src = imageObjectUrl;
            photo.alt = 'Photo used for this analysis';
        }
        if (wrap) wrap.classList.toggle('is-hidden', !imageObjectUrl);

        hideAll();
        var res = $('skin-results-view');
        var backBtn = $('skin-back-btn');
        if (res) res.classList.remove('is-hidden');
        if (backBtn) backBtn.classList.remove('is-hidden');
        setStepperStep(4);
    }

    function showErrorView(message) {
        var msgEl = $('skin-error-msg');
        if (msgEl) msgEl.textContent = message || 'Something went wrong. Please try again.';

        hideAll();
        var err = $('skin-error-view');
        var backBtn = $('skin-back-btn');
        if (err) err.classList.remove('is-hidden');
        if (backBtn) backBtn.classList.remove('is-hidden');
        setStepperStep(3);
    }

    function resetToIdentifyView() {
        if (predictAbort) { predictAbort.abort(); predictAbort = null; }
        revokeResultPreview();
        showIdentifyView(currentPetType());
    }

    /* ── API call ── */
    function handleImageFile(file) {
        if (!file || !file.type.match(/^image\//)) return;

        var petType = currentPetType();
        if (petType !== 'cat' && petType !== 'dog') petType = 'cat';

        if (predictAbort) predictAbort.abort();
        predictAbort = new AbortController();

        revokeResultPreview();
        var previewUrl = URL.createObjectURL(file);
        lastResultObjectUrl = previewUrl;

        showAnalyzingView();

        var endpoint = petType === 'cat' ? '/predict-cat' : '/predict-dog';
        var url = getApiBase() + endpoint;
        var fd = new FormData();
        fd.append('image', file, file.name || 'upload.jpg');

        fetch(url, { method: 'POST', body: fd, signal: predictAbort.signal })
            .then(function (res) {
                return res.text().then(function (text) {
                    var data = {};
                    try { if (text) data = JSON.parse(text); } catch (e) { /* ignore */ }
                    if (!res.ok) throw new Error((data && data.error) || ('Server error ' + res.status));
                    return data;
                });
            })
            .then(function (data) {
                predictAbort = null;
                if (!data || typeof data.label === 'undefined') {
                    throw new Error('Unexpected response from server.');
                }
                showResultsView(data.label, data.confidence, petType, previewUrl);
            })
            .catch(function (err) {
                predictAbort = null;
                if (err && err.name === 'AbortError') return;
                revokeResultPreview();
                var msg = err && err.message ? err.message : 'Unknown error.';
                if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) {
                    msg = 'Cannot reach the analysis server. Make sure it is running (python app.py) and that the data-api-base URL is correct.';
                }
                showErrorView(msg);
            });
    }

    /* ── Camera ── */
    function camErr(msg) {
        var el = $('skin-camera-error');
        if (el) { el.textContent = msg || 'Could not access camera.'; el.classList.remove('is-hidden'); }
    }
    function camErrHide() {
        var el = $('skin-camera-error');
        if (el) { el.textContent = ''; el.classList.add('is-hidden'); }
    }

    function closeCameraOverlay() {
        if (cameraStream) { cameraStream.getTracks().forEach(function (t) { t.stop(); }); cameraStream = null; }
        var video = $('skin-camera-video');
        if (video && video.srcObject) video.srcObject = null;
        camErrHide();
        var overlay = $('skin-camera-overlay');
        if (overlay) { overlay.classList.add('is-hidden'); overlay.setAttribute('aria-hidden', 'true'); }
    }

    function openCameraOverlay() {
        var overlay = $('skin-camera-overlay');
        var video = $('skin-camera-video');
        var captureBtn = $('skin-camera-capture');
        if (!overlay || !video) return;
        camErrHide();
        overlay.classList.remove('is-hidden');
        overlay.setAttribute('aria-hidden', 'false');
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        }).then(function (stream) {
            cameraStream = stream;
            video.srcObject = stream;
            if (captureBtn) captureBtn.disabled = false;
        }).catch(function (err) {
            var msg = 'Camera access denied or not available.';
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Please allow camera access to take a photo.';
            else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
            camErr(msg);
            if (captureBtn) captureBtn.disabled = true;
        });
    }

    function captureFromCamera() {
        var video = $('skin-camera-video');
        var canvas = $('skin-camera-canvas');
        if (!video || !canvas || !video.srcObject || video.readyState < 2) return;
        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return;
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        canvas.toBlob(function (blob) {
            if (!blob) return;
            handleImageFile(new File([blob], 'skin-scan-' + Date.now() + '.jpg', { type: 'image/jpeg' }));
            closeCameraOverlay();
        }, 'image/jpeg', 0.92);
    }

    function setupCameraOverlay() {
        var overlay = $('skin-camera-overlay');
        var closeBtn = $('skin-camera-close');
        var captureBtn = $('skin-camera-capture');
        var backdrop = overlay && overlay.querySelector('.skin-camera-backdrop');
        if (closeBtn) closeBtn.addEventListener('click', closeCameraOverlay);
        if (captureBtn) { captureBtn.addEventListener('click', captureFromCamera); captureBtn.disabled = true; }
        if (backdrop) backdrop.addEventListener('click', closeCameraOverlay);
    }

    /* ── Drop zone ── */
    function setupDropZone() {
        var zone = $('skin-drop-zone');
        if (!zone) return;
        zone.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('is-dragover'); });
        zone.addEventListener('dragleave', function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('is-dragover'); });
        zone.addEventListener('drop', function (e) {
            e.preventDefault(); e.stopPropagation(); zone.classList.remove('is-dragover');
            var files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) handleImageFile(files[0]);
        });
    }

    /* ── Back button logic ── */
    function onBackClick() {
        var inAux = ['skin-analyzing-view', 'skin-results-view', 'skin-error-view'].some(function (id) {
            var el = $(id);
            return el && !el.classList.contains('is-hidden');
        });
        if (inAux) { resetToIdentifyView(); return; }
        showView(true);
    }

    /* ── Init ── */
    function init() {
        var grid = document.querySelector('.pet-selection-grid');
        if (grid) {
            grid.addEventListener('click', function (e) {
                var card = e.target.closest('.pet-card');
                if (!card) return;
                e.preventDefault();
                var petType = card.getAttribute('data-pet-type');
                if (petType) showIdentifyView(petType);
            });
        }

        var backBtn = $('skin-back-btn');
        if (backBtn) backBtn.addEventListener('click', onBackClick);

        var scanAnother = $('skin-result-scan-another');
        if (scanAnother) scanAnother.addEventListener('click', resetToIdentifyView);

        var errRetry = $('skin-error-retry');
        if (errRetry) errRetry.addEventListener('click', resetToIdentifyView);

        var scanBtn = $('skin-scan-btn');
        if (scanBtn) {
            scanBtn.addEventListener('click', function () {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                    openCameraOverlay();
                } else {
                    var o = $('skin-camera-overlay');
                    if (o) { o.classList.remove('is-hidden'); o.setAttribute('aria-hidden', 'false'); }
                    camErr('Camera not supported in this browser.');
                }
            });
        }

        var uploadBtn = $('skin-upload-btn');
        var uploadInput = $('skin-upload-input');
        if (uploadBtn && uploadInput) uploadBtn.addEventListener('click', function () { uploadInput.click(); });
        if (uploadInput) {
            uploadInput.addEventListener('change', function () {
                if (this.files && this.files.length) handleImageFile(this.files[0]);
                this.value = '';
            });
        }

        setupCameraOverlay();
        setupDropZone();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
