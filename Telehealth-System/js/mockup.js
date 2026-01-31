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
import { doc, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    // DOM Elements
    const $ = id => document.getElementById(id);
    const DOM = {
        tabLogin: $('tab-login'),
        tabSignup: $('tab-signup'),
        panelLogin: $('panel-login'),
        panelSignup: $('panel-signup'),
        formLogin: $('form-login'),
        formSignup: $('form-signup'),
        signupStepForm: $('signup-step-form'),
        signupStepActivate: $('signup-step-activate'),
        forgotPasswordSection: $('forgot-password-section')
    };


    // Tab switching
    function showTab(tab) {
        const isLogin = tab === 'login';
        DOM.tabLogin.classList.toggle('active', isLogin);
        DOM.tabSignup.classList.toggle('active', !isLogin);
        DOM.panelLogin.classList.toggle('active', isLogin);
        DOM.panelSignup.classList.toggle('active', !isLogin);
        if (isLogin) showLoginForm();
        else resetSignupForm();
    }

    // Login/Forgot Password toggle
    function showForgotPasswordForm() {
        DOM.formLogin.classList.add('hidden');
        DOM.forgotPasswordSection.classList.remove('hidden');
        $('forgot_email').value = '';
    }

    function showLoginForm() {
        DOM.formLogin.classList.remove('hidden');
        DOM.forgotPasswordSection.classList.add('hidden');
    }

    // Signup form reset
    function resetSignupForm() {
        DOM.signupStepForm.classList.remove('hidden');
        DOM.signupStepActivate?.classList.add('hidden');
        ['signup_fname', 'signup_lname', 'signup_pass', 'signup_confirm', 'signup_email']
            .forEach(id => $(id).value = '');
    }

    // Validate and create account
    async function createAccount() {
        const fname = $('signup_fname').value.trim();
        const lname = $('signup_lname').value.trim();
        const pass = $('signup_pass').value;
        const confirm = $('signup_confirm').value;
        const email = $('signup_email').value.trim();

        if (!fname || !lname) return alert('Please enter your full name.');
        if (!pass) return alert('Please enter a password.');
        if (pass.length < 6) return alert('Password must be at least 6 characters.');
        if (pass !== confirm) return alert('Passwords do not match.');
        if (!email) return alert('Please enter your email.');

        const btn = $('btn-create-account');
        btn.disabled = true;
        btn.textContent = 'Creating Account...';

        try {
            const { user } = await createUserWithEmailAndPassword(auth, email, pass);
            await sendEmailVerification(user, {
                url: `${window.location.origin}/mockup.html?verified=true`,
                handleCodeInApp: false
            });
            await setDoc(doc(db, 'users', user.uid), {
                email, firstName: fname, lastName: lname,
                displayName: `${fname} ${lname}`,
                role: 'petOwner',
                createdAt: serverTimestamp(),
                emailVerified: false
            });

            DOM.signupStepForm.classList.add('hidden');
            DOM.signupStepActivate.classList.remove('hidden');
        } catch (error) {
            console.error('Sign-up error:', error);
            const messages = {
                'auth/email-already-in-use': 'Email already registered. Please log in.',
                'auth/invalid-email': 'Invalid email address.',
                'auth/weak-password': 'Password too weak. Use at least 6 characters.'
            };
            alert(messages[error.code] || 'Sign-up failed. Please try again.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Create Account';
        }
    }


    // Google Sign-In
    async function handleGoogleSignIn(btn) {
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
                const { role, displayName } = userDoc.data();
                if (role === 'vet') {
                    alert(`Welcome back, Dr. ${displayName}! (Vet dashboard coming soon)`);
                } else {
                    window.location.href = 'dashboard.html';
                }
            }
        } catch (error) {
            console.error('Google sign-in error:', error);
            const messages = {
                'auth/popup-closed-by-user': 'Sign-in was cancelled.',
                'auth/popup-blocked': 'Pop-up blocked. Please allow pop-ups.',
                'auth/unauthorized-domain': 'Domain not authorized in Firebase Console.'
            };
            alert(messages[error.code] || `Google sign-in failed: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        }
    }


    // Handle Email/Password Login
    async function handleLogin(e) {
        e.preventDefault();
        const email = $('login_email').value.trim();
        const password = $('login_pass').value;

        if (!email || !password) return alert('Please enter both email and password.');

        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Logging in...';

        try {
            const { user } = await signInWithEmailAndPassword(auth, email, password);

            if (!user.emailVerified) {
                alert('Please verify your email before logging in.');
                await auth.signOut();
                return;
            }

            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (!userDoc.exists()) return alert('User profile not found. Contact support.');

            const { role, displayName } = userDoc.data();
            if (role === 'vet') {
                alert(`Welcome back, Dr. ${displayName}! (Vet dashboard coming soon)`);
            } else {
                window.location.href = 'dashboard.html';
            }
        } catch (error) {
            console.error('Login error:', error);
            const messages = {
                'auth/invalid-credential': 'Invalid email or password.',
                'auth/user-not-found': 'Invalid email or password.',
                'auth/wrong-password': 'Invalid email or password.',
                'auth/invalid-email': 'Invalid email address.',
                'auth/too-many-requests': 'Too many failed attempts. Try again later.'
            };
            alert(messages[error.code] || `Login failed: ${error.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Login';
        }
    }

    // Handle Password Reset
    async function handlePasswordReset() {
        const email = $('forgot_email').value.trim();
        if (!email) return alert('Please enter your email address.');

        const btn = $('btn-send-reset');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Sending...';

        try {
            await sendPasswordResetEmail(auth, email);
            alert('If an account exists with this email, a reset link has been sent.');
            showLoginForm();
        } catch (error) {
            console.error('Password reset error:', error);
            alert(error.code === 'auth/invalid-email' 
                ? 'Invalid email address.' 
                : 'If an account exists with this email, a reset link has been sent.');
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    // Event Listeners
    function init() {
        if (!DOM.tabLogin || !DOM.tabSignup) return;

        DOM.tabLogin.addEventListener('click', () => showTab('login'));
        DOM.tabSignup.addEventListener('click', () => showTab('signup'));
        DOM.formLogin?.addEventListener('submit', handleLogin);
        DOM.formSignup?.addEventListener('submit', e => e.preventDefault());
        
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
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
