// Video consultation room: WebRTC media, Firestore signaling, notes, chat, session end (pet owner + vet pages).
import { app, auth, db } from '../../core/firebase/firebase-config.js';
import { escapeHtml } from '../../core/app/utils.js';
import { generateConsultationPDF } from '../../core/pdf/consultation-pdf.js';
import { uploadMessageAttachment, validateAttachment } from '../../core/messaging/attachments.js';
import { initVideoCallPanels } from './ui/panels.js';
import { wireMediaToggle } from './ui/media-toggles.js';
import { initVideoCallConvoCompose } from './messaging/convo-compose.js';
import { createVideoCallConvoRenderer, initVideoCallConvoLightbox } from './messaging/convo-ui.js';
import { resolveVideoCallConversation } from './messaging/convo-bindings.js';
import { clearSignalingCollection } from './signaling/firestore.js';
import { joinVideoCallRoom } from './signaling/room.js';
import { subscribeToSignalingIce, subscribeToVideoCallRoom } from './signaling/listeners.js';
import { loadRtcConfigFromBackend } from './rtc/ice-config.js';
import { getLocalStream as acquireLocalStream } from './rtc/local-media.js';
import { createRtcNegotiationHandlers } from './rtc/negotiation.js';
import { createVideoCallReconnectController } from './rtc/reconnect.js';
import { createVideoCallPeerConnection } from './rtc/peer.js';
import { createRtcOfferer } from './rtc/offerer.js';
import { createVideoCallConnectionStateHelpers } from './rtc/connection-state.js';
import { showVetLeaveEndModal as showVetLeaveEndModalFeature } from './session/vet-leave-end-modal.js';
import { createScheduleEndController } from './session/schedule-end.js';
import { showSessionEndedOverlay as showSessionEndedOverlayFeature } from './session/session-ended-overlay.js';
import { updateAssignedSlotStatus as updateAssignedSlotStatusFeature } from './data/slot-status.js';
import { idFromFirestoreField, loadVideoCallAppointmentContext } from './data/appointment.js';
import { populateVideoCallAppointmentUI } from './data/appointment-ui.js';
import { initVideoCallNotes } from './data/notes.js';
import {
    CONSULTATION_NOTES_FIELDS,
} from './utils/notes-fields.js';
import { attachNotesDashTextarea } from './utils/notes-dash-textarea.js';
import {
    formatAppointmentStartLabel,
    isVideoSessionEnded,
} from './utils/appointment-time.js';
import {
    formatFirestoreDateTime,
} from './utils/time.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    addDoc,
    query,
    orderBy,
    onSnapshot,
    serverTimestamp,
    deleteField,
    increment,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

// Default ICE servers; TURN can be loaded dynamically from Cloud Functions.
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
];

const DEFAULT_RTC_CONFIG = {
    iceServers: DEFAULT_ICE_SERVERS,
};

const $ = id => document.getElementById(id);
const appBasePrefix = (() => {
    const p = window.location.pathname || '';
    return p === '/public' || p.startsWith('/public/') ? '/public' : '';
})();
const withAppBase = (path) => `${appBasePrefix}${path}`;

const getAppointmentId = () => new URLSearchParams(window.location.search).get('appointmentId') || '';
const shouldForceRelay = () => new URLSearchParams(window.location.search).get('forceRelay') === '1';

