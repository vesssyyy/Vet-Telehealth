/**
 * Firebase Configuration & Initialization
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

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
export const auth = getAuth(app);
export const db = getFirestore(app);
