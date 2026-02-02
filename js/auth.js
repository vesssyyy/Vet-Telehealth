/**
 * Televet Health — Firebase Authentication
 */

import { auth, db } from './firebase-config.js';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    sendEmailVerification,
    sendPasswordResetEmail,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const DOM = {
        tabLogin: $('tab-login'),
        tabSignup: $('tab-signup'),
        panelLogin: $('panel-login'),
        panelSignup: $('panel-signup'),
        formLogin: $('form-login'),
        signupStepForm: $('signup-step-form'),
        signupStepActivate: $('signup-step-activate'),
        forgotPasswordSection: $('forgot-password-section')
    };

    // Utility: Manage button loading state
    const setButtonState = (btn, isLoading, loadingText, defaultText) => {
        btn.disabled = isLoading;
        btn.textContent = isLoading ? loadingText : defaultText;
    };

    // Utility: Handle authentication errors
    const getErrorMessage = (error, errorMap) => {
        console.error(error);
        return errorMap[error.code] || `Operation failed: ${error.message}`;
    };

    // Tab switching
    const showTab = (tab) => {
        const isLogin = tab === 'login';
        [DOM.tabLogin, DOM.panelLogin].forEach(el => el.classList.toggle('active', isLogin));
        [DOM.tabSignup, DOM.panelSignup].forEach(el => el.classList.toggle('active', !isLogin));
        isLogin ? showLoginForm() : resetSignupForm();
    };

    const showLoginForm = () => {
        DOM.formLogin.classList.remove('hidden');
        DOM.forgotPasswordSection.classList.add('hidden');
    };

    const showForgotPasswordForm = () => {
        DOM.formLogin.classList.add('hidden');
        DOM.forgotPasswordSection.classList.remove('hidden');
        $('forgot_email').value = '';
    };

    const resetSignupForm = () => {
        DOM.signupStepForm.classList.remove('hidden');
        DOM.signupStepActivate?.classList.add('hidden');
        ['signup_fname', 'signup_lname', 'signup_pass', 'signup_confirm', 'signup_email']
            .forEach(id => $(id).value = '');
    };

    // Sync email verification status to Firestore
    const syncEmailVerification = async (uid) => {
        const userDoc = await getDoc(doc(db, 'users', uid));
        if (userDoc.exists() && !userDoc.data().emailVerified) {
            await updateDoc(doc(db, 'users', uid), {
                emailVerified: true,
                verifiedAt: serverTimestamp()
            });
            return true;
        }
        return false;
    };

    // Navigate based on user role
    const navigateByRole = (role, displayName) => {
        if (role === 'vet') {
            alert(`Welcome back, Dr. ${displayName}! (Vet dashboard coming soon)`);
        } else {
            window.location.href = 'dashboard.html';
        }
    };

    // Create user account
    const createAccount = async () => {
        const fields = {
            fname: $('signup_fname').value.trim(),
            lname: $('signup_lname').value.trim(),
            pass: $('signup_pass').value,
            confirm: $('signup_confirm').value,
            email: $('signup_email').value.trim()
        };

        // Validation
        if (!fields.fname || !fields.lname) return alert('Please enter your full name.');
        if (!fields.pass) return alert('Please enter a password.');
        if (fields.pass.length < 6) return alert('Password must be at least 6 characters.');
        if (fields.pass !== fields.confirm) return alert('Passwords do not match.');
        if (!fields.email) return alert('Please enter your email.');

        const btn = $('btn-create-account');
        setButtonState(btn, true, 'Creating Account...', 'Create Account');

        try {
            const { user } = await createUserWithEmailAndPassword(auth, fields.email, fields.pass);
            await Promise.all([
                sendEmailVerification(user, {
                    url: `${window.location.origin}${window.location.pathname}?verified=true`,
                    handleCodeInApp: false
                }),
                setDoc(doc(db, 'users', user.uid), {
                    email: fields.email,
                    firstName: fields.fname,
                    lastName: fields.lname,
                    displayName: `${fields.fname} ${fields.lname}`,
                    role: 'petOwner',
                    createdAt: serverTimestamp(),
                    emailVerified: false
                })
            ]);

            DOM.signupStepForm.classList.add('hidden');
            DOM.signupStepActivate.classList.remove('hidden');
        } catch (error) {
            const messages = {
                'auth/email-already-in-use': 'Email already registered. Please log in.',
                'auth/invalid-email': 'Invalid email address.',
                'auth/weak-password': 'Password too weak. Use at least 6 characters.'
            };
            alert(getErrorMessage(error, messages));
        } finally {
            setButtonState(btn, false, '', 'Create Account');
        }
    };

    // Google Sign-In
    const handleGoogleSignIn = async (btn) => {
        btn.disabled = true;
        const originalHTML = btn.innerHTML;
        btn.textContent = 'Signing in...';

        try {
            const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc = await getDoc(userDocRef);

            if (!userDoc.exists()) {
                const [firstName = '', ...rest] = (user.displayName || '').split(' ');
                await setDoc(userDocRef, {
                    email: user.email,
                    firstName,
                    lastName: rest.join(' ') || '',
                    displayName: user.displayName || user.email,
                    role: 'petOwner',
                    createdAt: serverTimestamp(),
                    emailVerified: user.emailVerified,
                    photoURL: user.photoURL || null
                });
                window.location.href = 'dashboard.html';
            } else {
                navigateByRole(userDoc.data().role, userDoc.data().displayName);
            }
        } catch (error) {
            const messages = {
                'auth/popup-closed-by-user': 'Sign-in was cancelled.',
                'auth/popup-blocked': 'Pop-up blocked. Please allow pop-ups.',
                'auth/unauthorized-domain': 'Domain not authorized in Firebase Console.'
            };
            alert(getErrorMessage(error, messages));
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        }
    };

    // Email/Password Login
    const handleLogin = async (e) => {
        e.preventDefault();
        const email = $('login_email').value.trim();
        const password = $('login_pass').value;

        if (!email || !password) return alert('Please enter both email and password.');

        const btn = e.target.querySelector('button[type="submit"]');
        setButtonState(btn, true, 'Logging in...', 'Login');

        try {
            const { user } = await signInWithEmailAndPassword(auth, email, password);

            if (!user.emailVerified) {
                alert('Please verify your email before logging in.');
                await auth.signOut();
                return;
            }

            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (!userDoc.exists()) return alert('User profile not found. Contact support.');

            // Sync email verification status if needed
            if (user.emailVerified && !userDoc.data().emailVerified) {
                await syncEmailVerification(user.uid);
            }

            navigateByRole(userDoc.data().role, userDoc.data().displayName);
        } catch (error) {
            const messages = {
                'auth/invalid-credential': 'Invalid email or password.',
                'auth/user-not-found': 'Invalid email or password.',
                'auth/wrong-password': 'Invalid email or password.',
                'auth/invalid-email': 'Invalid email address.',
                'auth/too-many-requests': 'Too many failed attempts. Try again later.'
            };
            alert(getErrorMessage(error, messages));
        } finally {
            setButtonState(btn, false, '', 'Login');
        }
    };

    // Password Reset
    const handlePasswordReset = async () => {
        const email = $('forgot_email').value.trim();
        if (!email) return alert('Please enter your email address.');

        const btn = $('btn-send-reset');
        setButtonState(btn, true, 'Sending...', btn.textContent);

        try {
            await sendPasswordResetEmail(auth, email);
            alert('If an account exists with this email, a reset link has been sent.');
            showLoginForm();
        } catch (error) {
            alert(error.code === 'auth/invalid-email' 
                ? 'Invalid email address.' 
                : 'If an account exists with this email, a reset link has been sent.');
        } finally {
            setButtonState(btn, false, '', 'Send Reset Link');
        }
    };

    // Event Listeners
    const init = () => {
        if (!DOM.tabLogin || !DOM.tabSignup) return;

        DOM.tabLogin.addEventListener('click', () => showTab('login'));
        DOM.tabSignup.addEventListener('click', () => showTab('signup'));
        DOM.formLogin?.addEventListener('submit', handleLogin);
        $('form-signup')?.addEventListener('submit', e => e.preventDefault());
        $('btn-create-account')?.addEventListener('click', createAccount);
        $('btn-back-email')?.addEventListener('click', () => {
            DOM.signupStepActivate.classList.add('hidden');
            DOM.signupStepForm.classList.remove('hidden');
        });
        $('btn-google-login')?.addEventListener('click', e => handleGoogleSignIn(e.target));
        $('btn-google-signup')?.addEventListener('click', e => handleGoogleSignIn(e.target));
        $('btn-forgot-password')?.addEventListener('click', showForgotPasswordForm);
        $('btn-back-to-login')?.addEventListener('click', showLoginForm);
        $('btn-send-reset')?.addEventListener('click', handlePasswordReset);
    };

    // Handle email verification redirect
    onAuthStateChanged(auth, async (user) => {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('verified') === 'true' && user) {
            await user.reload();
            if (auth.currentUser.emailVerified && await syncEmailVerification(user.uid)) {
                alert('Email verified successfully! You can now log in.');
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }
    });

    // Initialize
    document.readyState === 'loading' 
        ? document.addEventListener('DOMContentLoaded', init)
        : init();
})();