export function initVideoCallPage(options = {}) {
    const {
        backUrl = '../petowner/appointment.html',
        loginUrl = withAppBase('/index.html'),
        onMessageClick = null,
    } = options;

    const appointmentId = getAppointmentId();
    const statusEl = $('call-status');
    const waitingEl = $('waiting-message');
    const connectedEl = $('connected-message');
    // Cleared when returning to waiting, on error, or media cleanup.
    let connectedLabelHideTimeoutId = null;

    const container    = $('video-call-container');
    const convoPanel   = $('video-call-convo-panel');
    const messageBtn   = $('message-btn');

    const panels = initVideoCallPanels({ $, onMessageClick });

    // Notes panel (vet only) — slides in from left like message, dashed border
    const notesPanel = $('video-call-notes-panel');

    const notesTextareas = CONSULTATION_NOTES_FIELDS.map(({ id }) => id);
    function resizeNotesTextarea(ta) {
        if (!ta) return;
        // Flex layout handles sizing; no manual height needed
    }
    function resetNotesFieldExpansion() {
        notesPanel?.querySelectorAll('.video-call-notes-field[data-notes-field]').forEach((field) => {
            field.classList.remove('is-expanded', 'is-collapsed');
            const textarea = field.querySelector('.video-call-notes-textarea');
            if (textarea) textarea.style.height = '';
        });
    }
    function setNotesFieldExpanded(fieldEl) {
        resetNotesFieldExpansion();
        notesPanel?.querySelectorAll('.video-call-notes-field[data-notes-field]').forEach((field) => {
            if (field !== fieldEl) field.classList.add('is-collapsed');
        });
        if (!fieldEl) return;
        fieldEl.classList.add('is-expanded');
        const textarea = fieldEl.querySelector('.video-call-notes-textarea');
        if (textarea) textarea.style.height = '';
    }

    notesTextareas.forEach(id => {
        const ta = $(id);
        if (ta) {
            attachNotesDashTextarea(ta, {
                onFocusExtra: () => setNotesFieldExpanded(ta.closest('.video-call-notes-field')),
            });
            ta.addEventListener('input', () => resizeNotesTextarea(ta));
            ta.addEventListener('blur', () => {
                setTimeout(() => {
                    if (!notesPanel?.contains(document.activeElement)) {
                        resetNotesFieldExpansion();
                    }
                }, 0);
            });
            ta.addEventListener('paste', () => setTimeout(() => { resizeNotesTextarea(ta); }, 0));
        }
    });
    const resizeAllNotesTextareas = () => notesTextareas.forEach(id => resizeNotesTextarea($(id)));
    $('notes-btn')?.addEventListener('click', () => setTimeout(resizeAllNotesTextareas, 50));

    const convoCompose = initVideoCallConvoCompose({ $ });

    const setStatus = text => { if (statusEl) statusEl.textContent = text; };
    function showError(msg) {
        if (connectedLabelHideTimeoutId) {
            clearTimeout(connectedLabelHideTimeoutId);
            connectedLabelHideTimeoutId = null;
        }
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
        let myPhotoURL = '';
        let otherPhotoURL = '';
        let rtcConfig = { ...DEFAULT_RTC_CONFIG };
        // Set after `initVideoCallNotes` in the load try block; used by schedule-end + vet leave modal.
        let getNotesFromForm;

        async function loadRtcConfig() {
            const forceRelay = shouldForceRelay();
            rtcConfig = await loadRtcConfigFromBackend({
                app,
                forceRelay,
                defaultRtcConfig: DEFAULT_RTC_CONFIG,
            });
        }

        async function updateAssignedSlotStatus(nextStatus, allowedCurrentStatuses = null) {
            return updateAssignedSlotStatusFeature({
                db,
                appointmentId,
                appointmentData,
                nextStatus,
                allowedCurrentStatuses,
            });
        }

        try {
            const appointmentCtx = await loadVideoCallAppointmentContext({
                appointmentRef,
                userUid: user.uid,
            });
            if (!appointmentCtx.ok && appointmentCtx.reason === 'not_found') {
                showError('Appointment not found.');
                return;
            }
            if (!appointmentCtx.ok && appointmentCtx.reason === 'forbidden') {
                showError('You do not have access to this consultation.');
                return;
            }
            appointmentData = appointmentCtx.appointmentData;
            const { vetId, ownerId } = appointmentData;
            isVet = !!appointmentCtx.isVet;
            isPetOwner = !!appointmentCtx.isPetOwner;

            const hydrated = await populateVideoCallAppointmentUI({
                db,
                user,
                appointmentData,
                isVet,
                isPetOwner,
                otherParticipantLabelEl,
                localVideoLabelEl,
                consultationTitleEl,
                consultationDatetimeEl,
                $,
            });
            const petName = hydrated.petName;
            const myName = hydrated.myName;
            const otherParticipantNameEl = hydrated.otherParticipantNameEl;
            myPhotoURL = hydrated.myPhotoURL || '';
            otherPhotoURL = hydrated.otherPhotoURL || '';

            // Vet: Clinical notes — auto-save, load saved notes, save on terminate
            const notesController = initVideoCallNotes({
                isVet,
                appointmentRef,
                appointmentData,
                notesTextareas,
                resizeNotesTextarea,
                $,
            });
            getNotesFromForm = notesController.getNotesFromForm;

            const ownerUid = ownerId;
            const vetUid = vetId;
            currentConvId = await resolveVideoCallConversation({
                db,
                userUid: user.uid,
                ownerUid,
                vetUid,
                petId: appointmentData.petId,
                petName,
                isVet,
                myName,
                otherParticipantName: otherParticipantNameEl?.textContent || '',
                idFromFirestoreField,
            });
        } catch (e) {
            console.error(e);
            showError('Could not load appointment.');
            return;
        }

        const { renderConvoMessages } = createVideoCallConvoRenderer({
            convoMessagesList,
            convoBody,
            isVet,
            uid: user.uid,
            sentAvatarUrl: myPhotoURL,
            receivedAvatarUrl: otherPhotoURL,
        });

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

        initVideoCallConvoLightbox({ $, convoBody });

        if (convoSendBtn && currentConvId) {
            convoSendBtn.addEventListener('click', async () => {
                const text = (convoCompose.getText() || '').trim();
                const pendingFile = convoCompose.getPendingFile();
                if (!text && !pendingFile) return;
                const payload = { senderId: user.uid, sentAt: serverTimestamp(), status: 'sending', text: text || null };
                let msgRef;
                try {
                    msgRef = await addDoc(collection(db, 'conversations', currentConvId, 'messages'), payload);
                } catch (err) {
                    console.error('Send message error:', err);
                    return;
                }
                convoCompose.clearText();
                if (pendingFile) {
                    const v = validateAttachment(pendingFile);
                    if (!v.ok) { convoCompose.clearConvoAttach(); return; }
                    try {
                        const attachData = await uploadMessageAttachment(pendingFile, currentConvId);
                        await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { attachment: attachData, status: 'sent' });
                    } catch (err) {
                        await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { status: 'sent' }).catch(() => {});
                    }
                    convoCompose.clearConvoAttach();
                } else {
                    await updateDoc(doc(db, 'conversations', currentConvId, 'messages', msgRef.id), { status: 'sent' }).catch(() => {});
                }
                const peerUnreadField = isVet ? 'unreadCount_owner' : 'unreadCount_vet';
                await updateDoc(doc(db, 'conversations', currentConvId), {
                    lastMessageAt: serverTimestamp(),
                    lastMessage: text || '(attachment)',
                    lastMessageSenderId: user.uid,
                    [peerUnreadField]: increment(1),
                }).catch(() => {});
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
        let remoteStream = null;
        let connectionEstablished = false;
        let establishTimeoutId = null;
        // mediaWatchdogTimeoutId moved to connectionState helpers
        const ESTABLISH_TIMEOUT_MS = 50000;
        let currentSignalingSessionId = null;
        let activePeerSessionId = null;
        let createOfferInFlight = false;
        let offeredSessionId = null;
        let preferRelayTransport = false;

        function nextSignalingSessionId() {
            return `${user.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        const CONNECTED_LABEL_VISIBLE_MS = 3000;

        function setWaiting(show) {
            waitingEl?.classList.toggle('is-hidden', !show);
            if (connectedLabelHideTimeoutId) {
                clearTimeout(connectedLabelHideTimeoutId);
                connectedLabelHideTimeoutId = null;
            }
            if (show) {
                connectedEl?.classList.add('is-hidden');
            } else {
                connectedEl?.classList.remove('is-hidden');
                connectedLabelHideTimeoutId = setTimeout(() => {
                    connectedEl?.classList.add('is-hidden');
                    connectedLabelHideTimeoutId = null;
                }, CONNECTED_LABEL_VISIBLE_MS);
            }
        }

        function setVisiblePhaseMessage(text, iconClass = 'fa-clock-o') {
            if (!waitingEl) return;
            waitingEl.innerHTML = `<i class="fa ${iconClass}" aria-hidden="true"></i> ${escapeHtml(text)}`;
        }

        const reconnectController = createVideoCallReconnectController({
            videoCallRef,
            appointmentData,
            remoteVideo,
            pendingIceCandidates,
            nextSignalingSessionId,
            getSessionEndedHandled: () => sessionEndedHandled,
            getPeerConnection: () => peerConnection,
            setPeerConnection: (pc) => { peerConnection = pc; },
            setConnectionEstablished: (v) => { connectionEstablished = v; },
            setCurrentSignalingSessionId: (v) => { currentSignalingSessionId = v; },
            setOfferedSessionId: (v) => { offeredSessionId = v; },
            setStatus,
            setVisiblePhaseMessage,
            setWaiting,
            auto: { maxAttempts: 5, baseMs: 1200 },
        });
        const showReconnectUI = reconnectController.showReconnectUI;
        const scheduleAutoReconnect = reconnectController.scheduleAutoReconnect;
        const triggerReconnect = reconnectController.triggerReconnect;
        const clearAutoReconnectTimer = reconnectController.clearAutoReconnectTimer;
        const resetAutoReconnectAttempts = reconnectController.resetAutoReconnectAttempts;

        const connectionState = createVideoCallConnectionStateHelpers({
            getRemoteStream: () => remoteStream,
            setRemoteStream: (s) => { remoteStream = s; },
            remoteVideo,
            getPeerConnection: () => peerConnection,
            setPeerConnection: (pc) => { peerConnection = pc; },
            setActivePeerSessionId: (v) => { activePeerSessionId = v; },
            setConnectionEstablished: (v) => { connectionEstablished = v; },
            pendingIceCandidates,
            scheduleAutoReconnect,
            setStatus,
            getSessionEndedHandled: () => sessionEndedHandled,
        });
        const clearMediaWatchdog = connectionState.clearMediaWatchdog;
        const armMediaWatchdog = connectionState.armMediaWatchdog;
        const resetPeerConnectionState = connectionState.resetPeerConnectionState;
        const ensureRemotePlayback = connectionState.ensureRemotePlayback;

        // scheduleAutoReconnect / triggerReconnect implemented by reconnectController.

        function createPeerConnection() {
            return createVideoCallPeerConnection({
                rtcConfig,
                getPreferRelayTransport: () => preferRelayTransport,
                localStream,
                signalingRef,
                userUid: user.uid,
                getCurrentSignalingSessionId: () => currentSignalingSessionId,
                remoteVideo,
                getRemoteStream: () => remoteStream,
                setRemoteStream: (s) => { remoteStream = s; },
                ensureRemotePlayback,
                setConnectionEstablished: (v) => { connectionEstablished = v; },
                clearMediaWatchdog,
                resetAutoReconnectAttempts,
                clearAutoReconnectTimer,
                setStatus,
                setWaiting,
                showReconnectUI,
                clearEstablishTimeout: () => {
                    if (establishTimeoutId) {
                        clearTimeout(establishTimeoutId);
                        establishTimeoutId = null;
                    }
                },
                setPreferRelayTransport: (v) => { preferRelayTransport = !!v; },
                setVisiblePhaseMessage,
                scheduleAutoReconnect,
                armMediaWatchdog,
            });
        }

        async function getLocalStream() {
            localStream = await acquireLocalStream({
                localVideo,
                onError: () => {
                    setStatus('Could not access camera or microphone. Please allow access and try again.');
                    setWaiting(false);
                },
            });
        }

        const createOffer = createRtcOfferer({
            videoCallRef,
            userUid: user.uid,
            appointmentData,
            nextSignalingSessionId,
            getCreateOfferInFlight: () => createOfferInFlight,
            setCreateOfferInFlight: (v) => { createOfferInFlight = v; },
            getCurrentSignalingSessionId: () => currentSignalingSessionId,
            setCurrentSignalingSessionId: (v) => { currentSignalingSessionId = v; },
            getOfferedSessionId: () => offeredSessionId,
            setOfferedSessionId: (v) => { offeredSessionId = v; },
            getPeerConnection: () => peerConnection,
            setPeerConnection: (pc) => { peerConnection = pc; },
            createPeerConnection,
            getActivePeerSessionId: () => activePeerSessionId,
            setActivePeerSessionId: (v) => { activePeerSessionId = v; },
            resetPeerConnectionState,
        });

        const {
            drainPendingIceCandidates,
            handleOffer,
            handleAnswer,
            handleIceCandidate,
        } = createRtcNegotiationHandlers({
            userUid: user.uid,
            videoCallRef,
            pendingIceCandidates,
            nextSignalingSessionId,
            getCurrentSignalingSessionId: () => currentSignalingSessionId,
            setCurrentSignalingSessionId: (v) => { currentSignalingSessionId = v; },
            getActivePeerSessionId: () => activePeerSessionId,
            setActivePeerSessionId: (v) => { activePeerSessionId = v; },
            getPeerConnection: () => peerConnection,
            setPeerConnection: (pc) => { peerConnection = pc; },
            createPeerConnection,
            resetPeerConnectionState,
        });

        // Returns true if joined, false if room was already ended.
        async function joinRoom() {
            const result = await joinVideoCallRoom({
                appointmentRef,
                videoCallRef,
                appointmentData,
                userUid: user.uid,
                nextSignalingSessionId,
            });
            if (!result || result.joined !== true) return false;
            currentSignalingSessionId = result.sessionId || nextSignalingSessionId();
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

        // Stop media tracks, close peer connection, clear videos, clear timer.
        function cleanupLocalMedia() {
            if (connectedLabelHideTimeoutId) {
                clearTimeout(connectedLabelHideTimeoutId);
                connectedLabelHideTimeoutId = null;
            }
            if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
            clearAutoReconnectTimer();
            if (callDurationInterval) { clearInterval(callDurationInterval); callDurationInterval = null; }
            if (peerConnection) { peerConnection.close(); peerConnection = null; }
            activePeerSessionId = null;
            if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
            if (remoteVideo) remoteVideo.srcObject = null;
            if (localVideo)  localVideo.srcObject  = null;
            showReconnectUI(false);
        }

        // Clean up call state (timer, peer, streams) and remove self from room. Does not redirect.
        function cleanupAndLeaveRoom() {
            cleanupLocalMedia();
            if (videoCallUnsubscribe) { videoCallUnsubscribe(); videoCallUnsubscribe = null; }
            if (appointmentUnsubscribe) { appointmentUnsubscribe(); appointmentUnsubscribe = null; }
            if (signalingUnsubscribe) { signalingUnsubscribe(); signalingUnsubscribe = null; }
            return updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                [`mediaStates.${user.uid}`]: deleteField(),
                updatedAt: serverTimestamp(),
            }).catch(() => {});
        }

        // Full-screen "Session Ended" overlay with start/end times and role-specific button. Vet: shows consultation notes for final review + Download PDF.
        async function showSessionEndedOverlay(redirectQuery, opts = {}) {
            const {
                startLabel = '—',
                endLabel = '—',
                isVet = false,
                consultationNotes = null,
                appointmentRef: aptRef = null,
                appointmentData: aptData = null,
            } = opts;
            await showSessionEndedOverlayFeature({
                redirectQuery,
                backUrl,
                isVet,
                startLabel,
                endLabel,
                consultationNotes,
                appointmentRef: aptRef,
                appointmentData: aptData,
                db,
                cleanupAndLeaveRoom,
            });
        }

        // Navigate away or show session-ended overlay; redirectQuery merges into backUrl (e.g. ?callEnded=1).
        function leaveRoom(redirectQuery = '', opts = {}) {
            const targetUrl = redirectQuery ? `${backUrl}${backUrl.includes('?') ? '&' : '?'}${redirectQuery.replace(/^\?/, '')}` : backUrl;
            if (opts.showSessionEnded) {
                showSessionEndedOverlay(redirectQuery, {
                    startLabel: opts.startLabel ?? formatAppointmentStartLabel(appointmentData),
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

        const scheduleEndController = createScheduleEndController({
            appointmentRef,
            videoCallRef,
            getAppointmentData: () => appointmentData,
            getSessionEndedHandled: () => sessionEndedHandled,
            setSessionEndedHandled: (v) => { sessionEndedHandled = v; },
            isVet,
            getNotesFromForm,
            updateAssignedSlotStatus,
            clearSignaling: () => clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e)),
            leaveRoom,
            formatEndLabel: formatFirestoreDateTime,
        });
        const clearScheduleEndWatchers = scheduleEndController.clearScheduleEndWatchers;
        const performScheduleEndCompletion = scheduleEndController.performScheduleEndCompletion;
        const finalizeConsultationForScheduleEnd = scheduleEndController.finalizeConsultationForScheduleEnd;
        const armScheduleEndCompletion = scheduleEndController.armScheduleEndCompletion;

        // Pet or vet temporarily leaves; session stays active, they can rejoin via same link.
        function leaveTemporary() {
            clearScheduleEndWatchers();
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
            (async () => {
                try {
                    await updateDoc(videoCallRef, {
                        [`participants.${user.uid}`]: deleteField(),
                        [`mediaStates.${user.uid}`]: deleteField(),
                        offer: deleteField(),
                        answer: deleteField(),
                        sessionId: nextSignalingSessionId(),
                        ...(appointmentData?.ownerId ? { offererUid: appointmentData.ownerId } : {}),
                        updatedAt: serverTimestamp(),
                    });
                } catch (e) {
                    console.warn('Leave: could not update video room:', e);
                }
                clearTimeout(forceRedirectTimer);
                try {
                    for (let attempt = 0; attempt < 5; attempt++) {
                        if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
                        if (await performScheduleEndCompletion({ showSessionEndedOverlay: false })) break;
                    }
                } catch (e) {
                    console.warn('Schedule end on leave:', e);
                }
                go();
            })();
        }

        // Vet only: show Leave Only / Terminate Call popup.
        function showVetLeaveEndModal() {
            showVetLeaveEndModalFeature({
                userUid: user.uid,
                appointmentRef,
                appointmentData,
                videoCallRef,
                updateAssignedSlotStatus,
                getNotesFromForm,
                leaveTemporary,
                clearSignaling: () => clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e)),
                leaveRoom,
                formatEndLabel: formatFirestoreDateTime,
            });
        }

        hangUpBtn?.addEventListener('click', () => {
            if (isVet) {
                showVetLeaveEndModal();
            } else {
                leaveTemporary();
            }
        });

        const localMicIndicator = $('local-mic-indicator');
        const localCamIndicator = $('local-cam-indicator');
        const remoteMicIndicator = $('remote-mic-indicator');
        const remoteCamIndicator = $('remote-cam-indicator');

        function setIndicatorState(indicatorEl, { enabled, iconOn, iconOff }) {
            if (!indicatorEl) return;
            const i = indicatorEl.querySelector('i');
            if (i) i.className = enabled ? iconOn : iconOff;
            indicatorEl.classList.toggle('is-off', !enabled);
        }

        async function publishLocalMediaState(patch = {}) {
            const audioTrack = localStream?.getAudioTracks?.()?.[0] || null;
            const videoTrack = localStream?.getVideoTracks?.()?.[0] || null;
            const audioEnabled = typeof patch.audioEnabled === 'boolean' ? patch.audioEnabled : !!audioTrack?.enabled;
            const videoEnabled = typeof patch.videoEnabled === 'boolean' ? patch.videoEnabled : !!videoTrack?.enabled;
            setIndicatorState(localMicIndicator, { enabled: audioEnabled, iconOn: 'fa fa-microphone', iconOff: 'fa fa-microphone-slash' });
            setIndicatorState(localCamIndicator, { enabled: videoEnabled, iconOn: 'fa fa-video-camera', iconOff: 'fa fa-ban' });
            await updateDoc(videoCallRef, {
                [`mediaStates.${user.uid}`]: {
                    audioEnabled,
                    videoEnabled,
                    updatedAt: serverTimestamp(),
                },
                updatedAt: serverTimestamp(),
            }).catch(() => {});
        }

        wireMediaToggle({
            $,
            btnId: 'mic-toggle',
            getTracks: () => localStream?.getAudioTracks() || [],
            icons: ['fa fa-microphone', 'fa fa-microphone-slash'],
            labels: ['Mute microphone', 'Unmute microphone'],
            onToggle: (enabled) => publishLocalMediaState({ audioEnabled: enabled }),
        });
        wireMediaToggle({
            $,
            btnId: 'video-toggle',
            getTracks: () => localStream?.getVideoTracks() || [],
            icons: ['fa fa-video-camera', 'fa fa-ban'],
            labels: ['Turn off camera', 'Turn on camera'],
            onToggle: (enabled) => publishLocalMediaState({ videoEnabled: enabled }),
        });

        // If the call was already terminated, don't join — show session ended and stop.
        if (isVideoSessionEnded(appointmentData)) {
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            showSessionEndedOverlay('callEnded=1', {
                startLabel: formatAppointmentStartLabel(appointmentData),
                endLabel: formatFirestoreDateTime(appointmentData.videoSessionEndedAt),
                isVet,
                appointmentRef,
                appointmentData,
            });
            return;
        }
        const roomSnap = await getDoc(videoCallRef);
        if (roomSnap.exists() && roomSnap.data().status === 'ended') {
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            showSessionEndedOverlay('callEnded=1', { startLabel: formatAppointmentStartLabel(appointmentData), endLabel: formatFirestoreDateTime(roomSnap.data().endedAt), isVet, appointmentRef, appointmentData });
            return;
        }

        await loadRtcConfig();
        await getLocalStream();
        // Publish initial state so the other side sees correct icons immediately.
        publishLocalMediaState().catch(() => {});
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
            const endLabel = formatFirestoreDateTime(endedData.endedAt || aptFreshData.videoSessionEndedAt);
            showSessionEndedOverlay('callEnded=1', { startLabel: formatAppointmentStartLabel(appointmentData), endLabel, isVet, appointmentRef, appointmentData });
            return;
        }
        startCallDurationTimer();
        armScheduleEndCompletion();

        videoCallUnsubscribe = subscribeToVideoCallRoom(videoCallRef, async (data) => {
            if (data.status === 'ended') {
                if (sessionEndedHandled) return;
                sessionEndedHandled = true;
                clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
                getDoc(appointmentRef).then((aptSnap) => {
                    const ad = aptSnap.exists() ? aptSnap.data() : {};
                    const endLabel = formatFirestoreDateTime(data.endedAt || ad.videoSessionEndedAt);
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel, isVet, appointmentRef });
                }).catch(() => {
                    leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatFirestoreDateTime(data.endedAt), isVet, appointmentRef });
                });
                return;
            }
            const participants = data.participants || {};
            const pids = Object.keys(participants).filter(k => participants[k]);
            remoteUid = pids.find(id => id !== user.uid) || null;

            const mediaStates = data.mediaStates || {};
            const remoteState = remoteUid ? (mediaStates[remoteUid] || null) : null;
            if (remoteState) {
                setIndicatorState(remoteMicIndicator, { enabled: remoteState.audioEnabled !== false, iconOn: 'fa fa-microphone', iconOff: 'fa fa-microphone-slash' });
                setIndicatorState(remoteCamIndicator, { enabled: remoteState.videoEnabled !== false, iconOn: 'fa fa-video-camera', iconOff: 'fa fa-ban' });
            } else {
                // Default to "enabled" unless we know otherwise.
                setIndicatorState(remoteMicIndicator, { enabled: true, iconOn: 'fa fa-microphone', iconOff: 'fa fa-microphone-slash' });
                setIndicatorState(remoteCamIndicator, { enabled: true, iconOn: 'fa fa-video-camera', iconOff: 'fa fa-ban' });
            }

            isOfferer = appointmentData?.ownerId
                ? user.uid === appointmentData.ownerId
                : (data.offererUid || pids[0]) === user.uid;
            if (data.sessionId) {
                if (currentSignalingSessionId && currentSignalingSessionId !== data.sessionId) {
                    offeredSessionId = null;
                }
                currentSignalingSessionId = data.sessionId;
            }
            if (
                data.sessionId &&
                activePeerSessionId &&
                activePeerSessionId !== data.sessionId &&
                peerConnection
            ) {
                resetPeerConnectionState();
            }

            if (pids.length < 2) {
                clearMediaWatchdog();
                setStatus('Waiting for the other participant…');
                setVisiblePhaseMessage('Waiting for the other participant…', 'fa-clock-o');
                setWaiting(true);
                showReconnectUI(false);
                if (establishTimeoutId) { clearTimeout(establishTimeoutId); establishTimeoutId = null; }
                pendingIceCandidates.length = 0;
                currentSignalingSessionId = nextSignalingSessionId();
                activePeerSessionId = null;
                offeredSessionId = null;
                createOfferInFlight = false;
                if (peerConnection) { peerConnection.close(); peerConnection = null; }
                if (remoteVideo) remoteVideo.srcObject = null;
                preferRelayTransport = false;
                updateDoc(videoCallRef, {
                    offer: deleteField(),
                    answer: deleteField(),
                    sessionId: currentSignalingSessionId,
                    ...(appointmentData?.ownerId ? { offererUid: appointmentData.ownerId } : {}),
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

            // Mark slot as ongoing when both participants are in the call (one-time)
            if (pids.length >= 2 && !sessionOngoingSlotUpdated && appointmentData) {
                sessionOngoingSlotUpdated = true;
                updateAssignedSlotStatus('ongoing', ['booked', 'ongoing']).catch((e) => console.warn('Could not set slot ongoing:', e));
            }

            // Recreate offer if we have no PC (e.g. sessionId changed and resetPeerConnectionState ran but Firestore still held a stale offer).
            const offererNeedsFreshOffer =
                !data.offer || (!peerConnection && !connectionEstablished);
            if (isOfferer && offererNeedsFreshOffer) {
                connectionEstablished = false;
                setStatus('Establishing video…');
                setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                setWaiting(true);
                try {
                    await createOffer();
                } catch (e) {
                    console.warn('createOffer failed:', e);
                    setStatus('Reconnecting…');
                    scheduleAutoReconnect('offer');
                    return;
                }
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
                try {
                    await handleOffer(data.offer, data.sessionId || null);
                } catch (e) {
                    console.warn('handleOffer failed:', e);
                    setStatus('Reconnecting…');
                    scheduleAutoReconnect('offer-answer');
                    return;
                }
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
                try {
                    await handleAnswer(data.answer, data.sessionId || null);
                } catch (e) {
                    console.warn('handleAnswer failed:', e);
                    setStatus('Reconnecting…');
                    scheduleAutoReconnect('answer');
                    return;
                }
                if (!connectionEstablished) {
                    setStatus('Establishing video…');
                    setVisiblePhaseMessage('Connecting…', 'fa-spinner fa-spin');
                    setWaiting(true);
                }
            }
        }, (err) => {
            console.warn('Video call room listener:', err);
        });

        appointmentUnsubscribe = onSnapshot(appointmentRef, (aptSnap) => {
            if (sessionEndedHandled) return;
            if (!aptSnap.exists()) return;
            const ad = aptSnap.data();
            if (!isVideoSessionEnded(ad)) return;
            sessionEndedHandled = true;
            clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
            leaveRoom('callEnded=1', { showSessionEnded: true, endLabel: formatFirestoreDateTime(ad.videoSessionEndedAt), isVet, appointmentRef });
        });

        signalingUnsubscribe = subscribeToSignalingIce(
            signalingRef,
            (iceData) => handleIceCandidate(iceData),
            (err) => console.warn('Video call signaling listener:', err)
        );

        // On mobile, Firebase listeners may pause when hidden. Re-check status on page restore.
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible' || sessionEndedHandled) return;
            try {
                await finalizeConsultationForScheduleEnd();
                if (sessionEndedHandled) return;
                const snap = await getDoc(videoCallRef);
                const data = snap.exists() ? snap.data() : {};
                const aptSnap = await getDoc(appointmentRef);
                const ad = aptSnap.exists() ? aptSnap.data() : {};
                const sessionEnded = data.status === 'ended' || isVideoSessionEnded(ad);
                if (sessionEnded && !sessionEndedHandled) {
                    sessionEndedHandled = true;
                    clearSignalingCollection(db, appointmentId).catch((e) => console.warn('Clear signaling:', e));
                    const endLabel = formatFirestoreDateTime(data.endedAt || ad.videoSessionEndedAt);
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

        window.addEventListener('pagehide', () => {
            updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                [`mediaStates.${user.uid}`]: deleteField(),
                updatedAt: serverTimestamp(),
            }).catch(() => {});
        });
    });
}

