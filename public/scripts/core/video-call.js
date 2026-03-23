/**
 * Televet Health — Video call room (WebRTC + Firestore signaling)
 * Shared by petowner/video-call.html and vet/video-call.html
 */
import { app, auth, db } from './firebase-config.js';
import { escapeHtml } from './utils.js';
import { generateConsultationPDF } from './consultation-pdf.js';
import { renderAttachment, uploadMessageAttachment, validateAttachment } from './message-attachments.js';
import { isVideoSessionEnded } from './video-call-utils.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-functions.js';
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
    writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

/** Remove ICE candidate documents under appointments/{id}/signaling after a call ends (500 writes per batch). */
async function clearSignalingCollection(db, appointmentId) {
    const colRef = collection(db, 'appointments', appointmentId, 'signaling');
    const snap = await getDocs(colRef);
    const docs = snap.docs;
    if (!docs.length) return;
    const chunk = 500;
    for (let i = 0; i < docs.length; i += chunk) {
        const batch = writeBatch(db);
        docs.slice(i, i + chunk).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
}

/* Default ICE servers; TURN can be loaded dynamically from Cloud Functions. */
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
];

const DEFAULT_RTC_CONFIG = {
    iceServers: DEFAULT_ICE_SERVERS,
};

const $ = id => document.getElementById(id);

const getAppointmentId = () => new URLSearchParams(window.location.search).get('appointmentId') || '';
const shouldForceRelay = () => new URLSearchParams(window.location.search).get('forceRelay') === '1';

