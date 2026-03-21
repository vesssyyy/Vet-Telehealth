/**
 * Skin health UI: pet selection, condition list, drag/drop + camera + file upload (placeholder handler).
 */
(function () {
    'use strict';

    var sc = document.currentScript;
    var base = (sc && sc.getAttribute('data-assets')) || '../assets/';
    if (base.slice(-1) !== '/') base += '/';

    var PET_IMAGES = { cat: base + 'cat-skin-detection.png', dog: base + 'dog-skin-detection.png' };

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

    var SCOPE = { cat: [scabies(false), flea, ringworm], dog: [scabies(true), flea, ringworm, demodicosis] };

    var cameraStream = null;
    var $ = function (id) { return document.getElementById(id); };

    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function showView(selectionVisible) {
        var sel = $('skin-selection-view');
        var id = $('skin-identify-view');
        if (sel) sel.classList.toggle('is-hidden', !selectionVisible);
        if (id) id.classList.toggle('is-hidden', selectionVisible);
    }

    function showIdentifyView(petType) {
        var label = petType === 'cat' ? 'Cat' : 'Dog';
        var path = PET_IMAGES[petType];
        var img = $('skin-identify-pet-img');
        if (path && img) {
            img.src = path;
            img.alt = label;
        }
        var title = $('skin-identify-title');
        var subtitle = $('skin-identify-subtitle');
        if (title) title.textContent = label + ' skin detection';
        if (subtitle) subtitle.textContent = 'We can help identify these conditions';

        var listEl = $('skin-scope-list');
        var conditions = SCOPE[petType] || SCOPE.cat;
        if (listEl) {
            listEl.innerHTML = conditions.map(function (c) {
                return '<li class="skin-scope-item"><span class="skin-scope-icon"><i class="fa ' + c.icon + '" aria-hidden="true"></i></span><div class="skin-scope-text"><strong class="skin-scope-name">' +
                    escapeHtml(c.name) + '</strong>' +
                    (c.desc ? '<span class="skin-scope-desc">' + escapeHtml(c.desc) + '</span>' : '') +
                    (c.moreInfo ? '<p class="skin-scope-more">' + escapeHtml(c.moreInfo) + '</p>' : '') +
                    '</div></li>';
            }).join('');
        }
        showView(false);
        $('skin-identify-view').setAttribute('data-current-pet', petType);
    }

    function handleImageFile(file) {
        if (!file || !file.type.match(/^image\//)) return;
        console.log('Image for scan:', file.name);
    }

    function camErr(msg) {
        var el = $('skin-camera-error');
        if (el) {
            el.textContent = msg || 'Could not access camera.';
            el.classList.remove('is-hidden');
        }
    }
    function camErrHide() {
        var el = $('skin-camera-error');
        if (el) {
            el.textContent = '';
            el.classList.add('is-hidden');
        }
    }

    function closeCameraOverlay() {
        var overlay = $('skin-camera-overlay');
        var video = $('skin-camera-video');
        if (cameraStream) {
            cameraStream.getTracks().forEach(function (t) { t.stop(); });
            cameraStream = null;
        }
        if (video && video.srcObject) video.srcObject = null;
        camErrHide();
        if (overlay) {
            overlay.classList.add('is-hidden');
            overlay.setAttribute('aria-hidden', 'true');
        }
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
        if (captureBtn) {
            captureBtn.addEventListener('click', captureFromCamera);
            captureBtn.disabled = true;
        }
        if (backdrop) backdrop.addEventListener('click', closeCameraOverlay);
    }

    function setupDropZone() {
        var zone = $('skin-drop-zone');
        if (!zone) return;
        zone.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.add('is-dragover');
        });
        zone.addEventListener('dragleave', function (e) {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('is-dragover');
        });
        zone.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('is-dragover');
            var files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) handleImageFile(files[0]);
        });
    }

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
        if (backBtn) backBtn.addEventListener('click', function () { showView(true); });

        var scanBtn = $('skin-scan-btn');
        if (scanBtn) {
            scanBtn.addEventListener('click', function () {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                    openCameraOverlay();
                } else {
                    var o = $('skin-camera-overlay');
                    if (o) {
                        o.classList.remove('is-hidden');
                        o.setAttribute('aria-hidden', 'false');
                    }
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
