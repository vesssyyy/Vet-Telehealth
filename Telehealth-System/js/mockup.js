/**
 * Televet Health — Auth UI with Firebase
 * Email/password auth, Google sign-in, role-based access
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
import {
    doc,
    setDoc,
    getDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

(function () {
    'use strict';

    const DOM = {
        tabLogin: document.getElementById('tab-login'),
        tabSignup: document.getElementById('tab-signup'),
        panelLogin: document.getElementById('panel-login'),
        panelSignup: document.getElementById('panel-signup'),
        formLogin: document.getElementById('form-login'),
        formSignup: document.getElementById('form-signup'),
        signupStepForm: document.getElementById('signup-step-form'),
        signupStepActivate: document.getElementById('signup-step-activate'),
        signupFname: document.getElementById('signup_fname'),
        signupLname: document.getElementById('signup_lname'),
        signupPass: document.getElementById('signup_pass'),
        signupConfirm: document.getElementById('signup_confirm'),
        signupEmail: document.getElementById('signup_email'),
        btnCreateAccount: document.getElementById('btn-create-account'),
        btnBackEmail: document.getElementById('btn-back-email'),
        btnGoogleLogin: document.getElementById('btn-google-login'),
        btnGoogleSignup: document.getElementById('btn-google-signup'),
        btnForgotPassword: document.getElementById('btn-forgot-password'),
        forgotPasswordSection: document.getElementById('forgot-password-section'),
        forgotEmail: document.getElementById('forgot_email'),
        btnSendReset: document.getElementById('btn-send-reset'),
        btnBackToLogin: document.getElementById('btn-back-to-login'),
    };

    function showTab(tab) {
        const isLogin = tab === 'login';
        DOM.tabLogin.classList.toggle('active', isLogin);
        DOM.tabSignup.classList.toggle('active', !isLogin);
        DOM.panelLogin.classList.toggle('active', isLogin);
        DOM.panelSignup.classList.toggle('active', !isLogin);

        if (isLogin) {
            // Reset to login form view when switching to login tab
            showLoginForm();
        } else {
            resetSignupSteps();
        }
    }

    function showForgotPasswordForm() {
        DOM.formLogin.classList.add('hidden');
        DOM.forgotPasswordSection.classList.remove('hidden');
        if (DOM.forgotEmail) DOM.forgotEmail.value = '';
    }

    function showLoginForm() {
        DOM.formLogin.classList.remove('hidden');
        DOM.forgotPasswordSection.classList.add('hidden');
    }

    function resetSignupSteps() {
        DOM.signupStepForm.classList.remove('hidden');
        if (DOM.signupStepActivate) DOM.signupStepActivate.classList.add('hidden');
        if (DOM.signupFname) DOM.signupFname.value = '';
        if (DOM.signupLname) DOM.signupLname.value = '';
        if (DOM.signupPass) DOM.signupPass.value = '';
        if (DOM.signupConfirm) DOM.signupConfirm.value = '';
        if (DOM.signupEmail) DOM.signupEmail.value = '';
    }

    async function showActivateStep() {
        const fname = DOM.signupFname?.value?.trim() || '';
        const lname = DOM.signupLname?.value?.trim() || '';
        const pass = DOM.signupPass?.value || '';
        const confirm = DOM.signupConfirm?.value || '';
        const email = DOM.signupEmail?.value?.trim() || '';

        if (!fname) {
            alert('Please enter your first name.');
            return;
        }
        if (!lname) {
            alert('Please enter your last name.');
            return;
        }
        if (!pass) {
            alert('Please enter a password.');
            return;
        }
        if (pass.length < 6) {
            alert('Password must be at least 6 characters.');
            return;
        }
        if (pass !== confirm) {
            alert('Passwords do not match.');
            return;
        }
        if (!email) {
            alert('Please enter your email address.');
            return;
        }

        // Disable button to prevent spam
        const createBtn = DOM.btnCreateAccount;
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.textContent = 'Creating Account...';
        }

        try {
            // Create Firebase Auth account
            const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
            const user = userCredential.user;

            // Configure action code settings for verification email
            const actionCodeSettings = {
                url: window.location.origin + '/mockup.html?verified=true',
                handleCodeInApp: false
            };

            // Send email verification with proper configuration
            await sendEmailVerification(user, actionCodeSettings);

            // Create user document in Firestore with petOwner role by default
            await setDoc(doc(db, 'users', user.uid), {
                email: email,
                firstName: fname,
                lastName: lname,
                displayName: `${fname} ${lname}`,
                role: 'petOwner', // Default role
                createdAt: serverTimestamp(),
                emailVerified: false
            });

            console.log('Account created successfully! Verification email sent.');

            // Show activation step
            DOM.signupStepForm.classList.add('hidden');
            if (DOM.signupStepActivate) DOM.signupStepActivate.classList.remove('hidden');

            // Re-enable button
            if (createBtn) {
                createBtn.disabled = false;
                createBtn.textContent = 'Create Account';
            }

        } catch (error) {
            console.error('Sign-up error:', error);
            let message = 'Sign-up failed. Please try again.';
            
            if (error.code === 'auth/email-already-in-use') {
                message = 'This email is already registered. Please log in instead.';
            } else if (error.code === 'auth/invalid-email') {
                message = 'Invalid email address.';
            } else if (error.code === 'auth/weak-password') {
                message = 'Password is too weak. Use at least 6 characters.';
            }
            
            alert(message);

            // Re-enable button
            if (createBtn) {
                createBtn.disabled = false;
                createBtn.textContent = 'Create Account';
            }
        }
    }

    function backToFormStep() {
        if (DOM.signupStepActivate) DOM.signupStepActivate.classList.add('hidden');
        DOM.signupStepForm.classList.remove('hidden');
    }

    async function handleGoogleSignIn(buttonElement) {
        const provider = new GoogleAuthProvider();
        
        // Disable button to prevent spam
        if (buttonElement) {
            buttonElement.disabled = true;
            const originalHTML = buttonElement.innerHTML;
            buttonElement.textContent = 'Signing in...';
            
            // Re-enable after timeout in case of error
            setTimeout(() => {
                if (buttonElement.disabled) {
                    buttonElement.disabled = false;
                    buttonElement.innerHTML = originalHTML;
                }
            }, 10000);
        }

        try {
            const result = await signInWithPopup(auth, provider);
            const user = result.user;

            // Check if user document exists
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc = await getDoc(userDocRef);

            if (!userDoc.exists()) {
                // New user - create document with petOwner role
                const nameParts = user.displayName?.split(' ') || ['', ''];
                await setDoc(userDocRef, {
                    email: user.email,
                    firstName: nameParts[0] || '',
                    lastName: nameParts.slice(1).join(' ') || '',
                    displayName: user.displayName || user.email,
                    role: 'petOwner', // Default role
                    createdAt: serverTimestamp(),
                    emailVerified: user.emailVerified,
                    photoURL: user.photoURL || null
                });

                console.log('New Google user created with petOwner role');
                console.log('Redirecting to dashboard...');
                window.location.href = 'dashboard.html';
            } else {
                // Existing user - redirect based on role
                const userData = userDoc.data();
                const role = userData.role;

                console.log('Existing user login. Role:', role);

                if (role === 'vet') {
                    console.log('Redirecting to vet dashboard...');
                    alert(`Welcome back, Dr. ${userData.displayName}! (Vet dashboard coming soon)`);
                    // TODO: window.location.href = 'vet-dashboard.html';
                    if (buttonElement) {
                        buttonElement.disabled = false;
                        buttonElement.innerHTML = originalHTML;
                    }
                } else {
                    console.log('Redirecting to pet owner dashboard...');
                    window.location.href = 'dashboard.html';
                }
            }

        } catch (error) {
            console.error('Google sign-in error:', error);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            let message = 'Google sign-in failed. Please try again.';
            
            if (error.code === 'auth/popup-closed-by-user') {
                message = 'Sign-in was cancelled.';
            } else if (error.code === 'auth/popup-blocked') {
                message = 'Pop-up was blocked. Please allow pop-ups for this site.';
            } else if (error.code === 'auth/unauthorized-domain') {
                message = 'This domain is not authorized. Please add it to Firebase Console → Authentication → Settings → Authorized domains.';
            } else {
                message = `Google sign-in failed: ${error.message}`;
            }
            
            alert(message);

            // Re-enable button and restore original HTML
            if (buttonElement) {
                buttonElement.disabled = false;
                buttonElement.innerHTML = originalHTML;
            }
        }
    }

    // Listen for auth state changes
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            console.log('User is signed in:', user.email);
            // Optional: Auto-redirect if user is already logged in
            // const userDoc = await getDoc(doc(db, 'users', user.uid));
            // if (userDoc.exists()) {
            //     const role = userDoc.data().role;
            //     window.location.href = role === 'vet' ? 'vet-dashboard.html' : 'petowner-dashboard.html';
            // }
        } else {
            console.log('User is signed out');
        }
    });

    function init() {
        if (!DOM.tabLogin || !DOM.tabSignup) return;

        DOM.tabLogin.addEventListener('click', () => showTab('login'));
        DOM.tabSignup.addEventListener('click', () => showTab('signup'));

        DOM.formLogin?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('login_email')?.value?.trim();
            const password = document.getElementById('login_pass')?.value;
            const submitBtn = e.target.querySelector('button[type="submit"]');

            if (!email || !password) {
                alert('Please enter both email and password.');
                return;
            }

            // Disable button to prevent spam
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Logging in...';
            }

            try {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                // Check if email is verified
                if (!user.emailVerified) {
                    alert('Please verify your email before logging in. Check your inbox for the verification link.');
                    await auth.signOut();
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Login';
                    }
                    return;
                }

                // Get user role from Firestore
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    const role = userData.role;

                    console.log('Login successful! Role:', role);

                    // Redirect based on role
                    if (role === 'vet') {
                        console.log('Redirecting to vet dashboard...');
                        alert(`Welcome back, Dr. ${userData.displayName}! (Vet dashboard coming soon)`);
                        // TODO: window.location.href = 'vet-dashboard.html';
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Login';
                        }
                    } else {
                        console.log('Redirecting to pet owner dashboard...');
                        window.location.href = 'dashboard.html';
                    }
                } else {
                    alert('User profile not found. Please contact support.');
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Login';
                    }
                }

            } catch (error) {
                console.error('Login error:', error);
                console.error('Error code:', error.code);
                console.error('Error message:', error.message);
                let message = 'Login failed. Please try again.';
                
                if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                    message = 'Invalid email or password.';
                } else if (error.code === 'auth/invalid-email') {
                    message = 'Invalid email address.';
                } else if (error.code === 'auth/too-many-requests') {
                    message = 'Too many failed attempts. Please try again later.';
                } else {
                    message = `Login failed: ${error.message}`;
                }
                
                alert(message);
                
                // Re-enable button
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Login';
                }
            }
        });

        DOM.formSignup?.addEventListener('submit', (e) => {
            e.preventDefault();
            // Create Account button handles signup; prevent Enter from submitting
        });

        DOM.btnCreateAccount?.addEventListener('click', showActivateStep);
        DOM.btnBackEmail?.addEventListener('click', backToFormStep);

        DOM.btnGoogleLogin?.addEventListener('click', async (e) => {
            e.preventDefault();
            await handleGoogleSignIn(e.target);
        });

        DOM.btnGoogleSignup?.addEventListener('click', async (e) => {
            e.preventDefault();
            await handleGoogleSignIn(e.target);
        });

        DOM.btnForgotPassword?.addEventListener('click', (e) => {
            e.preventDefault();
            showForgotPasswordForm();
        });

        DOM.btnBackToLogin?.addEventListener('click', (e) => {
            e.preventDefault();
            showLoginForm();
        });

        DOM.btnSendReset?.addEventListener('click', async (e) => {
            e.preventDefault();
            
            const email = DOM.forgotEmail?.value?.trim();
            
            if (!email) {
                alert('Please enter your email address.');
                return;
            }

            // Disable button
            const btn = e.target;
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = 'Sending...';

            try {
                await sendPasswordResetEmail(auth, email);
                alert('If an account exists with this email, a password reset link has been sent. Check your inbox.');
                btn.disabled = false;
                btn.textContent = originalText;
                // Go back to login form after success
                showLoginForm();
            } catch (error) {
                console.error('Password reset error:', error);
                let message = 'Failed to send reset email.';
                
                if (error.code === 'auth/invalid-email') {
                    message = 'Invalid email address.';
                } else {
                    // For security, Firebase doesn't reveal if user exists
                    message = 'If an account exists with this email, a password reset link has been sent.';
                }
                
                alert(message);
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
