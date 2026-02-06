/**
 * Televet Health — Firebase Authentication
 */
import { auth, db } from './firebase-config.js';
import {
    createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
    GoogleAuthProvider, sendEmailVerification, sendPasswordResetEmail, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const AUTH_ERRORS = {
        'auth/email-already-in-use': 'Email already registered. Please log in.',
        'auth/invalid-email': 'Invalid email address.',
        'auth/weak-password': 'Password too weak. Use at least 6 characters.',
        'auth/invalid-credential': 'Invalid email or password.',
        'auth/user-not-found': 'Invalid email or password.',
        'auth/wrong-password': 'Invalid email or password.',
        'auth/too-many-requests': 'Too many failed attempts. Try again later.',
        'auth/popup-closed-by-user': 'Sign-in was cancelled.',
        'auth/popup-blocked': 'Pop-up blocked. Please allow pop-ups.',
        'auth/unauthorized-domain': 'Domain not authorized in Firebase Console.'
    };

    const DOM = {
        tabLogin: $('tab-login'), tabSignup: $('tab-signup'),
        panelLogin: $('panel-login'), panelSignup: $('panel-signup'),
        formLogin: $('form-login'), signupStepForm: $('signup-step-form'),
        signupStepActivate: $('signup-step-activate'), forgotPasswordSection: $('forgot-password-section')
    };

    const withButtonState = async (btn, loadingText, callback) => {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = loadingText;
        try { return await callback(); }
        finally { btn.disabled = false; btn.innerHTML = original; }
    };

    const createUserDoc = async (uid, { email, firstName, lastName, displayName, emailVerified, photoURL = null }) => {
        await setDoc(doc(db, 'users', uid), {
            email, firstName, lastName, displayName: displayName || `${firstName} ${lastName}`,
            role: 'petOwner', createdAt: serverTimestamp(), emailVerified, photoURL
        });
    };

    const PENDING_PROFILE_KEY = 'telehealthSignupProfile';
    let isGoogleSignInInProgress = false;

    const storePendingProfile = (profile) => sessionStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(profile));
    const readPendingProfile = () => {
        try { return JSON.parse(sessionStorage.getItem(PENDING_PROFILE_KEY) || 'null'); }
        catch { return null; }
    };
    const clearPendingProfile = () => sessionStorage.removeItem(PENDING_PROFILE_KEY);

    const syncEmailVerification = async (uid) => {
        const userDoc = await getDoc(doc(db, 'users', uid));
        if (userDoc.exists() && !userDoc.data().emailVerified) {
            await updateDoc(doc(db, 'users', uid), { emailVerified: true, verifiedAt: serverTimestamp() });
            return true;
        }
        return false;
    };

    const redirectToDashboard = () => {
        sessionStorage.removeItem('telehealthLoggedOut');
        window.location.replace('petowner/dashboard.html');
    };

    const handleAuthenticatedUser = async (user) => {
        let userDoc = await getDoc(doc(db, 'users', user.uid));
        if (!userDoc.exists()) {
            const pendingProfile = readPendingProfile();
            const profile = pendingProfile && pendingProfile.email === user.email ? pendingProfile : {
                email: user.email, firstName: '', lastName: '',
                displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'Pet Owner')
            };
            try {
                await createUserDoc(user.uid, {
                    email: profile.email, firstName: profile.firstName || '', lastName: profile.lastName || '',
                    displayName: profile.displayName, emailVerified: user.emailVerified, photoURL: user.photoURL || null
                });
                clearPendingProfile();
                userDoc = await getDoc(doc(db, 'users', user.uid));
            } catch (err) {
                console.error('User profile creation error:', err);
                return alert('Profile creation failed. Please try again or contact support.');
            }
        }
        if (user.emailVerified && !userDoc.data().emailVerified) await syncEmailVerification(user.uid);
        const { role, displayName } = userDoc.data();
        role === 'vet' ? alert(`Welcome back, Dr. ${displayName}! (Vet dashboard coming soon)`) : redirectToDashboard();
    };

    const showTab = (tab) => {
        const isLogin = tab === 'login';
        DOM.tabLogin.classList.toggle('active', isLogin);
        DOM.tabSignup.classList.toggle('active', !isLogin);
        DOM.panelLogin.classList.toggle('active', isLogin);
        DOM.panelSignup.classList.toggle('active', !isLogin);
        if (isLogin) {
            DOM.formLogin.classList.remove('hidden');
            DOM.forgotPasswordSection.classList.add('hidden');
        } else {
            DOM.signupStepForm.classList.remove('hidden');
            DOM.signupStepActivate?.classList.add('hidden');
            ['signup_fname', 'signup_lname', 'signup_pass', 'signup_confirm', 'signup_email'].forEach(id => $(id).value = '');
        }
    };

    const createAccount = async () => {
        const [fname, lname, pass, confirm, email] = ['signup_fname', 'signup_lname', 'signup_pass', 'signup_confirm', 'signup_email'].map(id => $(id).value.trim());
        if (!fname || !lname) return alert('Please enter your full name.');
        if (!pass || pass.length < 6) return alert('Password must be at least 6 characters.');
        if (pass !== confirm) return alert('Passwords do not match.');
        if (!email) return alert('Please enter your email.');

        await withButtonState($('btn-create-account'), 'Creating Account...', async () => {
            sessionStorage.setItem('telehealthSignupPending', 'true');
            storePendingProfile({ email, firstName: fname, lastName: lname, displayName: `${fname} ${lname}`.trim() });
            try {
                const { user } = await createUserWithEmailAndPassword(auth, email, pass);
                await sendEmailVerification(user, { url: `${window.location.origin}${window.location.pathname}?verified=true` });
                await createUserDoc(user.uid, { email, firstName: fname, lastName: lname, emailVerified: false });
                DOM.signupStepForm.classList.add('hidden');
                DOM.signupStepActivate.classList.remove('hidden');
                clearPendingProfile();
                await auth.signOut();
            } catch (error) {
                console.error('Sign-up error:', error);
                alert(AUTH_ERRORS[error.code] || 'Sign-up failed. Please try again.');
                if (auth.currentUser) await auth.signOut();
            } finally {
                sessionStorage.removeItem('telehealthSignupPending');
            }
        });
    };

    const handleGoogleSignIn = async (btn) => {
        isGoogleSignInInProgress = true;
        await withButtonState(btn, 'Signing in...', async () => {
            try {
                const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                if (!userDoc.exists()) {
                    const [firstName = '', ...rest] = (user.displayName || '').split(' ');
                    await createUserDoc(user.uid, {
                        email: user.email, firstName, lastName: rest.join(' '),
                        displayName: user.displayName || user.email, emailVerified: user.emailVerified, photoURL: user.photoURL
                    });
                    isGoogleSignInInProgress = false;
                    redirectToDashboard();
                } else {
                    isGoogleSignInInProgress = false;
                    await handleAuthenticatedUser(user);
                }
            } catch (error) {
                isGoogleSignInInProgress = false;
                console.error('Google sign-in error:', error);
                alert(AUTH_ERRORS[error.code] || `Google sign-in failed: ${error.message}`);
            }
        });
    };

    const handleLogin = async (e) => {
        e.preventDefault();
        const [email, password] = ['login_email', 'login_pass'].map(id => $(id).value.trim());
        if (!email || !password) return alert('Please enter both email and password.');
        await withButtonState(e.target.querySelector('button[type="submit"]'), 'Logging in...', async () => {
            try {
                const { user } = await signInWithEmailAndPassword(auth, email, password);
                if (!user.emailVerified) {
                    alert('Please verify your email before logging in.');
                    return await auth.signOut();
                }
                await handleAuthenticatedUser(user);
            } catch (error) {
                console.error('Login error:', error);
                alert(AUTH_ERRORS[error.code] || `Login failed: ${error.message}`);
            }
        });
    };

    const handlePasswordReset = async () => {
        const email = $('forgot_email').value.trim();
        if (!email) return alert('Please enter your email address.');
        await withButtonState($('btn-send-reset'), 'Sending...', async () => {
            try {
                await sendPasswordResetEmail(auth, email);
                alert('If an account exists with this email, a reset link has been sent.');
                showTab('login');
            } catch (error) {
                console.error('Password reset error:', error);
                alert(AUTH_ERRORS[error.code] || 'If an account exists with this email, a reset link has been sent.');
            }
        });
    };

    const init = () => {
        if (!DOM.tabLogin) return;
        DOM.tabLogin.addEventListener('click', () => showTab('login'));
        DOM.tabSignup.addEventListener('click', () => showTab('signup'));
        DOM.formLogin?.addEventListener('submit', handleLogin);
        $('btn-create-account')?.addEventListener('click', createAccount);
        $('btn-back-email')?.addEventListener('click', () => { DOM.signupStepActivate.classList.add('hidden'); DOM.signupStepForm.classList.remove('hidden'); });
        $('btn-google-login')?.addEventListener('click', e => handleGoogleSignIn(e.target));
        $('btn-google-signup')?.addEventListener('click', e => handleGoogleSignIn(e.target));
        $('btn-forgot-password')?.addEventListener('click', () => {
            DOM.formLogin.classList.add('hidden');
            DOM.forgotPasswordSection.classList.remove('hidden');
            $('forgot_email').value = '';
        });
        $('btn-back-to-login')?.addEventListener('click', () => showTab('login'));
        $('btn-send-reset')?.addEventListener('click', handlePasswordReset);
        showTab(window.location.hash === '#signup' ? 'signup' : 'login');
    };

    onAuthStateChanged(auth, async (user) => {
        const isVerificationRedirect = new URLSearchParams(window.location.search).get('verified') === 'true';
        const isSignupPending = sessionStorage.getItem('telehealthSignupPending') === 'true';
        if (isGoogleSignInInProgress) return;
        if (isVerificationRedirect && user) {
            await user.reload();
            if (auth.currentUser.emailVerified && await syncEmailVerification(user.uid)) {
                alert('Email verified successfully! You can now log in.');
                window.history.replaceState({}, document.title, window.location.pathname);
                redirectToDashboard();
            }
        } else if (user && isSignupPending) return;
        else if (user && !user.emailVerified) { await auth.signOut(); return; }
        else if (user) redirectToDashboard();
    });

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