/** Firestore may return plain strings or DocumentReference for id fields; rules and paths need the uid string. */
function idFromFirestoreField(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
    return String(value).trim();
}

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
        const notes = $('video-call-notes-panel');
        if (open && notes) { notes.classList.add('is-hidden'); container?.classList.remove('notes-open'); }
    }
    const openConvoPanel   = () => setConvoPanel(true);
    const closeConvoPanel  = () => setConvoPanel(false);
    const toggleConvoPanel = () => setConvoPanel(convoPanel?.classList.contains('is-hidden'));

    messageBtn?.addEventListener('click', () => {
        if (typeof onMessageClick === 'function') onMessageClick();
        else toggleConvoPanel();
    });
    $('convo-panel-close')?.addEventListener('click', closeConvoPanel);

    /* Notes panel (vet only) — slides in from left like message, dashed border */
    const notesPanel = $('video-call-notes-panel');
    const notesBtn = $('notes-btn');
    function setNotesPanel(open) {
        if (!notesPanel || !container) return;
        notesPanel.classList.toggle('is-hidden', !open);
        container.classList.toggle('notes-open', open);
        if (open) closeConvoPanel();
    }
    const toggleNotesPanel = () => setNotesPanel(notesPanel?.classList.contains('is-hidden'));
    const closeNotesPanel = () => setNotesPanel(false);
    notesBtn?.addEventListener('click', () => {
        if (notesPanel) toggleNotesPanel();
    });
    $('notes-panel-close')?.addEventListener('click', closeNotesPanel);

    /* Notes textareas: when vet focuses (enters first line), that field expands to fill remaining space */
    const notesTextareas = ['notes-observation', 'notes-assessment', 'notes-prescription', 'notes-care-instruction', 'notes-follow-up'];
    function resizeNotesTextarea(ta) {
        if (!ta) return;
        /* Flex layout handles sizing; no manual height needed */
    }
    function setNotesFieldExpanded(fieldEl) {
        notesPanel?.querySelectorAll('.video-call-notes-field[data-notes-field]').forEach(f => {
            f.classList.remove('is-expanded', 'is-collapsed');
            const ta = f.querySelector('.video-call-notes-textarea');
            if (ta) ta.style.height = '';
        });
        notesPanel?.querySelectorAll('.video-call-notes-field[data-notes-field]').forEach(f => {
            if (f !== fieldEl) f.classList.add('is-collapsed');
        });
        if (fieldEl) {
            fieldEl.classList.add('is-expanded');
            fieldEl.classList.remove('is-collapsed');
            const expandedTa = fieldEl.querySelector('.video-call-notes-textarea');
            if (expandedTa) expandedTa.style.height = '';
        }
    }
    const NOTES_DASH = '– '; /* en dash, ~75% of em dash */
    const NOTES_DASH_LEN = NOTES_DASH.length;

    /** Attach dash feature (Enter = new line with "– ", etc.) to any textarea. Used by notes panel and session-ended overlay.
     *  @param {HTMLTextAreaElement} ta
     *  @param {{ onFocusExtra?: () => void }} [opts] - Optional extra logic on focus (e.g. notes panel expand) */
    function attachNotesDashToTextarea(ta, opts = {}) {
        if (!ta) return;
        let justAddedLine = false;
        const { onFocusExtra } = opts;
        function onKeydown(e) {
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const val = ta.value;
            const lines = val.split('\n');
            let lineStart = 0;
            let lineIdx = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineEnd = lineStart + lines[i].length;
                if (start <= lineEnd) { lineIdx = i; break; }
                lineStart = lineEnd + 1;
            }
            const line = lines[lineIdx] || '';
            const isFirstLine = lineIdx === 0;
            if (e.key === 'Enter') {
                e.preventDefault();
                justAddedLine = true;
                const before = val.slice(0, start);
                const after = val.slice(end);
                ta.value = before + '\n' + NOTES_DASH + after;
                const newPos = start + 1 + NOTES_DASH_LEN;
                ta.setSelectionRange(newPos, newPos);
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            if (isFirstLine && line.startsWith(NOTES_DASH)) {
                if (e.key === 'Backspace' && start <= NOTES_DASH_LEN) { e.preventDefault(); return; }
                if (e.key === 'Delete' && start < NOTES_DASH_LEN) { e.preventDefault(); return; }
            }
            if (!isFirstLine && (line === NOTES_DASH.trim() || line === NOTES_DASH || line === '')) {
                if (e.key === 'Backspace') {
                    e.preventDefault();
                    const beforeLines = lines.slice(0, lineIdx);
                    const afterLines = lines.slice(lineIdx + 1);
                    const newVal = beforeLines.join('\n') + (afterLines.length ? '\n' + afterLines.join('\n') : '');
                    ta.value = newVal;
                    const cursorPos = Math.max(0, lineStart - 1);
                    ta.setSelectionRange(cursorPos, cursorPos);
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
        function onFocus() {
            if (!ta.value.trim()) {
                ta.value = NOTES_DASH;
                ta.setSelectionRange(NOTES_DASH_LEN, NOTES_DASH_LEN);
            }
            onFocusExtra?.();
        }
        function onInput() {
            if (justAddedLine) { justAddedLine = false; return; }
            const val = ta.value;
            const lines = val.split('\n');
            if (lines.length <= 1) return;
            const start = ta.selectionStart;
            let lineStart = 0;
            let lineIdx = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineEnd = lineStart + lines[i].length;
                if (start <= lineEnd) { lineIdx = i; break; }
                lineStart = lineEnd + 1;
            }
            const line = lines[lineIdx] || '';
            const isEmptyLine = line === NOTES_DASH || line === NOTES_DASH.trim() || line === '';
            if (lineIdx > 0 && isEmptyLine) {
                const beforeLines = lines.slice(0, lineIdx);
                const afterLines = lines.slice(lineIdx + 1);
                const newVal = beforeLines.join('\n') + (afterLines.length ? '\n' + afterLines.join('\n') : '');
                ta.value = newVal;
                const cursorPos = Math.max(0, lineStart - 1);
                ta.setSelectionRange(cursorPos, cursorPos);
                ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        ta.addEventListener('keydown', onKeydown);
        ta.addEventListener('focus', onFocus);
        ta.addEventListener('input', onInput);
    }

    notesTextareas.forEach(id => {
        const ta = $(id);
        if (ta) {
            attachNotesDashToTextarea(ta, {
                onFocusExtra: () => setNotesFieldExpanded(ta.closest('.video-call-notes-field')),
            });
            ta.addEventListener('input', () => resizeNotesTextarea(ta));
            ta.addEventListener('blur', () => {
                setTimeout(() => {
                    if (!notesPanel?.contains(document.activeElement)) {
                        notesPanel?.querySelectorAll('.video-call-notes-field[data-notes-field]').forEach(f => {
                            f.classList.remove('is-expanded', 'is-collapsed');
                            const t = f.querySelector('.video-call-notes-textarea');
                            if (t) t.style.height = '';
                        });
                    }
                }, 0);
            });
            ta.addEventListener('paste', () => setTimeout(() => { resizeNotesTextarea(ta); }, 0));
        }
    });
    const resizeAllNotesTextareas = () => notesTextareas.forEach(id => resizeNotesTextarea($(id)));
    notesBtn?.addEventListener('click', () => setTimeout(resizeAllNotesTextareas, 50));

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
        let rtcConfig = { ...DEFAULT_RTC_CONFIG };

        async function loadRtcConfig() {
            const forceRelay = shouldForceRelay();
            try {
                const callable = httpsCallable(getFunctions(app, 'us-central1'), 'getRtcIceServers');
                const result = await callable();
                const servers = result?.data?.iceServers;
                if (Array.isArray(servers) && servers.length > 0) {
                    rtcConfig = forceRelay ? { iceServers: servers, iceTransportPolicy: 'relay' } : { iceServers: servers };
                    const hasRelay = servers.some((s) => {
                        const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
                        return urls.some((u) => typeof u === 'string' && /^turns?:/i.test(u));
                    });
                    console.info('RTC ICE loaded from backend.', { hasRelay, serverCount: servers.length, forceRelay });
                } else {
                    rtcConfig = forceRelay ? { ...DEFAULT_RTC_CONFIG, iceTransportPolicy: 'relay' } : { ...DEFAULT_RTC_CONFIG };
                }
            } catch (e) {
                console.warn(
                    'RTC ICE config fallback (using STUN-only). Ensure getRtcIceServers is deployed and callable (CORS/auth).',
                    e
                );
                rtcConfig = forceRelay ? { ...DEFAULT_RTC_CONFIG, iceTransportPolicy: 'relay' } : { ...DEFAULT_RTC_CONFIG };
            }
        }

        try {
            const aptSnap = await getDoc(appointmentRef);
            if (!aptSnap.exists()) {
                showError('Appointment not found.');
                return;
            }
            appointmentData = { ...aptSnap.data() };
            appointmentData.ownerId = idFromFirestoreField(appointmentData.ownerId);
            appointmentData.vetId = idFromFirestoreField(appointmentData.vetId);
            appointmentData.petId = idFromFirestoreField(appointmentData.petId);
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

            /* Vet: Clinical notes — auto-save, load saved notes, save on terminate */
            const notesIds = ['notes-observation', 'notes-assessment', 'notes-prescription', 'notes-care-instruction', 'notes-follow-up'];
            const notesKeys = ['observation', 'assessment', 'prescription', 'careInstruction', 'followUp'];
            const notesAutosaveEl = $('notes-autosave-status');
            let notesSaveTimeout = null;
            const NOTES_DEBOUNCE_MS = 1200;

            function getNotesFromForm() {
                const out = {};
                notesIds.forEach((id, i) => {
                    const el = $(id);
                    out[notesKeys[i]] = (el?.value || '').trim();
                });
                return out;
            }
            function setNotesToForm(data) {
                if (!data) return;
                notesIds.forEach((id, i) => {
                    const el = $(id);
                    if (el && data[notesKeys[i]] != null) el.value = String(data[notesKeys[i]]);
                });
                notesTextareas?.forEach(id => resizeNotesTextarea($(id)));
            }
            function showNotesAutosaveStatus(text, isSuccess = true) {
                if (!notesAutosaveEl) return;
                notesAutosaveEl.textContent = text;
                notesAutosaveEl.classList.toggle('is-saved', isSuccess);
                notesAutosaveEl.classList.toggle('is-saving', !isSuccess && text);
                if (text) setTimeout(() => { notesAutosaveEl.textContent = ''; notesAutosaveEl.classList.remove('is-saved', 'is-saving'); }, 2500);
            }
            async function saveNotesToFirestore() {
                if (!isVet || !appointmentRef) return;
                const notes = getNotesFromForm();
                try {
                    showNotesAutosaveStatus('Saving…', false);
                    await updateDoc(appointmentRef, {
                        consultationNotes: notes,
                        consultationNotesUpdatedAt: serverTimestamp(),
                    });
                    showNotesAutosaveStatus('Saved');
                } catch (e) {
                    console.warn('Notes auto-save failed:', e);
                    showNotesAutosaveStatus('Save failed');
                }
            }
            function scheduleNotesSave() {
                if (!isVet) return;
                if (notesSaveTimeout) clearTimeout(notesSaveTimeout);
                notesSaveTimeout = setTimeout(saveNotesToFirestore, NOTES_DEBOUNCE_MS);
            }

            if (isVet) {
                const saved = appointmentData.consultationNotes;
                if (saved && typeof saved === 'object') setNotesToForm(saved);
                notesIds.forEach(id => {
                    const el = $(id);
                    if (el) {
                        el.addEventListener('input', scheduleNotesSave);
                        el.addEventListener('paste', () => setTimeout(scheduleNotesSave, 0));
                    }
                });
            }

            const ownerUid = ownerId;
            const vetUid = vetId;
            try {
                const [ownerConvsSnap, vetConvsSnap] = await Promise.all([
                    getDocs(query(collection(db, 'conversations'), where('ownerId', '==', user.uid))),
                    getDocs(query(collection(db, 'conversations'), where('vetId', '==', user.uid))),
                ]);
                const convDocs = [...ownerConvsSnap.docs, ...vetConvsSnap.docs];
                const conv = convDocs
                    .map(d => ({ id: d.id, ...d.data() }))
                    .find((c) => {
                        const o = idFromFirestoreField(c.ownerId);
                        const v = idFromFirestoreField(c.vetId);
                        return v === vetUid && o === ownerUid && String(c.petId) === String(appointmentData.petId);
                    });
                if (conv) {
                    currentConvId = conv.id;
                } else if (ownerUid && vetUid && ownerUid !== vetUid) {
                    const ownerName = isVet ? (otherParticipantNameEl?.textContent || 'Pet Owner') : myName;
                    const vetName = isVet ? myName : (otherParticipantNameEl?.textContent || 'Veterinarian');
                    const convRef = await addDoc(collection(db, 'conversations'), {
                        ownerId: ownerUid,
                        ownerName,
                        vetId: vetUid,
                        vetName,
                        petId: appointmentData.petId,
                        petName,
                        vetSpecialty: '',
                        participants: [ownerUid, vetUid],
                        lastMessage: '',
                        lastMessageAt: serverTimestamp(),
                        createdAt: serverTimestamp(),
                    });
                    currentConvId = convRef.id;
                }
            } catch (convErr) {
                console.warn('Video call: could not open or create conversation (chat may be unavailable):', convErr);
                currentConvId = null;
            }
        } catch (e) {
            console.error(e);
            showError('Could not load appointment.');
            return;
        }

        function renderConvoMessages(messages) {
            if (!convoMessagesList) return;
            convoMessagesList.innerHTML = '';
            const uid = user.uid;
            const sentAvatarIcon = isVet ? 'fa-user-md' : 'fa-user';
            const receivedAvatarIcon = isVet ? 'fa-user' : 'fa-user-md';

            const appendMessage = (msg) => {
                // System message for terminated calls — do not render in the UI.
                if (msg.type === 'session_ended') return;

                const text = msg.text || '';
                const isSent = msg.senderId === uid;
                const side   = isSent ? 'sent' : 'received';
                const bubble = document.createElement('div');
                bubble.className = `video-call-msg video-call-msg--${side}`;
                bubble.innerHTML = `
                    <span class="video-call-msg-avatar"><i class="fa ${isSent ? sentAvatarIcon : receivedAvatarIcon}" aria-hidden="true"></i></span>
                    <div class="video-call-msg-bubble">
                        ${msg.attachment ? renderAttachment(msg.attachment, msg.status === 'sending') : ''}
                        ${text ? `<span class="video-call-msg-text">${escapeHtml(text)}</span>` : ''}
                    </div>`;
                convoMessagesList.appendChild(bubble);
            };

            const list = messages || [];
            list.forEach(appendMessage);
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
                snap => renderConvoMessages(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
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
        let appointmentUnsubscribe = null;
        let sessionEndedHandled = false;
        let sessionOngoingSlotUpdated = false;
        const pendingIceCandidates = [];
        let connectionEstablished = false;
        let establishTimeoutId = null;
        let reconnectBtnEl = null;
        const ESTABLISH_TIMEOUT_MS = 50000;
        let currentSignalingSessionId = null;
        let autoReconnectAttempts = 0;
        let autoReconnectTimerId = null;
        const MAX_AUTO_RECONNECT_ATTEMPTS = 5;
        const AUTO_RECONNECT_BASE_MS = 1200;
        let preferRelayTransport = false;

        function nextSignalingSessionId() {
            return `${user.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        function setWaiting(show) {
            waitingEl?.classList.toggle('is-hidden', !show);
            connectedEl?.classList.toggle('is-hidden', show);
        }

        function setVisiblePhaseMessage(text, iconClass = 'fa-clock-o') {
            if (!waitingEl) return;
            waitingEl.innerHTML = `<i class="fa ${iconClass}" aria-hidden="true"></i> ${escapeHtml(text)}`;
        }

        function showReconnectUI(show) {
            const wrap = document.querySelector('.remote-video-wrap');
            if (!wrap) return;
            if (show) {
                if (!reconnectBtnEl) {
                    reconnectBtnEl = document.createElement('button');
                    reconnectBtnEl.type = 'button';
                    reconnectBtnEl.className = 'video-call-reconnect-btn';
                    reconnectBtnEl.innerHTML = '<i class="fa fa-refresh" aria-hidden="true"></i> Reconnect video';
                    reconnectBtnEl.setAttribute('aria-label', 'Reconnect video');
                    reconnectBtnEl.addEventListener('click', () => {
                        reconnectBtnEl?.classList.add('is-loading');
                        reconnectBtnEl.disabled = true;
                        triggerReconnect();
                    });
                    wrap.appendChild(reconnectBtnEl);
                }
                reconnectBtnEl.classList.remove('is-hidden');
                reconnectBtnEl.classList.remove('is-loading');
                reconnectBtnEl.disabled = false;
            } else if (reconnectBtnEl) {
                reconnectBtnEl.classList.add('is-hidden');
            }
        }

        function clearAutoReconnectTimer() {
            if (autoReconnectTimerId) {
                clearTimeout(autoReconnectTimerId);
                autoReconnectTimerId = null;
            }
        }

        function scheduleAutoReconnect(reason = 'network') {
            if (sessionEndedHandled) return;
            if (autoReconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) {
                setStatus('Connection unstable. Tap reconnect to try again.');
                showReconnectUI(true);
                return;
            }
            if (autoReconnectTimerId) return;
            const waitMs = Math.min(
                AUTO_RECONNECT_BASE_MS * Math.pow(2, autoReconnectAttempts),
                10000
            );
            autoReconnectAttempts += 1;
            setStatus(`Reconnecting (${reason})…`);
            autoReconnectTimerId = setTimeout(() => {
                autoReconnectTimerId = null;
                triggerReconnect();
            }, waitMs);
        }

        async function triggerReconnect() {
            if (sessionEndedHandled) return;
            try {
                clearAutoReconnectTimer();
                if (peerConnection) { peerConnection.close(); peerConnection = null; }
                pendingIceCandidates.length = 0;
                connectionEstablished = false;
                currentSignalingSessionId = nextSignalingSessionId();
                if (remoteVideo) remoteVideo.srcObject = null;
                await updateDoc(videoCallRef, {
                    offer: deleteField(),
                    answer: deleteField(),
                    sessionId: currentSignalingSessionId,
                    updatedAt: serverTimestamp(),
                }).catch(() => {});
                setStatus('Reconnecting…');
                setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                setWaiting(true);
                showReconnectUI(false);
                /* Offerer's onSnapshot will fire and create new offer; answerer will handle it */
            } catch (e) {
                console.warn('Reconnect error:', e);
                setStatus('Reconnecting failed. Try leaving and rejoining.');
                showReconnectUI(true);
            }
        }

        function createPeerConnection() {
            const effectiveRtcConfig = preferRelayTransport
                ? { ...rtcConfig, iceTransportPolicy: 'relay' }
                : rtcConfig;
            const pc = new RTCPeerConnection(effectiveRtcConfig);
            localStream?.getTracks().forEach(track => pc.addTrack(track, localStream));
            pc.ontrack = ev => {
                if (remoteVideo && ev.streams?.[0]) remoteVideo.srcObject = ev.streams[0];
            };
            pc.onicecandidate = ev => {
                if (ev.candidate) {
                    addDoc(signalingRef, {
                        from: user.uid,
                        candidate: JSON.stringify(ev.candidate),
                        sessionId: currentSignalingSessionId || null,
                        createdAt: serverTimestamp(),
                    })
                        .catch(err => console.warn('ICE send error', err));
                }
            };
            pc.onicegatheringstatechange = () => {
                console.info('ICE gathering state:', pc.iceGatheringState);
            };
            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === 'connected' || state === 'completed') {
                    connectionEstablished = true;
                    autoReconnectAttempts = 0;
                    clearAutoReconnectTimer();
                    if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
                    setStatus('Connected');
                    setWaiting(false);
                    showReconnectUI(false);
                } else if (state === 'failed' || state === 'disconnected') {
                    if (state === 'failed') {
                        preferRelayTransport = true;
                        setStatus('Connection failed. Network path blocked (likely no relay). Trying to reconnect…');
                        setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                        showReconnectUI(true);
                        scheduleAutoReconnect('failed');
                    } else if (state === 'disconnected' && connectionEstablished) {
                        setStatus('Connection unstable. Trying to reconnect…');
                        setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                        try { pc.restartIce(); } catch (_) {}
                        scheduleAutoReconnect('unstable');
                    }
                }
            };
            pc.onconnectionstatechange = () => {
                const state = pc.connectionState;
                console.info('Peer connection state:', state);
                if (state === 'connected') {
                    connectionEstablished = true;
                    autoReconnectAttempts = 0;
                    clearAutoReconnectTimer();
                    if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
                    setStatus('Connected');
                    setWaiting(false);
                    showReconnectUI(false);
                } else if (state === 'failed') {
                    preferRelayTransport = true;
                    setStatus('Connection failed. Network path blocked (likely no relay). Trying to reconnect…');
                    setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                    showReconnectUI(true);
                    scheduleAutoReconnect('failed');
                }
            };
            return pc;
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

        async function createOffer() {
            if (!peerConnection) peerConnection = createPeerConnection();
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            if (!currentSignalingSessionId) currentSignalingSessionId = nextSignalingSessionId();
            await setDoc(videoCallRef, {
                offer: JSON.stringify(offer),
                offererUid: user.uid,
                sessionId: currentSignalingSessionId,
                updatedAt: serverTimestamp(),
            }, { merge: true });
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

        async function handleOffer(offerStr, sessionId) {
            if (!offerStr || peerConnection) return;
            const activeSessionId = sessionId || currentSignalingSessionId || nextSignalingSessionId();
            currentSignalingSessionId = activeSessionId;
            if (!sessionId) {
                await updateDoc(videoCallRef, { sessionId: activeSessionId, updatedAt: serverTimestamp() }).catch(() => {});
            }
            peerConnection = createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerStr)));
            await drainPendingIceCandidates();
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await updateDoc(videoCallRef, {
                answer: JSON.stringify(answer),
                sessionId: activeSessionId,
                updatedAt: serverTimestamp(),
            });
        }

        async function handleAnswer(answerStr, sessionId) {
            if (!answerStr || !peerConnection || peerConnection.signalingState !== 'have-local-offer') return;
            if (sessionId && currentSignalingSessionId && sessionId !== currentSignalingSessionId) return;
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
                await drainPendingIceCandidates();
            } catch (e) { console.warn('setRemoteDescription (answer) skipped:', e.message); }
        }

        async function handleIceCandidate(data) {
            if (data.from === user.uid) return;
            if (currentSignalingSessionId && data.sessionId !== currentSignalingSessionId) return;
            if (!peerConnection || peerConnection.remoteDescription === null) {
                pendingIceCandidates.push(data); return;
            }
            try { await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))); }
            catch (e) { console.warn('addIceCandidate error', e); pendingIceCandidates.push(data); }
        }

        /** Returns true if joined, false if room was already ended. */
        async function joinRoom() {
            const aptSnap = await getDoc(appointmentRef);
            if (aptSnap.exists() && isVideoSessionEnded(aptSnap.data())) return false;
            const snap = await getDoc(videoCallRef);
            const data = snap.exists() ? snap.data() : {};
            if (data.status === 'ended') return false;
            const participants   = { ...(data.participants || {}), [user.uid]: true };
            const participantIds = Object.keys(participants);
            const offererUid     = data.offererUid || participantIds[0];
            currentSignalingSessionId = data.sessionId || nextSignalingSessionId();
            await setDoc(videoCallRef, {
                participants,
                status: 'waiting',
                offererUid,
                sessionId: currentSignalingSessionId,
                updatedAt: serverTimestamp(),
            }, { merge: true });
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
            if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
            clearAutoReconnectTimer();
            if (callDurationInterval) { clearInterval(callDurationInterval); callDurationInterval = null; }
            if (peerConnection) { peerConnection.close(); peerConnection = null; }
            if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
            if (remoteVideo) remoteVideo.srcObject = null;
            if (localVideo)  localVideo.srcObject  = null;
            showReconnectUI(false);
        }

        /** Clean up call state (timer, peer, streams) and remove self from room. Does not redirect. */
        function cleanupAndLeaveRoom() {
            cleanupLocalMedia();
            if (videoCallUnsubscribe) { videoCallUnsubscribe(); videoCallUnsubscribe = null; }
            if (appointmentUnsubscribe) { appointmentUnsubscribe(); appointmentUnsubscribe = null; }
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

        /** Normalize "9:00" / "09:00" to "HH:mm" for comparison */
        function normalizeTime(t) {
            if (!t || typeof t !== 'string') return '';
            const parts = t.trim().split(':');
            const h = parseInt(parts[0], 10);
            const m = parts[1] != null ? parseInt(parts[1], 10) : 0;
            if (isNaN(h)) return '';
            return `${String(h).padStart(2, '0')}:${String(isNaN(m) ? 0 : m).padStart(2, '0')}`;
        }

        function formatSessionStartLabel(apt) {
            const ds = apt?.dateStr || apt?.date || '';
            const ts = apt?.slotStart || apt?.timeStart || '';
            if (!ds || !ts) return '—';
            return formatSessionDateTime(new Date(`${ds}T${ts}`));
        }

        /** Full-screen "Session Ended" overlay with start/end times and role-specific button. Vet: shows consultation notes for final review + Download PDF. */
        async function showSessionEndedOverlay(redirectQuery, opts = {}) {
            const { startLabel = '—', endLabel = '—', isVet = false, consultationNotes: notesParam, appointmentRef: aptRef, appointmentData: aptData } = opts;
            let consultationNotes = notesParam;
            if (isVet && !consultationNotes && aptRef) {
                try {
                    const snap = await getDoc(aptRef);
                    consultationNotes = snap.exists() ? snap.data().consultationNotes : null;
                } catch (e) {
                    console.warn('Could not fetch consultation notes:', e);
                }
            }
            const notes = consultationNotes && typeof consultationNotes === 'object' ? consultationNotes : {};
            const notesLabels = [
                ['observation', 'Observation'],
                ['assessment', 'Assessment'],
                ['prescription', 'Prescription'],
                ['careInstruction', 'Care instruction'],
                ['followUp', 'Follow up'],
            ];
            const notesHtml = isVet ? `
                <div class="video-call-session-ended-notes">
                    <h3 class="video-call-session-ended-notes-title"><i class="fa fa-file-text-o" aria-hidden="true"></i> Finalize consultation notes</h3>
                    <div class="video-call-session-ended-notes-list">
                        ${notesLabels.map(([key, label]) => {
                            const val = (notes[key] || '').trim() || '';
                            return `<div class="video-call-session-ended-notes-row">
                                <label for="session-ended-notes-${key}" class="video-call-session-ended-notes-label">${escapeHtml(label)}</label>
                                <textarea id="session-ended-notes-${key}" class="video-call-session-ended-notes-textarea" rows="2" maxlength="${key === 'observation' || key === 'prescription' ? 1500 : key === 'careInstruction' ? 1000 : 800}" data-notes-key="${key}" placeholder="—">${escapeHtml(val)}</textarea>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            ` : '';

            const overlay = document.createElement('div');
            overlay.className = 'video-call-session-ended-overlay';
            overlay.setAttribute('role', 'alert');
            overlay.setAttribute('aria-live', 'polite');
            let targetUrl = redirectQuery ? `${backUrl}${backUrl.includes('?') ? '&' : '?'}${redirectQuery.replace(/^\?/, '')}` : backUrl;
            if (!isVet && backUrl.includes('appointment.html')) {
                targetUrl = targetUrl.includes('?') ? `${targetUrl}&tab=history` : `${targetUrl}?tab=history`;
            }
            const buttonText = isVet ? 'Confirm' : 'Go to Appointment History';
            overlay.innerHTML = `
                <div class="video-call-session-ended-card ${isVet ? 'has-notes' : ''}">
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
                    ${notesHtml}
                    <div class="video-call-session-ended-actions" id="session-ended-actions">
                        <button type="button" class="video-call-session-ended-btn" id="session-ended-return-btn">${escapeHtml(buttonText)}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            /* Expand-on-focus for session-ended notes rows */
            const notesListEl = overlay.querySelector('.video-call-session-ended-notes-list');
            function setSessionEndedNotesRowExpanded(rowEl) {
                if (!notesListEl) return;
                notesListEl.querySelectorAll('.video-call-session-ended-notes-row').forEach(r => {
                    r.classList.remove('is-expanded', 'is-collapsed');
                    if (r !== rowEl) r.classList.add('is-collapsed');
                });
                if (rowEl) {
                    rowEl.classList.add('is-expanded');
                    rowEl.classList.remove('is-collapsed');
                }
            }

            /* Attach dash feature and expand-on-focus to session-ended textareas */
            const sessionEndedTextareas = overlay.querySelectorAll('.video-call-session-ended-notes-textarea');
            sessionEndedTextareas.forEach(ta => {
                attachNotesDashToTextarea(ta, {
                    onFocusExtra: () => setSessionEndedNotesRowExpanded(ta.closest('.video-call-session-ended-notes-row')),
                });
                ta.addEventListener('blur', () => {
                    setTimeout(() => {
                        const notesSection = overlay.querySelector('.video-call-session-ended-notes');
                        if (notesSection && !notesSection.contains(document.activeElement)) {
                            notesListEl?.querySelectorAll('.video-call-session-ended-notes-row').forEach(r => {
                                r.classList.remove('is-expanded', 'is-collapsed');
                            });
                        }
                    }, 0);
                });
            });

            const returnBtn = overlay.querySelector('#session-ended-return-btn');
            if (returnBtn) {
                returnBtn.addEventListener('click', async () => {
                    if (isVet && aptRef) {
                        const textareas = overlay.querySelectorAll('.video-call-session-ended-notes-textarea');
                        if (textareas.length) {
                            const updatedNotes = {};
                            textareas.forEach(ta => {
                                const key = ta.dataset.notesKey;
                                if (key) updatedNotes[key] = (ta.value || '').trim();
                            });
                            try {
                                returnBtn.disabled = true;
                                returnBtn.textContent = 'Saving…';
                                await updateDoc(aptRef, {
                                    consultationNotes: updatedNotes,
                                    consultationNotesUpdatedAt: serverTimestamp(),
                                });
                            } catch (e) {
                                console.warn('Could not save final notes:', e);
                            }
                        }
                        /* After confirm: hide notes, show Return + Download Report */
                        const notesSection = overlay.querySelector('.video-call-session-ended-notes');
                        if (notesSection) notesSection.style.display = 'none';
                        const actionsEl = overlay.querySelector('#session-ended-actions');
                        if (actionsEl) {
                            actionsEl.innerHTML = `
                                <button type="button" class="video-call-session-ended-btn video-call-session-ended-btn--secondary" id="session-ended-download-report-btn"><i class="fa fa-file-pdf-o" aria-hidden="true"></i> Download Report</button>
                                <button type="button" class="video-call-session-ended-btn" id="session-ended-return-btn-2">Return to Appointment</button>
                            `;
                            const returnBtn2 = actionsEl.querySelector('#session-ended-return-btn-2');
                            if (returnBtn2) returnBtn2.addEventListener('click', () => { window.location.href = targetUrl; });
                            const downloadBtn = actionsEl.querySelector('#session-ended-download-report-btn');
                            if (downloadBtn && aptData) {
                                downloadBtn.addEventListener('click', () => triggerDownloadReport(overlay, aptData, startLabel, endLabel, downloadBtn));
                            }
                        }
                        return;
                    }
                    window.location.href = targetUrl;
                });
            }

            async function triggerDownloadReport(overlayEl, aptData, startLabel, endLabel, btnEl) {
                try {
                    btnEl.disabled = true;
                    btnEl.innerHTML = '<i class="fa fa-spinner fa-spin" aria-hidden="true"></i> Generating…';
                    const textareas = overlayEl.querySelectorAll('.video-call-session-ended-notes-textarea');
                    const consultationNotes = {};
                    if (textareas.length) {
                        textareas.forEach(ta => {
                            const key = ta.dataset.notesKey;
                            if (key) consultationNotes[key] = (ta.value || '').trim();
                        });
                    } else {
                        Object.assign(consultationNotes, notes);
                    }
                    const ownerId = aptData.ownerId;
                    const vetId = aptData.vetId;
                    const petId = aptData.petId;
                    let ownerProfile = {};
                    let vetProfile = {};
                    let petData = {};
                    if (ownerId) {
                        try {
                            const snap = await getDoc(doc(db, 'users', ownerId));
                            ownerProfile = snap.exists() ? snap.data() : {};
                        } catch (e) {
                            console.warn('Could not load owner profile:', e);
                        }
                    }
                    if (vetId) {
                        try {
                            const snap = await getDoc(doc(db, 'users', vetId));
                            vetProfile = snap.exists() ? snap.data() : {};
                        } catch (e) {
                            console.warn('Could not load vet profile:', e);
                        }
                    }
                    if (ownerId && petId) {
                        try {
                            const snap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
                            petData = snap.exists() ? snap.data() : {};
                        } catch (e) {
                            console.warn('Could not load pet data:', e);
                        }
                    }
                    const dateTimeStr = [startLabel, endLabel].filter(Boolean).join(' – ') || [aptData.dateStr, aptData.timeDisplay].filter(Boolean).join(' · ') || '—';
                    const blob = await generateConsultationPDF({
                        owner: { displayName: aptData.ownerName || ownerProfile.displayName, address: ownerProfile.address, email: aptData.ownerEmail || ownerProfile.email },
                        vet: { displayName: aptData.vetName || vetProfile.displayName, clinicName: aptData.clinicName || vetProfile.clinicName || vetProfile.clinic, clinicAddress: vetProfile.clinicAddress || vetProfile.address, clinicEmail: vetProfile.clinicEmail || vetProfile.email, licenseNumber: vetProfile.licenseNumber },
                        pet: { name: aptData.petName || petData.name, species: petData.species || aptData.petSpecies, breed: petData.breed, age: petData.age, weight: petData.weight, sex: petData.sex },
                        appointment: { title: aptData.title, reason: aptData.reason, dateStr: aptData.dateStr, timeDisplay: aptData.timeDisplay, slotStart: aptData.slotStart, slotEnd: aptData.slotEnd },
                        consultationNotes,
                        consultationDateTime: dateTimeStr,
                    });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `Consultation-Summary-${aptData.petName || 'Pet'}-${new Date().toISOString().slice(0, 10)}.pdf`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                } catch (e) {
                    console.error('PDF generation failed:', e);
                    btnEl.innerHTML = '<i class="fa fa-exclamation-triangle" aria-hidden="true"></i> Failed';
                } finally {
                    btnEl.disabled = false;
                    setTimeout(() => { btnEl.innerHTML = '<i class="fa fa-file-pdf-o" aria-hidden="true"></i> Download Report'; }, 2000);
                }
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
                    consultationNotes: opts.consultationNotes,
                    appointmentRef: opts.appointmentRef ?? appointmentRef,
                    appointmentData: appointmentData,
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
            if (signalingUnsubscribe) { signalingUnsubscribe(); signalingUnsubscribe = null; }
            if (videoCallUnsubscribe) { videoCallUnsubscribe(); videoCallUnsubscribe = null; }
            if (appointmentUnsubscribe) { appointmentUnsubscribe(); appointmentUnsubscribe = null; }
            const targetUrl = `${backUrl}${backUrl.includes('?') ? '&' : '?'}leftCall=1`;
            let redirected = false;
            const go = () => {
                if (redirected) return;
                redirected = true;
                window.location.href = targetUrl;
            };
            const forceRedirectTimer = setTimeout(go, 1500);
            updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                offer: deleteField(),
                answer: deleteField(),
                sessionId: nextSignalingSessionId(),
                updatedAt: serverTimestamp(),
            }).catch(() => {}).finally(() => {
                clearTimeout(forceRedirectTimer);
                go();
            });
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
                const notes = typeof getNotesFromForm === 'function' ? getNotesFromForm() : null;
                if (notes && appointmentRef) {
                    await updateDoc(appointmentRef, {
                        consultationNotes: notes,
                        consultationNotesUpdatedAt: serverTimestamp(),
                    }).catch(() => {});
                }
                const endedAt = serverTimestamp();
                await setDoc(videoCallRef, {
                    status: 'ended',
                    endedBy: user.uid,
                    endedAt,
                    updatedAt: serverTimestamp(),
                }, { merge: true }).catch(() => {});

                await clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));

                /* Mark appointment as completed for history (pet owner & vet) */
                if (appointmentRef && appointmentData) {
                    try {
                        await updateDoc(appointmentRef, {
                            status: 'completed',
                            completedAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                            videoSessionEndedAt: endedAt,
                        });
                        /* Update vet schedule slot to completed */
                        const vetId = appointmentData.vetId;
                        const dateStr = appointmentData.dateStr || appointmentData.date || '';
                        const slotStart = appointmentData.slotStart || appointmentData.timeStart || '';
                        if (vetId && dateStr && slotStart) {
                            const scheduleRef = doc(db, 'users', vetId, 'schedules', dateStr);
                            const schedSnap = await getDoc(scheduleRef);
                            if (schedSnap.exists()) {
                                const schedData = schedSnap.data();
                                const slots = schedData.slots || [];
                                const updated = slots.map((s) => {
                                    const matchById = (s.appointmentId || '') === appointmentId;
                                    const matchBySlot = slotStart && (normalizeTime(s.start) === normalizeTime(slotStart));
                                    if (matchById || matchBySlot) {
                                        return { ...s, status: 'completed' };
                                    }
                                    return s;
                                });
                                await setDoc(scheduleRef, { date: dateStr, slots: updated });
                            }
                        }
                    } catch (e) {
                        console.warn('Could not mark appointment/slot completed:', e);
                    }
                }
                // Session-ended system message docs are intentionally not written to the convo.
                const updatedSnap = await getDoc(videoCallRef);
                const updatedData = updatedSnap.exists() ? updatedSnap.data() : {};
                leaveRoom('callEnded=1', {
                    showSessionEnded: true,
                    endLabel: formatSessionDateTime(updatedData.endedAt),
                    isVet: true,
                    consultationNotes: notes,
                    appointmentRef,
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
        if (isVideoSessionEnded(appointmentData)) {
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            showSessionEndedOverlay('callEnded=1', {
                startLabel: formatSessionStartLabel(appointmentData),
                endLabel: formatSessionDateTime(appointmentData.videoSessionEndedAt),
                isVet,
                appointmentRef,
                appointmentData,
            });
            return;
        }
        const roomSnap = await getDoc(videoCallRef);
        if (roomSnap.exists() && roomSnap.data().status === 'ended') {
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            showSessionEndedOverlay('callEnded=1', { startLabel: formatSessionStartLabel(appointmentData), endLabel: formatSessionDateTime(roomSnap.data().endedAt), isVet, appointmentRef, appointmentData });
            return;
        }

        await loadRtcConfig();
        await getLocalStream();
        let joined = false;
        try {
            joined = await joinRoom();
        } catch (err) {
            console.error('joinRoom error:', err);
            const code = err && err.code;
            if (code === 'permission-denied') {
                showError('Could not join the call: Firestore blocked access (permission denied). Deploy the latest firestore.rules for this project, or confirm you are logged in as the pet owner or assigned vet for this appointment.');
            } else {
                showError('Could not join the call room. Please try again or reopen from your appointment.');
            }
            return;
        }
        if (!joined) {
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            const aptFresh = await getDoc(appointmentRef);
            const aptFreshData = aptFresh.exists() ? aptFresh.data() : {};
            const endedSnap = await getDoc(videoCallRef);
            const endedData = endedSnap.exists() ? endedSnap.data() : {};
            const endLabel = formatSessionDateTime(endedData.endedAt || aptFreshData.videoSessionEndedAt);
            showSessionEndedOverlay('callEnded=1', { startLabel: formatSessionStartLabel(appointmentData), endLabel, isVet, appointmentRef, appointmentData });
            return;
        }
        startCallDurationTimer();

        videoCallUnsubscribe = onSnapshot(videoCallRef, async (snap) => {
            if (!snap.exists()) return;
            const data = snap.data();
            if (data.status === 'ended') {
                if (sessionEndedHandled) return;
                sessionEndedHandled = true;
                clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
                getDoc(appointmentRef).then((aptSnap) => {
                    const ad = aptSnap.exists() ? aptSnap.data() : {};
                    const endLabel = formatSessionDateTime(data.endedAt || ad.videoSessionEndedAt);
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel, isVet, appointmentRef });
                }).catch(() => {
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatSessionDateTime(data.endedAt), isVet, appointmentRef });
                });
                return;
            }
            const participants = data.participants || {};
            const pids = Object.keys(participants).filter(k => participants[k]);
            remoteUid = pids.find(id => id !== user.uid) || null;
            isOfferer = (data.offererUid || pids[0]) === user.uid;
            if (data.sessionId) currentSignalingSessionId = data.sessionId;

            if (pids.length < 2) {
                setStatus('Waiting for the other participant…');
                setVisiblePhaseMessage('Waiting for the other participant…', 'fa-clock-o');
                setWaiting(true);
                showReconnectUI(false);
                if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
                pendingIceCandidates.length = 0;
                currentSignalingSessionId = nextSignalingSessionId();
                if (peerConnection) { peerConnection.close(); peerConnection = null; }
                if (remoteVideo) remoteVideo.srcObject = null;
                preferRelayTransport = false;
                updateDoc(videoCallRef, {
                    offer: deleteField(),
                    answer: deleteField(),
                    sessionId: currentSignalingSessionId,
                    updatedAt: serverTimestamp(),
                }).catch(() => {});
                return;
            }

            // Both participants are present; show an explicit in-between state before media connects.
            if (!connectionEstablished) {
                setStatus('Connecting…');
                setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                setWaiting(true);
            }

            /* Mark slot as ongoing when both participants are in the call (one-time) */
            if (pids.length >= 2 && !sessionOngoingSlotUpdated && appointmentData) {
                sessionOngoingSlotUpdated = true;
                const vetId = appointmentData.vetId;
                const dateStr = appointmentData.dateStr || appointmentData.date || '';
                const slotStart = appointmentData.slotStart || appointmentData.timeStart || '';
                if (vetId && dateStr && slotStart) {
                    const scheduleRef = doc(db, 'users', vetId, 'schedules', dateStr);
                    getDoc(scheduleRef).then((schedSnap) => {
                        if (schedSnap.exists()) {
                            const schedData = schedSnap.data();
                            const slots = schedData.slots || [];
                            const updated = slots.map((s) => {
                                const matchById = (s.appointmentId || '') === appointmentId;
                                const matchBySlot = slotStart && (normalizeTime(s.start) === normalizeTime(slotStart)) && ((s.status || 'booked') === 'booked' || (s.status || '') === 'ongoing');
                                if (matchById || matchBySlot) {
                                    return { ...s, status: 'ongoing' };
                                }
                                return s;
                            });
                            setDoc(scheduleRef, { date: dateStr, slots: updated }).catch((e) => console.warn('Could not set slot ongoing:', e));
                        }
                    }).catch(() => {});
                }
            }

            if (isOfferer && !data.offer) {
                connectionEstablished = false;
                setStatus('Establishing video…');
                setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                setWaiting(true);
                await createOffer();
                establishTimeoutId = setTimeout(() => {
                    if (!connectionEstablished && peerConnection) {
                        setStatus('Video taking longer than usual. You can try reconnecting.');
                        showReconnectUI(true);
                    }
                    establishTimeoutId = null;
                }, ESTABLISH_TIMEOUT_MS);
                return;
            }
            if (!isOfferer && data.offer && !peerConnection) {
                connectionEstablished = false;
                setStatus('Establishing video…');
                setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                setWaiting(true);
                await handleOffer(data.offer, data.sessionId || null);
                establishTimeoutId = setTimeout(() => {
                    if (!connectionEstablished && peerConnection) {
                        setStatus('Video taking longer than usual. You can try reconnecting.');
                        showReconnectUI(true);
                    }
                    establishTimeoutId = null;
                }, ESTABLISH_TIMEOUT_MS);
                return;
            }
            if (isOfferer && data.answer && peerConnection) {
                await handleAnswer(data.answer, data.sessionId || null);
                if (!connectionEstablished) {
                    setStatus('Establishing video…');
                    setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                    setWaiting(true);
                }
            }
        });

        appointmentUnsubscribe = onSnapshot(appointmentRef, (aptSnap) => {
            if (sessionEndedHandled) return;
            if (!aptSnap.exists()) return;
            const ad = aptSnap.data();
            if (!isVideoSessionEnded(ad)) return;
            sessionEndedHandled = true;
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatSessionDateTime(ad.videoSessionEndedAt), isVet, appointmentRef });
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
                const data = snap.exists() ? snap.data() : {};
                const aptSnap = await getDoc(appointmentRef);
                const ad = aptSnap.exists() ? aptSnap.data() : {};
                const sessionEnded = data.status === 'ended' || isVideoSessionEnded(ad);
                if (sessionEnded && !sessionEndedHandled) {
                    sessionEndedHandled = true;
                    clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
                    const endLabel = formatSessionDateTime(data.endedAt || ad.videoSessionEndedAt);
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel, isVet, appointmentRef });
                    return;
                }
                // If tab was hidden, connection may have stalled. Check WebRTC state and offer reconnect.
                if (peerConnection && !sessionEnded) {
                    const ice = peerConnection.iceConnectionState;
                    const conn = peerConnection.connectionState;
                    if (ice === 'failed' || conn === 'failed' || (ice === 'disconnected' && !connectionEstablished)) {
                        setStatus('Connection may have stalled. Try reconnecting.');
                        showReconnectUI(true);
                    }
                }
            } catch (e) { console.warn('visibilitychange status check failed:', e); }
        });
    });
}
