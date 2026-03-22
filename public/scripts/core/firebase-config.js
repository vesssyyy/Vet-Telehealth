/**
 * Firebase Configuration & Initialization
 *
 * Ngrok / local tunnel: your page origin becomes e.g. https://abc.ngrok-free.app
 * Firebase Auth only allows listed hosts. If login or Firestore “hangs” or fails:
 * 1) Firebase Console → Authentication → Settings → Authorized domains → add your host
 *    (e.g. abc.ngrok-free.app — no https://, no path)
 * 2) Google sign-in: Google Cloud Console → APIs & Services → Credentials →
 *    Web client (same as Firebase) → Authorized JavaScript origins →
 *    add https://abc.ngrok-free.app
 * 3) Free ngrok shows a browser warning page first; tap through it or use a reserved domain.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyBWq5DRjpBE-Lel1LnVnKnyjveJJRL9v2c",
    authDomain: "vet-telehealth-891d6.firebaseapp.com",
    projectId: "vet-telehealth-891d6",
    storageBucket: "vet-telehealth-891d6.firebasestorage.app",
    messagingSenderId: "1015333870556",
    appId: "1:1015333870556:web:1749a43723ecf3b0b88d19"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export { app };
export const auth = getAuth(app);
/** Auto long-polling helps mobile/proxy environments; force-long-poll can misbehave with some tunnels (e.g. ngrok + phone). */
export const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
});
export const storage = getStorage(app);

/** PayMongo publishable key (pk_test_…). Safe in the browser; Dashboard → Developers (test mode). */
export const paymongoPublicKey = 'pk_test_7XnWztuZbEe2bE4t7hQLAdXa';

if (typeof window !== 'undefined' && /ngrok/i.test(window.location.hostname)) {
    const h = window.location.hostname;
    console.info(
        `[Televet] Ngrok host "${h}": add it to Firebase → Authentication → Authorized domains ` +
            `(and to Google OAuth "Authorized JavaScript origins" as https://${h} if using Google sign-in).`
    );
}
