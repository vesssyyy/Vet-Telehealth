/**
 * Skin Health page: full-page identify view with back button and 3-way input
 * (drag & drop, Scan with camera, Upload from device).
 */
(function () {
    'use strict';

    var SELECTION_VIEW_ID = 'skin-selection-view';
    var IDENTIFY_VIEW_ID = 'skin-identify-view';
    var PET_IMG_ID = 'skin-identify-pet-img';
    var TITLE_ID = 'skin-identify-title';
    var SUBTITLE_ID = 'skin-identify-subtitle';
    var SCOPE_LIST_ID = 'skin-scope-list';
    var BACK_BTN_ID = 'skin-back-btn';
    var DROP_ZONE_ID = 'skin-drop-zone';
    var UPLOAD_INPUT_ID = 'skin-upload-input';
    var SCAN_BTN_ID = 'skin-scan-btn';
    var UPLOAD_BTN_ID = 'skin-upload-btn';
    var CAMERA_OVERLAY_ID = 'skin-camera-overlay';
    var CAMERA_VIDEO_ID = 'skin-camera-video';
    var CAMERA_CANVAS_ID = 'skin-camera-canvas';
    var CAMERA_ERROR_ID = 'skin-camera-error';
    var CAMERA_CLOSE_ID = 'skin-camera-close';
    var CAMERA_CAPTURE_ID = 'skin-camera-capture';

    var cameraStream = null;

    var PET_IMAGES = {
        cat: '../assets/cat-skin-detection.png',
        dog: '../assets/dog-skin-detection.png'
    };

    var SCOPE = {
        cat: [
            {
                name: 'Scabies',
                icon: 'fa-bug',
                desc: 'Mite infestation causing itch and skin changes',
                moreInfo: 'Scabies (sarcoptic mange) is caused by microscopic mites that burrow into the skin. Pets often show intense itching, hair loss, redness, and crusting, especially on the ears, face, and elbows. It can spread between animals and sometimes to humans. A vet can confirm with a skin scrape and prescribe antiparasitic treatment.'
            },
            {
                name: 'Flea Allergy Dermatitis',
                icon: 'fa-paw',
                desc: 'Allergic reaction to flea bites',
                moreInfo: 'Flea allergy dermatitis (FAD) is an allergic reaction to flea saliva. Even one or two bites can trigger severe itching, leading to scratching, hair loss, and skin damage. Affected areas are often along the back, tail base, and hind legs. Consistent flea control and sometimes anti-itch or anti-inflammatory medication are needed.'
            },
            {
                name: 'Ringworm',
                icon: 'fa-circle-o',
                desc: 'Fungal infection; circular skin lesions',
                moreInfo: 'Ringworm is a fungal infection (not a worm) that causes circular, scaly, sometimes hairless patches. It is contagious to other pets and people. Lesions may appear anywhere and can be itchy. Diagnosis is by culture or UV light; treatment usually includes topical and sometimes oral antifungal medication and cleaning the environment.'
            }
        ],
        dog: [
            {
                name: 'Scabies',
                icon: 'fa-bug',
                desc: 'Mite infestation causing itch and skin changes',
                moreInfo: 'Scabies (sarcoptic mange) is caused by microscopic mites that burrow into the skin. Dogs often show intense itching, hair loss, redness, and crusting, especially on the ears, face, and elbows. It can spread between animals and sometimes to humans. A vet can confirm with a skin scrape and prescribe antiparasitic treatment.'
            },
            {
                name: 'Flea Allergy Dermatitis',
                icon: 'fa-paw',
                desc: 'Allergic reaction to flea bites',
                moreInfo: 'Flea allergy dermatitis (FAD) is an allergic reaction to flea saliva. Even one or two bites can trigger severe itching, leading to scratching, hair loss, and skin damage. Affected areas are often along the back, tail base, and hind legs. Consistent flea control and sometimes anti-itch or anti-inflammatory medication are needed.'
            },
            {
                name: 'Ringworm',
                icon: 'fa-circle-o',
                desc: 'Fungal infection; circular skin lesions',
                moreInfo: 'Ringworm is a fungal infection (not a worm) that causes circular, scaly, sometimes hairless patches. It is contagious to other pets and people. Lesions may appear anywhere and can be itchy. Diagnosis is by culture or UV light; treatment usually includes topical and sometimes oral antifungal medication and cleaning the environment.'
            },
            {
                name: 'Demodicosis',
                icon: 'fa-eyedropper',
                desc: 'Mite-related skin disease (demodex)',
                moreInfo: 'Demodicosis is caused by Demodex mites that live in hair follicles. Localized cases often show small bald, scaly patches (especially on the face or legs); generalized cases can involve large areas and secondary infections. It is not contagious. Treatment depends on severity and may include topical or oral antiparasitics and treating any bacterial infection.'
            }
        ]
    };

    function getSelectionView() { return document.getElementById(SELECTION_VIEW_ID); }
    function getIdentifyView() { return document.getElementById(IDENTIFY_VIEW_ID); }

    function showView(selectionVisible) {
        var sel = getSelectionView();
        var id = getIdentifyView();
        if (sel) sel.classList.toggle('is-hidden', !selectionVisible);
        if (id) id.classList.toggle('is-hidden', selectionVisible);
    }

    function showIdentifyView(petType) {
        var img = document.getElementById(PET_IMG_ID);
        var title = document.getElementById(TITLE_ID);
        var subtitle = document.getElementById(SUBTITLE_ID);
        var listEl = document.getElementById(SCOPE_LIST_ID);

        var label = petType === 'cat' ? 'Cat' : 'Dog';
        var imgPath = PET_IMAGES[petType];
        if (imgPath && img) {
            img.src = imgPath;
            img.alt = label;
        }
        if (title) title.textContent = label + ' skin detection';
        if (subtitle) subtitle.textContent = 'We can help identify these conditions';

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

        showView(false);
        getIdentifyView().setAttribute('data-current-pet', petType);
    }

    function showSelectionView() {
        showView(true);
    }

    function escapeHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    function handleImageFile(file) {
        if (!file || !file.type.match(/^image\//)) return;
        console.log('Image for scan:', file.name);
        // Placeholder for future upload/scan API
    }

    function showCameraError(msg) {
        var el = document.getElementById(CAMERA_ERROR_ID);
        if (el) {
            el.textContent = msg || 'Could not access camera.';
            el.classList.remove('is-hidden');
        }
    }

    function hideCameraError() {
        var el = document.getElementById(CAMERA_ERROR_ID);
        if (el) {
            el.textContent = '';
            el.classList.add('is-hidden');
        }
    }

    function closeCameraOverlay() {
        var overlay = document.getElementById(CAMERA_OVERLAY_ID);
        var video = document.getElementById(CAMERA_VIDEO_ID);
        if (cameraStream) {
            cameraStream.getTracks().forEach(function (track) { track.stop(); });
            cameraStream = null;
        }
        if (video && video.srcObject) {
            video.srcObject = null;
        }
        hideCameraError();
        if (overlay) {
            overlay.classList.add('is-hidden');
            overlay.setAttribute('aria-hidden', 'true');
        }
    }

    function openCameraOverlay() {
        var overlay = document.getElementById(CAMERA_OVERLAY_ID);
        var video = document.getElementById(CAMERA_VIDEO_ID);
        var captureBtn = document.getElementById(CAMERA_CAPTURE_ID);
        if (!overlay || !video) return;

        hideCameraError();
        overlay.classList.remove('is-hidden');
        overlay.setAttribute('aria-hidden', 'false');

        var constraints = {
            video: {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };

        navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
            cameraStream = stream;
            video.srcObject = stream;
            if (captureBtn) captureBtn.disabled = false;
        }).catch(function (err) {
            var msg = 'Camera access denied or not available.';
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                msg = 'Please allow camera access to take a photo.';
            } else if (err.name === 'NotFoundError') {
                msg = 'No camera found on this device.';
            }
            showCameraError(msg);
            if (captureBtn) captureBtn.disabled = true;
        });
    }

    function captureFromCamera() {
        var video = document.getElementById(CAMERA_VIDEO_ID);
        var canvas = document.getElementById(CAMERA_CANVAS_ID);
        if (!video || !canvas || !video.srcObject || video.readyState < 2) return;

        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return;

        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);

        canvas.toBlob(function (blob) {
            if (!blob) return;
            var file = new File([blob], 'skin-scan-' + Date.now() + '.jpg', { type: 'image/jpeg' });
            handleImageFile(file);
            closeCameraOverlay();
        }, 'image/jpeg', 0.92);
    }

    function setupCameraOverlay() {
        var overlay = document.getElementById(CAMERA_OVERLAY_ID);
        var closeBtn = document.getElementById(CAMERA_CLOSE_ID);
        var captureBtn = document.getElementById(CAMERA_CAPTURE_ID);
        var backdrop = overlay && overlay.querySelector('.skin-camera-backdrop');

        if (closeBtn) closeBtn.addEventListener('click', closeCameraOverlay);
        if (captureBtn) {
            captureBtn.addEventListener('click', captureFromCamera);
            captureBtn.disabled = true;
        }
        if (backdrop) backdrop.addEventListener('click', closeCameraOverlay);
    }

    function setupDropZone() {
        var zone = document.getElementById(DROP_ZONE_ID);
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
        var backBtn = document.getElementById(BACK_BTN_ID);
        var scanBtn = document.getElementById(SCAN_BTN_ID);
        var uploadBtn = document.getElementById(UPLOAD_BTN_ID);
        var uploadInput = document.getElementById(UPLOAD_INPUT_ID);

        if (grid) {
            grid.addEventListener('click', function (e) {
                var card = e.target.closest('.pet-card');
                if (!card) return;
                e.preventDefault();
                var petType = card.getAttribute('data-pet-type');
                if (petType) showIdentifyView(petType);
            });
        }

        if (backBtn) backBtn.addEventListener('click', showSelectionView);

        if (scanBtn) {
            scanBtn.addEventListener('click', function () {
                if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
                    openCameraOverlay();
                } else {
                    var overlay = document.getElementById(CAMERA_OVERLAY_ID);
                    if (overlay) {
                        overlay.classList.remove('is-hidden');
                        overlay.setAttribute('aria-hidden', 'false');
                    }
                    showCameraError('Camera not supported in this browser.');
                }
            });
        }
        if (uploadBtn && uploadInput) {
            uploadBtn.addEventListener('click', function () { uploadInput.click(); });
        }

        if (uploadInput) {
            uploadInput.addEventListener('change', function () {
                if (this.files && this.files.length) handleImageFile(this.files[0]);
                this.value = '';
            });
        }

        setupCameraOverlay();
        setupDropZone();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
