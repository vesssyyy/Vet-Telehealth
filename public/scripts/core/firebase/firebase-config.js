
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

/** PayMongo publishable keys are served via callable (payMongoGetClientConfig) from Functions params. */

if (typeof window !== 'undefined' && /ngrok/i.test(window.location.hostname)) {
    const h = window.location.hostname;
    console.info(
        `[Televet] Ngrok host "${h}": add it to Firebase → Authentication → Authorized domains ` +
            `(and to Google OAuth "Authorized JavaScript origins" as https://${h} if using Google sign-in).`
    );
}
