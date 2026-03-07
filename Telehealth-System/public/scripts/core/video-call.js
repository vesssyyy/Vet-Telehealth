/**
 * Televet Health — Video call room (WebRTC + Firestore signaling)
 * Shared by petowner/video-call.html and vet/video-call.html
 */
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    addDoc,
    onSnapshot,
    serverTimestamp,
    deleteField,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const STUN_URL = 'stun:stun.l.google.com:19302';

function $(id) {
    return document.getElementById(id);
}

function getAppointmentId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('appointmentId') || '';
}

export function initVideoCallPage(options = {}) {
    const {
        backUrl = '../petowner/appointment.html',
        backLabel = 'Back to Appointments',
        loginUrl = '../index.html',
    } = options;

    const appointmentId = getAppointmentId();
    const statusEl = $('call-status');
    const waitingEl = $('waiting-message');
    const connectedEl = $('connected-message');

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }
    function showError(msg) {
        setStatus(msg);
        if (waitingEl) waitingEl.classList.add('is-hidden');
        if (connectedEl) connectedEl.classList.add('is-hidden');
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

        try {
            const aptSnap = await getDoc(appointmentRef);
            if (!aptSnap.exists()) {
                showError('Appointment not found.');
                return;
            }
            const appointmentData = aptSnap.data();
            const { vetId, ownerId } = appointmentData;
            if (user.uid !== vetId && user.uid !== ownerId) {
                showError('You do not have access to this consultation.');
                return;
            }
        } catch (e) {
            console.error(e);
            showError('Could not load appointment.');
            return;
        }

        const localVideo = $('local-video');
        const remoteVideo = $('remote-video');
        const hangUpBtn = $('hangup-btn');
        const backLink = $('back-link');

        if (backLink) {
            backLink.href = backUrl;
            backLink.textContent = backLabel;
        }

        let peerConnection = null;
        let localStream = null;
        let isOfferer = false;
        let remoteUid = null;
        let signalingUnsubscribe = null;

        function setWaiting(show) {
            if (waitingEl) waitingEl.classList.toggle('is-hidden', !show);
            if (connectedEl) connectedEl.classList.toggle('is-hidden', show);
        }

        function showErrorInner(msg) {
            setStatus(msg);
            setWaiting(false);
            if (connectedEl) connectedEl.classList.add('is-hidden');
        }

        async function getLocalStream() {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (localVideo) {
                    localVideo.srcObject = localStream;
                }
            } catch (e) {
                console.error('getUserMedia error:', e);
                showErrorInner('Could not access camera or microphone. Please allow access and try again.');
            }
        }

            function createPeerConnection() {
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: STUN_URL }],
            });
            if (localStream) {
                localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
            }
            pc.ontrack = (ev) => {
                if (remoteVideo && ev.streams && ev.streams[0]) {
                    remoteVideo.srcObject = ev.streams[0];
                }
            };
            pc.onicecandidate = (ev) => {
                if (ev.candidate) {
                    addDoc(signalingRef, {
                        from: user.uid,
                        candidate: JSON.stringify(ev.candidate),
                        createdAt: serverTimestamp(),
                    }).catch((err) => console.warn('ICE send error', err));
                }
            };
            return pc;
        }

        async function createOffer() {
            if (!peerConnection) peerConnection = createPeerConnection();
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await setDoc(videoCallRef, {
                offer: JSON.stringify(offer),
                offererUid: user.uid,
                updatedAt: serverTimestamp(),
            }, { merge: true });
        }

        async function handleOffer(offerStr) {
            if (!offerStr || peerConnection) return;
            const offer = JSON.parse(offerStr);
            peerConnection = createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await updateDoc(videoCallRef, {
                answer: JSON.stringify(answer),
                updatedAt: serverTimestamp(),
            });
        }

        async function handleAnswer(answerStr) {
            if (!answerStr || !peerConnection) return;
            const answer = JSON.parse(answerStr);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }

        async function handleIceCandidate(data) {
            if (data.from === user.uid || !peerConnection) return;
            try {
                const candidate = JSON.parse(data.candidate);
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.warn('addIceCandidate error', e);
            }
        }

        async function joinRoom() {
            const snap = await getDoc(videoCallRef);
            const participants = snap.exists() ? { ...(snap.data().participants || {}) } : {};
            participants[user.uid] = true;
            const participantIds = Object.keys(participants);
            const isFirst = participantIds.length === 1;
            const offererUid = snap.exists() && snap.data().offererUid ? snap.data().offererUid : (isFirst ? user.uid : null);

            await setDoc(videoCallRef, {
                participants,
                status: 'waiting',
                offererUid: offererUid || participantIds[0],
                updatedAt: serverTimestamp(),
            }, { merge: true });
        }

        function leaveRoom() {
            if (signalingUnsubscribe) signalingUnsubscribe();
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            if (localStream) {
                localStream.getTracks().forEach((t) => t.stop());
                localStream = null;
            }
            if (remoteVideo) remoteVideo.srcObject = null;
            if (localVideo) localVideo.srcObject = null;
            updateDoc(videoCallRef, {
                [`participants.${user.uid}`]: deleteField(),
                updatedAt: serverTimestamp(),
            }).catch(() => {}).finally(() => {
                window.location.href = backUrl;
            });
        }

        hangUpBtn?.addEventListener('click', leaveRoom);

        await getLocalStream();
        await joinRoom();

        onSnapshot(videoCallRef, async (snap) => {
            if (!snap.exists()) return;
            const data = snap.data();
            const participants = data.participants || {};
            const pids = Object.keys(participants).filter((k) => participants[k]);
            remoteUid = pids.find((id) => id !== user.uid) || null;
            const offererUid = data.offererUid || pids[0];
            isOfferer = offererUid === user.uid;

            if (pids.length < 2) {
                setStatus('Waiting for the other participant…');
                setWaiting(true);
                return;
            }

            setStatus('Connected');
            setWaiting(false);

            if (isOfferer && !data.offer && pids.length >= 2) {
                await createOffer();
                return;
            }
            if (!isOfferer && data.offer && !peerConnection) {
                await handleOffer(data.offer);
                return;
            }
            if (isOfferer && data.answer && peerConnection) {
                await handleAnswer(data.answer);
            }
        });

        signalingUnsubscribe = onSnapshot(signalingRef, (snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const d = change.doc.data();
                    handleIceCandidate(d);
                }
            });
        });
    });
}
