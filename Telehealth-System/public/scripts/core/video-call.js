/**
 * Televet Health — Video call room (WebRTC + Firestore signaling)
 * Shared by petowner/video-call.html and vet/video-call.html
 */
import { auth, db } from './firebase-config.js';
import { escapeHtml, formatMessageTimeWithDate, formatAppointmentDividerDateTime, timestampToMs } from './utils.js';
import { renderAttachment, uploadMessageAttachment, validateAttachment } from './message-attachments.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    collection,
    addDoc,
    query,
    where,
    orderBy,
    onSnapshot,
    serverTimestamp,
    deleteField,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const STUN_URL = 'stun:stun.l.google.com:19302';

const $ = id => document.getElementById(id);

const getAppointmentId = () => new URLSearchParams(window.location.search).get('appointmentId') || '';

export function initVideoCallPage(options = {}) {
    const {
        backUrl = '../petowner/appointment.html',
        backLabel = 'Back to Appointments',
        loginUrl = '../index.html',
        onMessageClick = null,
    } = options;

    const appointmentId = getAppointmentId();
    const statusEl = $('call-status');
    const waitingEl = $('waiting-message');
    const connectedEl = $('connected-message');

    const container    = $('video-call-container');
    const convoPanel   = $('video-call-convo-panel');
    const messageBtn   = $('message-btn');

    function setConvoPanel(open) {
        convoPanel?.classList.toggle('is-hidden', !open);
        container?.classList.toggle('convo-open', open);
    }
    const openConvoPanel   = () => setConvoPanel(true);
    const closeConvoPanel  = () => setConvoPanel(false);
    const toggleConvoPanel = () => setConvoPanel(convoPanel?.classList.contains('is-hidden'));

    messageBtn?.addEventListener('click', () => {
        if (typeof onMessageClick === 'function') onMessageClick();
        else toggleConvoPanel();
    });
    $('convo-panel-close')?.addEventListener('click', closeConvoPanel);

    /* Mobile: Details panel (Pet + Basic info + Concern + Shared files + Remote participant) */
    const detailsPanel = $('video-call-details-panel');
    const participantBtn = $('participant-btn');
    function setDetailsPanel(open) {
        if (detailsPanel) {
            detailsPanel.classList.toggle('is-hidden', !open);
            detailsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
    }
    participantBtn?.addEventListener('click', () => {
        setDetailsPanel(true);
        showDetailsPetDefaultView();
    });
    $('details-panel-close')?.addEventListener('click', () => setDetailsPanel(false));

    /* Mobile Details panel: Concern / Shared Images (same behavior as sidebar) */
    const detailsPetDefaultView = $('details-pet-default-view');
    const detailsPetDetailView = $('details-pet-detail-view');
    const detailsPetDetailConcern = $('details-pet-detail-concern');
    const detailsPetDetailSharedImages = $('details-pet-detail-shared-images');
    function showDetailsPetDetailView(view) {
        detailsPetDefaultView?.classList.add('is-hidden');
        if (detailsPetDetailView) {
            detailsPetDetailView.classList.remove('is-hidden');
            detailsPetDetailView.setAttribute('aria-hidden', 'false');
        }
        detailsPetDetailConcern?.classList.toggle('is-hidden', view !== 'concern');
        detailsPetDetailSharedImages?.classList.toggle('is-hidden', view !== 'shared-images');
    }
    function showDetailsPetDefaultView() {
        detailsPetDefaultView?.classList.remove('is-hidden');
        if (detailsPetDetailView) {
            detailsPetDetailView.classList.add('is-hidden');
            detailsPetDetailView.setAttribute('aria-hidden', 'true');
        }
    }
    $('details-concern-btn')?.addEventListener('click', () => showDetailsPetDetailView('concern'));
    $('details-shared-images-btn')?.addEventListener('click', () => showDetailsPetDetailView('shared-images'));
    $('details-pet-detail-back')?.addEventListener('click', showDetailsPetDefaultView);

    /* Pet sidebar: Concern / Shared Images detail view and back button */
    const petDefaultView        = $('pet-default-view');
    const petDetailView         = $('pet-detail-view');
    const petDetailConcern      = $('pet-detail-concern');
    const petDetailSharedImages = $('pet-detail-shared-images');

    function showPetDetailView(view) {
        petDefaultView?.classList.add('is-hidden');
        if (petDetailView) {
            petDetailView.classList.remove('is-hidden');
            petDetailView.setAttribute('aria-hidden', 'false');
        }
        petDetailConcern?.classList.toggle('is-hidden', view !== 'concern');
        petDetailSharedImages?.classList.toggle('is-hidden', view !== 'shared-images');
    }

    function showPetDefaultView() {
        petDefaultView?.classList.remove('is-hidden');
        if (petDetailView) {
            petDetailView.classList.add('is-hidden');
            petDetailView.setAttribute('aria-hidden', 'true');
        }
    }

    $('concern-btn')?.addEventListener('click', () => showPetDetailView('concern'));
    $('shared-images-btn')?.addEventListener('click', () => showPetDetailView('shared-images'));
    $('pet-detail-back')?.addEventListener('click', showPetDefaultView);

    /* Attachment and emoji in convo panel (like messages page) */
    const convoAttachPreview = $('video-call-convo-attach-preview');
    const convoAttachName    = $('video-call-convo-attach-name');
    const convoAttachInput   = $('video-call-convo-attach-input');
    const convoAttachBtn     = $('video-call-convo-attach-btn');
    const convoEmojiBtn      = $('video-call-convo-emoji-btn');
    const convoInput         = $('video-call-convo-input');
    let convoPendingFile     = null;

    function clearConvoAttach() {
        convoPendingFile = null;
        convoAttachPreview?.classList.add('is-hidden');
        if (convoAttachName) convoAttachName.textContent = '';
        if (convoAttachInput) convoAttachInput.value = '';
    }

    function resizeConvoInput() {
        if (!convoInput) return;
        convoInput.style.height = 'auto';
        const lh = parseFloat(getComputedStyle(convoInput).lineHeight) || convoInput.scrollHeight;
        convoInput.style.height = Math.min(Math.max(convoInput.scrollHeight, lh), lh * 5) + 'px';
    }

    if (convoAttachBtn && convoAttachInput) {
        convoAttachBtn.addEventListener('click', () => convoAttachInput.click());
        convoAttachInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            convoPendingFile = file;
            convoAttachPreview?.classList.remove('is-hidden');
            if (convoAttachName) convoAttachName.textContent = file.name;
        });
    }
    $('video-call-convo-attach-remove')?.addEventListener('click', clearConvoAttach);

    const CONVO_EMOJI_LIST = ['😀','😊','😁','😂','🤣','😃','😄','😅','😉','😍','😘','🥰','🙂','🤗','😋','😜','😎','🤔','😐','😏','🙄','😌','😔','😴','😷','🤒','🤢','🤧','😵','😤','😡','👍','👎','👏','🙌','🙏','✌️','🤞','👌','❤️','🧡','💛','💚','💙','💜','🖤','💕','💖','💪','🐾','🐕','🐈','🦴','⭐','🔥','✨','💯'];
    let convoEmojiPickerEl = null;
    function getOrCreateConvoEmojiPicker() {
        if (convoEmojiPickerEl) return convoEmojiPickerEl;
        convoEmojiPickerEl = document.createElement('div');
        convoEmojiPickerEl.id = 'video-call-emoji-picker';
        convoEmojiPickerEl.className = 'video-call-emoji-picker';
        convoEmojiPickerEl.setAttribute('role', 'listbox');
        convoEmojiPickerEl.setAttribute('aria-label', 'Choose emoji');
        CONVO_EMOJI_LIST.forEach((emoji) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'video-call-emoji-picker-item';
            btn.textContent = emoji;
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-label', `Insert ${emoji}`);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                insertConvoEmojiAtCursor(emoji);
                closeConvoEmojiPicker();
            });
            convoEmojiPickerEl.appendChild(btn);
        });
        document.body.appendChild(convoEmojiPickerEl);
        document.addEventListener('click', (e) => {
            if (convoEmojiPickerEl?.classList.contains('is-open') && !convoEmojiPickerEl.contains(e.target) && e.target !== convoEmojiBtn) {
                closeConvoEmojiPicker();
            }
        });
        return convoEmojiPickerEl;
    }
    function insertConvoEmojiAtCursor(emoji) {
        if (!convoInput) return;
        const start  = convoInput.selectionStart ?? convoInput.value.length;
        const end    = convoInput.selectionEnd   ?? convoInput.value.length;
        const newVal = convoInput.value.slice(0, start) + emoji + convoInput.value.slice(end);
        if (newVal.length > (convoInput.getAttribute('maxlength') || 2000)) return;
        convoInput.value = newVal;
        const newPos = start + emoji.length;
        convoInput.setSelectionRange(newPos, newPos);
        convoInput.focus();
    }
    function closeConvoEmojiPicker() {
        if (convoEmojiPickerEl) convoEmojiPickerEl.classList.remove('is-open');
        if (convoEmojiBtn) convoEmojiBtn.setAttribute('aria-expanded', 'false');
    }
    function positionConvoEmojiPicker() {
        const wrap = convoInput?.closest('.video-call-convo-compose');
        if (!wrap || !convoEmojiPickerEl) return;
        const br     = wrap.getBoundingClientRect();
        const margin = 8;
        const maxH   = 200;
        let left  = Math.max(margin, br.left);
        const maxW = Math.min(280, window.innerWidth - margin * 2);
        let width = Math.min(br.width, maxW, window.innerWidth - left - margin);
        if (left + width > window.innerWidth - margin) width = window.innerWidth - left - margin;
        left = Math.min(left, window.innerWidth - width - margin);
        const bottom = Math.min(window.innerHeight - br.top + margin, window.innerHeight - maxH - margin);
        Object.assign(convoEmojiPickerEl.style, { left: `${left}px`, width: `${Math.max(width, 200)}px`, bottom: `${bottom}px`, top: '', right: '' });
    }
    if (convoEmojiBtn) {
        convoEmojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const picker = getOrCreateConvoEmojiPicker();
            const isOpen = picker.classList.toggle('is-open');
            convoEmojiBtn.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) positionConvoEmojiPicker();
        });
    }

    if (convoInput) {
        convoInput.addEventListener('input', resizeConvoInput);
        convoInput.addEventListener('paste', () => setTimeout(resizeConvoInput, 0));
    }

    const setStatus = text => { if (statusEl) statusEl.textContent = text; };
    function showError(msg) {
        setStatus(msg);
        waitingEl?.classList.add('is-hidden');
        connectedEl?.classList.add('is-hidden');
    }

    if (!appointmentId) {
        showError('Missing appointment. Please open the call from your appointment details.');
        return;
    }

    setStatus('Connecting…');

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = loginUrl;
            return;
        }

        const videoCallRef = doc(db, 'appointments', appointmentId, 'videoCall', 'room');
        const signalingRef = collection(db, 'appointments', appointmentId, 'signaling');
        const appointmentRef = doc(db, 'appointments', appointmentId);

        const localVideo = $('local-video');
        const remoteVideo = $('remote-video');
        const hangUpBtn = $('hangup-btn');
        const callDurationEl = $('call-duration');
        const localVideoLabelEl = $('local-video-label');
        const otherParticipantLabelEl = $('other-participant-label');
        const convoMessagesList = $('convo-messages-list');
        const convoBody = $('video-call-convo-body');
        const consultationTitleEl = $('consultation-title');
        const consultationDatetimeEl = $('consultation-datetime');
        const convoSendBtn = $('video-call-convo-send');

        let isVet = false;
        let isPetOwner = false;
        let currentConvId = null;
        let messagesUnsubscribe = null;
        let appointmentData = null;

        try {
            const aptSnap = await getDoc(appointmentRef);
            if (!aptSnap.exists()) {
                showError('Appointment not found.');
                return;
            }
            appointmentData = aptSnap.data();
            const { vetId, ownerId } = appointmentData;
            if (user.uid !== vetId && user.uid !== ownerId) {
                showError('You do not have access to this consultation.');
                return;
            }
            isVet = user.uid === vetId;
            isPetOwner = user.uid === ownerId;

            // Update placeholders: pet image, pet name, and other participant (vet or pet owner) in sidebar pet card
            const petName = appointmentData.petName || 'Pet';
            const petLabelEl = document.getElementById('pet-name-label');
            if (petLabelEl) petLabelEl.textContent = petName;
            const detailsPetNameEl = $('details-pet-name');
            if (detailsPetNameEl) detailsPetNameEl.textContent = petName;

            const petImgEl = document.getElementById('pet-placeholder-img');
            const petImageWrap = document.querySelector('.sidebar-card-image--pet');
            const petId = appointmentData.petId;
            if (petId && ownerId) {
                try {
                    const petSnap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
                    const petData = petSnap.exists() ? petSnap.data() : {};
                    if (petImgEl && petData.imageUrl) {
                        petImgEl.src = petData.imageUrl;
                        petImgEl.alt = petName;
                        if (petImageWrap) petImageWrap.classList.add('has-pet-image');
                    }
                    // Basic information in sidebar and details panel
                    const setBasicInfo = (id, value) => {
                        const el = document.getElementById(id);
                        if (el) el.textContent = value != null && value !== '' ? String(value) : '—';
                    };
                    setBasicInfo('pet-years-old', petData.age);
                    setBasicInfo('pet-weight', petData.weight != null ? `${petData.weight} kg` : null);
                    setBasicInfo('pet-species', petData.species);
                    setBasicInfo('pet-breed', petData.breed);
                    const detailsPetImg = $('details-pet-img');
                    const detailsPetFallback = $('details-pet-fallback');
                    const detailsPetAvatar = detailsPetImg?.closest('.details-pet-avatar');
                    if (detailsPetImg && petData.imageUrl) {
                        detailsPetImg.src = petData.imageUrl;
                        detailsPetImg.alt = petName;
                        detailsPetImg.removeAttribute('aria-hidden');
                        if (detailsPetFallback) detailsPetFallback.setAttribute('aria-hidden', 'true');
                        if (detailsPetAvatar) detailsPetAvatar.classList.add('has-avatar');
                    }
                    setBasicInfo('details-pet-age', petData.age);
                    setBasicInfo('details-pet-weight', petData.weight != null ? `${petData.weight} kg` : null);
                    setBasicInfo('details-pet-species', petData.species);
                    setBasicInfo('details-pet-breed', petData.breed);
                } catch (e) {
                    console.warn('Could not load pet data', e);
                }
            }

            const concernText = (appointmentData.reason && String(appointmentData.reason).trim()) || '';
            const concernPlaceholder = document.querySelector('#pet-detail-concern .sidebar-pet-detail-placeholder');
            if (concernPlaceholder) {
                concernPlaceholder.textContent = concernText || 'No concern provided.';
            }
            const detailsConcernEl = $('details-concern-text');
            if (detailsConcernEl) detailsConcernEl.textContent = concernText || 'No concern provided.';

            const sharedImagesPane = $('pet-detail-shared-images');
            if (sharedImagesPane) {
                const placeholder = sharedImagesPane.querySelector('.sidebar-pet-detail-placeholder');
                const mediaUrls = Array.isArray(appointmentData.mediaUrls) ? appointmentData.mediaUrls : [];
                if (placeholder) {
                    if (mediaUrls.length === 0) {
                        placeholder.textContent = 'No images shared for this consultation.';
                        placeholder.classList.remove('is-hidden');
                    } else {
                        placeholder.classList.add('is-hidden');
                        let gallery = sharedImagesPane.querySelector('.sidebar-pet-shared-gallery');
                        if (!gallery) {
                            gallery = document.createElement('div');
                            gallery.className = 'sidebar-pet-shared-gallery';
                            sharedImagesPane.appendChild(gallery);
                        }
                        gallery.innerHTML = mediaUrls.map((url, idx) => {
                            const ext = (url || '').split('.').pop()?.toLowerCase();
                            const isImage = /^(jpg|jpeg|png|gif|webp|bmp)$/.test(ext || '');
                            if (isImage) {
                                return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-thumb"><img src="${escapeHtml(url)}" alt="Shared image ${idx + 1}" loading="lazy"></a>`;
                            }
                            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-file"><i class="fa fa-file-o"></i> File ${idx + 1}</a>`;
                        }).join('');
                    }
                }
            }
            const detailsGallery = $('details-shared-gallery');
            const detailsSharedPlaceholder = $('details-shared-placeholder');
            if (detailsGallery && detailsSharedPlaceholder) {
                const mediaUrlsForDetails = Array.isArray(appointmentData.mediaUrls) ? appointmentData.mediaUrls : [];
                if (mediaUrlsForDetails.length === 0) {
                    detailsSharedPlaceholder.textContent = 'No images shared for this consultation.';
                    detailsSharedPlaceholder.classList.remove('is-hidden');
                    detailsGallery.innerHTML = '';
                } else {
                    detailsSharedPlaceholder.classList.add('is-hidden');
                    detailsGallery.innerHTML = mediaUrlsForDetails.map((url, idx) => {
                        const ext = (url || '').split('.').pop()?.toLowerCase();
                        const isImage = /^(jpg|jpeg|png|gif|webp|bmp)$/.test(ext || '');
                        if (isImage) {
                            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-thumb"><img src="${escapeHtml(url)}" alt="Shared image ${idx + 1}" loading="lazy"></a>`;
                        }
                        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-pet-shared-file"><i class="fa fa-file-o"></i> File ${idx + 1}</a>`;
                    }).join('');
                }
            }

            const otherUid = isPetOwner ? vetId : ownerId;
            const otherParticipantNameEl = document.getElementById('other-participant-name');
            const otherParticipantImgEl = document.getElementById('other-participant-img');
            const otherParticipantInitialEl = document.getElementById('other-participant-initial');
            const otherAvatarWrap = document.getElementById('other-participant-avatar');

            try {
                if (otherUid) {
                    const otherSnap = await getDoc(doc(db, 'users', otherUid));
                    const otherData = otherSnap.exists() ? otherSnap.data() : {};
                    let otherName = (otherData.displayName || '').trim() || (isPetOwner ? 'Veterinarian' : 'Pet Owner');
                    const displayOtherName = isPetOwner
                        ? 'Dr. ' + (otherName || '').replace(/^Dr\.\s*/i, '').trim() || 'Dr. Veterinarian'
                        : otherName;
                    if (otherParticipantNameEl) otherParticipantNameEl.textContent = displayOtherName;
                    const photoURL = otherData.photoURL || otherData.photoUrl || '';
                    if (photoURL && otherParticipantImgEl) {
                        otherParticipantImgEl.src = photoURL;
                        otherParticipantImgEl.alt = otherName;
                        if (otherAvatarWrap) otherAvatarWrap.classList.add('has-avatar');
                    } else if (otherParticipantInitialEl) {
                        const initial = (displayOtherName || '?').trim().charAt(0).toUpperCase();
                        otherParticipantInitialEl.textContent = initial;
                    }
                    if (otherParticipantLabelEl) otherParticipantLabelEl.classList.add('is-hidden');
                    const detailsOtherName = $('details-other-name');
                    const detailsOtherImg = $('details-other-img');
                    const detailsOtherInitial = $('details-other-initial');
                    const detailsOtherAvatarWrap = $('details-other-avatar-wrap');
                    if (detailsOtherName) detailsOtherName.textContent = displayOtherName;
                    if (photoURL && detailsOtherImg) {
                        detailsOtherImg.src = photoURL;
                        detailsOtherImg.alt = otherName;
                        detailsOtherImg.removeAttribute('aria-hidden');
                        if (detailsOtherInitial) detailsOtherInitial.setAttribute('aria-hidden', 'true');
                        if (detailsOtherAvatarWrap) detailsOtherAvatarWrap.classList.add('has-avatar');
                    } else if (detailsOtherInitial) {
                        detailsOtherInitial.textContent = (displayOtherName || '?').trim().charAt(0).toUpperCase();
                        detailsOtherInitial.removeAttribute('aria-hidden');
                        if (detailsOtherImg) detailsOtherImg.setAttribute('aria-hidden', 'true');
                    }
                    const convoNameEl = document.getElementById('convo-panel-with-name');
                    const convoImgEl = document.getElementById('convo-panel-avatar-img');
                    const convoFallbackEl = document.getElementById('convo-panel-avatar-fallback');
                    if (convoNameEl) convoNameEl.textContent = displayOtherName;
                    if (photoURL && convoImgEl) {
                        convoImgEl.src = photoURL;
                        convoImgEl.alt = otherName;
                        convoImgEl.classList.remove('is-hidden');
                        if (convoFallbackEl) convoFallbackEl.classList.add('is-hidden');
                    } else if (convoFallbackEl) {
                        convoFallbackEl.textContent = (otherName || '?').trim().charAt(0).toUpperCase();
                        convoFallbackEl.classList.remove('is-hidden');
                        if (convoImgEl) convoImgEl.classList.add('is-hidden');
                    }
                } else {
                    if (otherParticipantNameEl) otherParticipantNameEl.textContent = isPetOwner ? 'Vet' : 'Pet Owner';
                    if (otherParticipantInitialEl) otherParticipantInitialEl.textContent = '?';
                    const detailsOtherName = $('details-other-name');
                    if (detailsOtherName) detailsOtherName.textContent = isPetOwner ? 'Vet' : 'Pet Owner';
                    const detailsOtherInitial = $('details-other-initial');
                    if (detailsOtherInitial) { detailsOtherInitial.textContent = '?'; detailsOtherInitial.removeAttribute('aria-hidden'); }
                }
            } catch (e) {
                console.warn('Could not load other participant', e);
                if (otherParticipantNameEl) otherParticipantNameEl.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
                if (otherParticipantInitialEl) otherParticipantInitialEl.textContent = '?';
                const convoNameEl = document.getElementById('convo-panel-with-name');
                if (convoNameEl) convoNameEl.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
                const detailsOtherName = $('details-other-name');
                if (detailsOtherName) detailsOtherName.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
                const detailsOtherInitial = $('details-other-initial');
                if (detailsOtherInitial) { detailsOtherInitial.textContent = '?'; detailsOtherInitial.removeAttribute('aria-hidden'); }
            }

            let myName = isVet ? 'Vet' : 'Pet Owner';
            try {
                const meSnap = await getDoc(doc(db, 'users', user.uid));
                const meData = meSnap.exists() ? meSnap.data() : {};
                myName = (meData.displayName || user.displayName || '').trim() || myName;
            } catch (e) {
                console.warn('Could not load current user for label', e);
            }
            const localLabel = isVet ? ('Dr. ' + (myName || '').replace(/^Dr\.\s*/i, '').trim() || 'Dr. Vet') : myName;
            if (localVideoLabelEl) localVideoLabelEl.textContent = localLabel;
            if (otherParticipantLabelEl) otherParticipantLabelEl.classList.add('is-hidden');

            const convoNameEl = document.getElementById('convo-panel-with-name');
            const ownerDisplayName = isPetOwner ? myName : (otherParticipantNameEl?.textContent || '');
            if (convoNameEl) convoNameEl.textContent = `${petName} – ${ownerDisplayName}`;

            if (consultationTitleEl) {
                const title = (appointmentData.title && String(appointmentData.title).trim()) || '';
                consultationTitleEl.textContent = title || `${petName} — ${(appointmentData.reason || 'Consultation').toString().slice(0, 30)}`;
            }
            if (consultationDatetimeEl && (appointmentData.dateStr || appointmentData.timeDisplay)) {
                const d = appointmentData.dateStr || '';
                const t = appointmentData.timeDisplay || '';
                consultationDatetimeEl.textContent = [d, t].filter(Boolean).join(' · ') || '—';
            }

            const convsSnap = await getDocs(query(collection(db, 'conversations'), where('participants', 'array-contains', user.uid)));
            const conv = convsSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .find(c => c.vetId === vetId && c.ownerId === ownerId && String(c.petId) === String(appointmentData.petId));
            if (conv) {
                currentConvId = conv.id;
            } else {
                const ownerName = isVet ? (otherParticipantNameEl?.textContent || 'Pet Owner') : myName;
                const vetName   = isVet ? myName : (otherParticipantNameEl?.textContent || 'Veterinarian');
                const convRef   = await addDoc(collection(db, 'conversations'), {
                    ownerId, ownerName, vetId, vetName,
                    petId: appointmentData.petId, petName,
                    vetSpecialty: '', participants: [ownerId, vetId],
                    lastMessage: '', lastMessageAt: serverTimestamp(), createdAt: serverTimestamp(),
                });
                currentConvId = convRef.id;
            }
        } catch (e) {
            console.error(e);
            showError('Could not load appointment.');
            return;
        }

        const appointmentTitle = (appointmentData?.title && String(appointmentData.title).trim()) || `${appointmentData?.petName || 'Pet'} — Consultation`;
        const appointmentDateTime = appointmentData?.dateStr || appointmentData?.timeDisplay
            ? [appointmentData?.dateStr || '', appointmentData?.timeDisplay || ''].filter(Boolean).join(' · ')
            : '';

        /** Consultation start time in ms (from dateStr + slotStart) for placing the divider in the timeline. */
        const dateStr = appointmentData?.dateStr || appointmentData?.date || '';
        const slotStart = appointmentData?.slotStart || appointmentData?.timeStart || '';
        const consultationStartMs = dateStr && slotStart
            ? (() => {
                const d = new Date(`${dateStr}T${slotStart}`);
                return isNaN(d.getTime()) ? null : d.getTime();
            })()
            : null;

        function renderConvoMessages(messages, appointmentTitleText, appointmentDateTimeStr) {
            if (!convoMessagesList) return;
            convoMessagesList.innerHTML = '';
            const uid = user.uid;
            const sentAvatarIcon = isVet ? 'fa-user-md' : 'fa-user';
            const receivedAvatarIcon = isVet ? 'fa-user' : 'fa-user-md';

            const appendDivider = () => {
                const dateTimeLabel = (dateStr && slotStart) ? formatAppointmentDividerDateTime(dateStr, slotStart) : appointmentDateTimeStr || '';
                const titleLabel = appointmentTitleText || '';
                if (!dateTimeLabel && !titleLabel) return;
                const div = document.createElement('div');
                div.className = 'video-call-convo-appointment-divider';
                div.innerHTML = `
                    <div class="video-call-convo-appointment-divider-line">
                        <span class="video-call-convo-appointment-divider-text">${escapeHtml(dateTimeLabel)}</span>
                    </div>
                    ${titleLabel ? `<div class="video-call-convo-appointment-divider-line">
                        <span class="video-call-convo-appointment-divider-text">${escapeHtml(titleLabel)}</span>
                    </div>` : ''}`;
                convoMessagesList.appendChild(div);
            };

            const appendSessionEndedDivider = (msg) => {
                const titleLabel = (msg.appointmentTitle && String(msg.appointmentTitle).trim()) || 'Consultation';
                const endedAt = msg.endedAt && typeof msg.endedAt.toDate === 'function'
                    ? formatMessageTimeWithDate(msg.endedAt)
                    : (msg.endedAt && typeof msg.endedAt.toMillis === 'function'
                        ? new Date(msg.endedAt.toMillis()).toLocaleString()
                        : '—');
                const endedLabel = `Session ended at ${endedAt}`;
                const div = document.createElement('div');
                div.className = 'video-call-convo-appointment-divider video-call-convo-session-ended-divider';
                div.innerHTML = `
                    <div class="video-call-convo-appointment-divider-line">
                        <span class="video-call-convo-appointment-divider-text">${escapeHtml(titleLabel)}</span>
                    </div>
                    <div class="video-call-convo-appointment-divider-line">
                        <span class="video-call-convo-appointment-divider-text">${escapeHtml(endedLabel)}</span>
                    </div>`;
                convoMessagesList.appendChild(div);
            };

            const appendMessage = (msg) => {
                if (msg.type === 'session_ended') { appendSessionEndedDivider(msg); return; }
                const isSent = msg.senderId === uid;
                const side   = isSent ? 'sent' : 'received';
                const bubble = document.createElement('div');
                bubble.className = `video-call-msg video-call-msg--${side}`;
                bubble.innerHTML = `
                    <span class="video-call-msg-avatar"><i class="fa ${isSent ? sentAvatarIcon : receivedAvatarIcon}" aria-hidden="true"></i></span>
                    <div class="video-call-msg-bubble">
                        ${msg.attachment ? renderAttachment(msg.attachment, msg.status === 'sending') : ''}
                        ${msg.text ? `<span class="video-call-msg-text">${escapeHtml(msg.text)}</span>` : ''}
                        <span class="video-call-msg-time">${escapeHtml(formatMessageTimeWithDate(msg.sentAt))}</span>
                    </div>`;
                convoMessagesList.appendChild(bubble);
            };

            const list = messages || [];
            if (consultationStartMs != null && (appointmentTitleText || appointmentDateTimeStr)) {
                let dividerInserted = false;
                for (const msg of list) {
                    if (!dividerInserted && timestampToMs(msg.sentAt) >= consultationStartMs) {
                        appendDivider(); dividerInserted = true;
                    }
                    appendMessage(msg);
                }
                if (!dividerInserted) appendDivider();
            } else {
                if (appointmentTitleText || appointmentDateTimeStr) appendDivider();
                list.forEach(appendMessage);
            }
            // Reveal image attachments once loaded
            convoMessagesList?.querySelectorAll('.message-attachment-img').forEach(img => {
                const wrap = img.closest('.message-attachment--image');
                if (!wrap) return;
                img.loading = 'eager';
                const reveal = () => wrap.classList.add('is-loaded');
                img.addEventListener('load', reveal);
                img.addEventListener('error', reveal);
                if (img.complete) reveal(); else setTimeout(reveal, 3000);
            });
            if (convoBody) convoBody.scrollTop = convoBody.scrollHeight;
        }

        if (currentConvId) {
            if (messagesUnsubscribe) messagesUnsubscribe();
            messagesUnsubscribe = onSnapshot(
                query(collection(db, 'conversations', currentConvId, 'messages'), orderBy('sentAt', 'asc')),
                snap => renderConvoMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })), appointmentTitle, appointmentDateTime),
                err => console.warn('Video call messages listener:', err)
            );
        } else if (convoMessagesList) {
            const empty = Object.assign(document.createElement('div'), { className: 'video-call-convo-empty', textContent: 'No conversation yet for this appointment.' });
            convoMessagesList.appendChild(empty);
        }

        if (convoBody) {
            convoBody.addEventListener('click', (e) => {
                const wrap = e.target.closest('.message-attachment--image');
                if (!wrap) return;
                const img = wrap.querySelector('.message-attachment-img');
                if (!img?.src) return;
                e.preventDefault();
                const lb = $('messages-image-lightbox');
                const lbImg = lb?.querySelector('.messages-image-lightbox-img');
                const lbTab = lb?.querySelector('.messages-image-lightbox-open-tab');
                if (lb && lbImg) {
                    lbImg.src = img.src;
                    lbImg.alt = 'Enlarged image';
                    if (lbTab) lbTab.href = img.src;
                    lb.classList.remove('is-hidden');
                    lb.setAttribute('aria-hidden', 'false');
                    document.body.style.overflow = 'hidden';
                }
            });
        }

        const closeLightbox = () => {
            const lb = $('messages-image-lightbox');
            if (!lb) return;
            lb.classList.add('is-hidden');
            lb.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
            const lbImg = lb.querySelector('.messages-image-lightbox-img');
            if (lbImg) lbImg.removeAttribute('src');
        };
        $('messages-image-lightbox')?.querySelector('.messages-image-lightbox-close')?.addEventListener('click', closeLightbox);
        $('messages-image-lightbox')?.querySelector('.messages-image-lightbox-backdrop')?.addEventListener('click', closeLightbox);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $('messages-image-lightbox') && !$('messages-image-lightbox').classList.contains('is-hidden')) {
                closeLightbox();
                e.stopImmediatePropagation();
            }
        });

        if (convoSendBtn && currentConvId) {
            convoSendBtn.addEventListener('click', async () => {
                const text = (convoInput?.value || '').trim();
                if (!text && !convoPendingFile) return;
                const payload = { senderId: user.uid, sentAt: serverTimestamp(), status: 'sending', text: text || null };
                let msgRef;
                try {
                    msgRef = await addDoc(collection(db, 'conversations', currentConvId, 'messages'), payload);
                } catch (err) {
                    console.error('Send message error:', err);
                    return;
                }
                if (convoInput) convoInput.value = '';
                resizeConvoInput();
                if (convoPendingFile) {
                    const v = validateAttachment(convoPendingFile);
                    if (!v.ok) { clearConvoAttach(); return; }
                    try {
                        const attachData = await uploadMessageAttachment(convoPendingFile, currentConvId);
                        await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { attachment: attachData, status: 'sent' });
                    } catch (err) {
                        await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { status: 'sent' }).catch(() => {});
                    }
                    clearConvoAttach();
                } else {
                    await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { status: 'sent' }).catch(() => {});
                }
                await updateDoc(doc(db, 'conversations', currentConvId), { lastMessageAt: serverTimestamp(), lastMessage: text || '(attachment)' }).catch(() => {});
            });
        }

        let peerConnection = null;
        let callDurationInterval = null;
        let localStream = null;
        let isOfferer = false;
        let remoteUid = null;
        let signalingUnsubscribe = null;
        let videoCallUnsubscribe = null;
        let sessionEndedHandled = false;
        const pendingIceCandidates = [];

        function setWaiting(show) {
            waitingEl?.classList.toggle('is-hidden', !show);
            connectedEl?.classList.toggle('is-hidden', show);
        }

        async function getLocalStream() {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (localVideo) localVideo.srcObject = localStream;
            } catch (e) {
                console.error('getUserMedia error:', e);
                setStatus('Could not access camera or microphone. Please allow access and try again.');
                setWaiting(false);
            }
        }

        function createPeerConnection() {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
            localStream?.getTracks().forEach(track => pc.addTrack(track, localStream));
            pc.ontrack = ev => {
                if (remoteVideo && ev.streams?.[0]) remoteVideo.srcObject = ev.streams[0];
            };
            pc.onicecandidate = ev => {
                if (ev.candidate) {
                    addDoc(signalingRef, { from: user.uid, candidate: JSON.stringify(ev.candidate), createdAt: serverTimestamp() })
                        .catch(err => console.warn('ICE send error', err));
                }
            };
            return pc;
        }

        async function createOffer() {
            if (!peerConnection) peerConnection = createPeerConnection();
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await setDoc(videoCallRef, { offer: JSON.stringify(offer), offererUid: user.uid, updatedAt: serverTimestamp() }, { merge: true });
        }

        async function drainPendingIceCandidates() {
            if (!peerConnection) return;
            while (pendingIceCandidates.length > 0) {
                const data = pendingIceCandidates.shift();
                if (data.from === user.uid) continue;
                try { await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))); }
                catch (e) { console.warn('addIceCandidate (drain) error', e); }
            }
        }

        async function handleOffer(offerStr) {
            if (!offerStr || peerConnection) return;
            peerConnection = createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerStr)));
            await drainPendingIceCandidates();
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await updateDoc(videoCallRef, { answer: JSON.stringify(answer), updatedAt: serverTimestamp() });
        }

        async function handleAnswer(answerStr) {
            if (!answerStr || !peerConnection || peerConnection.signalingState !== 'have-local-offer') return;
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
                await drainPendingIceCandidates();
            } catch (e) { console.warn('setRemoteDescription (answer) skipped:', e.message); }
        }

        async function handleIceCandidate(data) {
            if (data.from === user.uid) return;
            if (!peerConnection || peerConnection.remoteDescription === null) {
                pendingIceCandidates.push(data); return;
            }
            try { await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))); }
            catch (e) { console.warn('addIceCandidate error', e); pendingIceCandidates.push(data); }
        }

        /** Returns true if joined, false if room was already ended. */
        async function joinRoom() {
            const snap = await getDoc(videoCallRef);
            const data = snap.exists() ? snap.data() : {};
            if (data.status === 'ended') return false;
            const participants   = { ...(data.participants || {}), [user.uid]: true };
            const participantIds = Object.keys(participants);
            const offererUid     = data.offererUid || participantIds[0];
            await setDoc(videoCallRef, { participants, status: 'waiting', offererUid, updatedAt: serverTimestamp() }, { merge: true });
            return true;
        }

        function formatCallDuration(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        function startCallDurationTimer() {
            const startTime = Date.now();
            if (callDurationEl) callDurationEl.textContent = '0:00';
            callDurationInterval = setInterval(() => {
                if (callDurationEl) callDurationEl.textContent = formatCallDuration(Date.now() - startTime);
            }, 1000);
        }

        /** Stop media tracks, close peer connection, clear videos, clear timer. */
        function cleanupLocalMedia() {
            if (callDurationInterval) { clearInterval(callDurationInterval); callDurationInterval = null; }
            if (peerConnection) { peerConnection.close(); peerConnection = null; }
            if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
            if (remoteVideo) remoteVideo.srcObject = null;
            if (localVideo)  localVideo.srcObject  = null;
        }

        /** Clean up call state (timer, peer, streams) and remove self from room. Does not redirect. */
        function cleanupAndLeaveRoom() {
            cleanupLocalMedia();
            if (videoCallUnsubscribe) { videoCallUnsubscribe(); videoCallUnsubscribe = null; }
            if (signalingUnsubscribe) { signalingUnsubscribe(); signalingUnsubscribe = null; }
            return updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                updatedAt: serverTimestamp(),
            }).catch(() => {});
        }

        /** Format a Date-like value as a medium locale date+time string. */
        function formatSessionDateTime(ts) {
            if (!ts) return '—';
            try {
                const d = typeof ts.toDate === 'function' ? ts.toDate()
                    : typeof ts.toMillis === 'function' ? new Date(ts.toMillis())
                    : new Date(ts);
                return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            } catch (_) { return '—'; }
        }

        function formatSessionStartLabel(apt) {
            const ds = apt?.dateStr || apt?.date || '';
            const ts = apt?.slotStart || apt?.timeStart || '';
            if (!ds || !ts) return '—';
            return formatSessionDateTime(new Date(`${ds}T${ts}`));
        }

        /** Full-screen "Session Ended" overlay with start/end times and role-specific button. */
        function showSessionEndedOverlay(redirectQuery, opts = {}) {
            const { startLabel = '—', endLabel = '—', isVet = false } = opts;
            const overlay = document.createElement('div');
            overlay.className = 'video-call-session-ended-overlay';
            overlay.setAttribute('role', 'alert');
            overlay.setAttribute('aria-live', 'polite');
            let targetUrl = redirectQuery ? `${backUrl}${backUrl.includes('?') ? '&' : '?'}${redirectQuery.replace(/^\?/, '')}` : backUrl;
            if (!isVet && backUrl.includes('appointment.html')) {
                targetUrl = targetUrl.includes('?') ? `${targetUrl}&tab=history` : `${targetUrl}?tab=history`;
            }
            const buttonText = isVet ? 'Back to Appointments' : 'Go to Appointment History';
            overlay.innerHTML = `
                <div class="video-call-session-ended-card">
                    <div class="video-call-session-ended-icon" aria-hidden="true"><i class="fa fa-check-circle" aria-hidden="true"></i></div>
                    <h2 class="video-call-session-ended-title">Session Ended</h2>
                    <p class="video-call-session-ended-desc">The consultation has ended. You can no longer rejoin this call.</p>
                    <div class="video-call-session-ended-times">
                        <div class="video-call-session-ended-time-row">
                            <span class="video-call-session-ended-time-label">Started</span>
                            <span class="video-call-session-ended-time-value">${escapeHtml(startLabel)}</span>
                        </div>
                        <div class="video-call-session-ended-time-row">
                            <span class="video-call-session-ended-time-label">Ended</span>
                            <span class="video-call-session-ended-time-value">${escapeHtml(endLabel)}</span>
                        </div>
                    </div>
                    <button type="button" class="video-call-session-ended-btn" id="session-ended-return-btn">${escapeHtml(buttonText)}</button>
                </div>
            `;

            document.body.appendChild(overlay);
            const returnBtn = overlay.querySelector('#session-ended-return-btn');
            if (returnBtn) {
                returnBtn.addEventListener('click', () => { window.location.href = targetUrl; });
            }
            cleanupAndLeaveRoom().catch(() => {});
        }

        /** @param {string} [redirectQuery] - e.g. '?callEnded=1' to append to backUrl
         *  @param {{ showSessionEnded?: boolean, startLabel?: string, endLabel?: string, isVet?: boolean }} [opts] */
        function leaveRoom(redirectQuery = '', opts = {}) {
            const targetUrl = redirectQuery ? `${backUrl}${backUrl.includes('?') ? '&' : '?'}${redirectQuery.replace(/^\?/, '')}` : backUrl;
            if (opts.showSessionEnded) {
                showSessionEndedOverlay(redirectQuery, {
                    startLabel: opts.startLabel ?? formatSessionStartLabel(appointmentData),
                    endLabel: opts.endLabel ?? '—',
                    isVet: opts.isVet ?? isVet,
                });
                return;
            }
            cleanupAndLeaveRoom().finally(() => {
                window.location.href = targetUrl;
            });
        }

        /** Pet or vet temporarily leaves; session stays active, they can rejoin via same link. */
        function leaveTemporary() {
            cleanupLocalMedia();
            if (signalingUnsubscribe) signalingUnsubscribe();
            const targetUrl = `${backUrl}${backUrl.includes('?') ? '&' : '?'}leftCall=1`;
            updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                offer: deleteField(),
                answer: deleteField(),
                updatedAt: serverTimestamp(),
            }).catch(() => {}).finally(() => { window.location.href = targetUrl; });
        }

        /** Vet only: show Leave Only / Terminate Call popup. */
        function showVetLeaveEndModal() {
            const overlay = document.createElement('div');
            overlay.className = 'video-call-modal-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'video-call-leave-end-title');
            const dialog = document.createElement('div');
            dialog.className = 'video-call-leave-end-dialog';
            dialog.innerHTML = `
                <h2 id="video-call-leave-end-title" class="video-call-leave-end-title">Leave or end call?</h2>
                <p class="video-call-leave-end-desc">Choose how you want to leave this consultation.</p>
                <div class="video-call-leave-end-actions">
                    <button type="button" class="video-call-leave-end-btn video-call-leave-only-btn" id="vet-leave-only-btn">
                        <i class="fa fa-sign-out" aria-hidden="true"></i>
                        <span>Leave only</span>
                    </button>
                    <button type="button" class="video-call-leave-end-btn video-call-terminate-btn" id="vet-terminate-btn">
                        <i class="fa fa-phone" aria-hidden="true"></i>
                        <span>Terminate call completely</span>
                    </button>
                    <button type="button" class="video-call-leave-end-cancel" id="vet-leave-end-cancel">Cancel</button>
                </div>
            `;
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const close = () => overlay.remove();

            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelector('#vet-leave-end-cancel').addEventListener('click', close);
            overlay.querySelector('#vet-leave-only-btn').addEventListener('click', () => { close(); leaveTemporary(); });
            overlay.querySelector('#vet-terminate-btn').addEventListener('click', async () => {
                close();
                const endedAt = serverTimestamp();
                await setDoc(videoCallRef, {
                    status: 'ended',
                    endedBy: user.uid,
                    endedAt,
                    updatedAt: serverTimestamp(),
                }, { merge: true }).catch(() => {});
                if (currentConvId && appointmentTitle != null) {
                    try {
                        await addDoc(collection(db, 'conversations', currentConvId, 'messages'), {
                            type: 'session_ended',
                            appointmentTitle: appointmentTitle || '',
                            appointmentId,
                            endedAt,
                            sentAt: serverTimestamp(),
                        });
                        await updateDoc(doc(db, 'conversations', currentConvId), {
                            lastMessageAt: serverTimestamp(),
                            lastMessage: 'Session ended',
                        }).catch(() => {});
                    } catch (e) {
                        console.warn('Could not add session-ended message', e);
                    }
                }
                const updatedSnap = await getDoc(videoCallRef);
                const updatedData = updatedSnap.exists() ? updatedSnap.data() : {};
                leaveRoom('callEnded=1', {
                    showSessionEnded: true,
                    endLabel: formatSessionDateTime(updatedData.endedAt),
                    isVet: true,
                });
            });
        }

        hangUpBtn?.addEventListener('click', () => {
            if (isVet) {
                showVetLeaveEndModal();
            } else {
                leaveTemporary();
            }
        });

        function wireMediaToggle(btnId, getTracks, icons, labels) {
            $(btnId)?.addEventListener('click', () => {
                if (!localStream) return;
                const tracks = getTracks();
                if (!tracks.length) return;
                const enabled = !tracks[0].enabled;
                tracks[0].enabled = enabled;
                const btn = $(btnId);
                btn.querySelector('i').className = enabled ? icons[0] : icons[1];
                btn.classList.toggle('muted', !enabled);
                btn.setAttribute('aria-label', enabled ? labels[0] : labels[1]);
            });
        }
        wireMediaToggle('mic-toggle',
            () => localStream?.getAudioTracks() || [],
            ['fa fa-microphone', 'fa fa-microphone-slash'],
            ['Mute microphone', 'Unmute microphone']
        );
        wireMediaToggle('video-toggle',
            () => localStream?.getVideoTracks() || [],
            ['fa fa-video-camera', 'fa fa-video-slash'],
            ['Turn off camera', 'Turn on camera']
        );

        // If the call was already terminated, don't join — show session ended and stop.
        const roomSnap = await getDoc(videoCallRef);
        if (roomSnap.exists() && roomSnap.data().status === 'ended') {
            showSessionEndedOverlay('callEnded=1', { startLabel: formatSessionStartLabel(appointmentData), endLabel: formatSessionDateTime(roomSnap.data().endedAt), isVet });
            return;
        }

        await getLocalStream();
        if (!await joinRoom()) {
            const endedSnap = await getDoc(videoCallRef);
            const endedData = endedSnap.exists() ? endedSnap.data() : {};
            showSessionEndedOverlay('callEnded=1', { startLabel: formatSessionStartLabel(appointmentData), endLabel: formatSessionDateTime(endedData.endedAt), isVet });
            return;
        }
        startCallDurationTimer();

        videoCallUnsubscribe = onSnapshot(videoCallRef, async (snap) => {
            if (!snap.exists()) return;
            const data = snap.data();
            if (data.status === 'ended') {
                if (sessionEndedHandled) return;
                sessionEndedHandled = true;
                leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatSessionDateTime(data.endedAt), isVet });
                return;
            }
            const participants = data.participants || {};
            const pids = Object.keys(participants).filter(k => participants[k]);
            remoteUid = pids.find(id => id !== user.uid) || null;
            isOfferer = (data.offererUid || pids[0]) === user.uid;

            if (pids.length < 2) {
                setStatus('Waiting for the other participant…');
                setWaiting(true);
                pendingIceCandidates.length = 0;
                if (peerConnection) { peerConnection.close(); peerConnection = null; }
                if (remoteVideo) remoteVideo.srcObject = null;
                updateDoc(videoCallRef, { offer: deleteField(), answer: deleteField(), updatedAt: serverTimestamp() }).catch(() => {});
                return;
            }

            setStatus('Connected');
            setWaiting(false);
            if (isOfferer && !data.offer)              { await createOffer();           return; }
            if (!isOfferer && data.offer && !peerConnection) { await handleOffer(data.offer);  return; }
            if (isOfferer && data.answer && peerConnection)  await handleAnswer(data.answer);
        });

        signalingUnsubscribe = onSnapshot(signalingRef, snap => {
            snap.docChanges().forEach(change => {
                if (change.type === 'added') handleIceCandidate(change.doc.data());
            });
        });

        // On mobile, Firebase listeners may pause when hidden. Re-check status on page restore.
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible' || sessionEndedHandled) return;
            try {
                const snap = await getDoc(videoCallRef);
                if (snap.exists() && snap.data().status === 'ended' && !sessionEndedHandled) {
                    sessionEndedHandled = true;
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatSessionDateTime(snap.data().endedAt), isVet });
                }
            } catch (e) { console.warn('visibilitychange status check failed:', e); }
        });
    });
}
