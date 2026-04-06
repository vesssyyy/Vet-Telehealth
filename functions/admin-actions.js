'use strict';

const { userHasBlockingAppointment } = require('./appointment-blocks-delete');
const { formatDisplayName } = require('./format-display-name');

function makeAdminActions({
  onCall,
  HttpsError,
  callableOptions,
  admin,
  db,
  auth,
  logger,
  storageBucket,
  gmailUser,
  gmailAppPassword,
}) {
  function isValidEmail(email) {
    if (!email || typeof email !== 'string' || email.length > 254) return false;
    const trimmed = email.trim().toLowerCase();
    const atIdx = trimmed.indexOf('@');
    if (atIdx <= 0 || atIdx === trimmed.length - 1) return false;
    const local = trimmed.slice(0, atIdx);
    const domain = trimmed.slice(atIdx + 1);
    if (!local || !domain) return false;
    if (local.endsWith('.') || local.startsWith('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
    if (domain.indexOf('.') <= 0 || domain.length < 4) return false;
    if (/\.@|@\.|\.\./.test(trimmed)) return false;
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed);
  }

  async function ensureAdmin(context) {
    if (!context.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in.');
    }
    const snap = await db.collection('users').doc(context.auth.uid).get();
    const role = snap.exists ? snap.data().role : null;
    if (role !== 'admin') {
      throw new HttpsError('permission-denied', 'Admin only.');
    }
  }

  const disableUser = onCall(callableOptions, async (request) => {
    const { data, auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const { uid, disabled } = data || {};
    if (!uid || typeof disabled !== 'boolean') {
      throw new HttpsError('invalid-argument', 'uid and disabled (boolean) required.');
    }
    const callerUid = authContext.uid;
    await auth.updateUser(uid, { disabled });
    await db.collection('users').doc(uid).update({
      disabled,
      disabledAt: disabled ? admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.delete(),
      disabledBy: disabled ? callerUid : admin.firestore.FieldValue.delete(),
    });
    return { ok: true };
  });

  const enableUser = onCall(callableOptions, async (request) => {
    const { data, auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const { uid } = data || {};
    if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
    await auth.updateUser(uid, { disabled: false });
    await db.collection('users').doc(uid).update({
      disabled: false,
      disabledAt: admin.firestore.FieldValue.delete(),
      disabledBy: admin.firestore.FieldValue.delete(),
    });
    return { ok: true };
  });

  async function deleteUserData(uid) {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User not found.');
    }

    // 1) Delete Storage: profile-photos/{uid} and pet-photos/{uid}/* (non-fatal if Storage fails)
    if (storageBucket) {
      try {
        const profilePhotoPath = `profile-photos/${uid}`;
        const profileFile = storageBucket.file(profilePhotoPath);
        await profileFile.delete();
      } catch (e) {
        if (e.code !== 404) logger.warn('Storage profile-photos delete:', e.message);
      }
      try {
        const [petFiles] = await storageBucket.getFiles({ prefix: `pet-photos/${uid}/` });
        await Promise.all(petFiles.map((f) => f.delete()));
      } catch (e) {
        logger.warn('Storage pet-photos delete:', e.message);
      }
    }

    // 2) Delete subcollections under users/{uid}
    const subcollections = ['pets', 'schedules', 'template'];
    for (const sub of subcollections) {
      const snap = await db.collection('users').doc(uid).collection(sub).get();
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      if (!snap.empty) await batch.commit();
    }
    const vetSettings = await db.collection('users').doc(uid).collection('vetSettings').get();
    if (!vetSettings.empty) {
      const batch = db.batch();
      vetSettings.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // 3) Delete appointments where ownerId or vetId === uid
    const appointmentsSnap = await db.collection('appointments')
      .where('ownerId', '==', uid)
      .get();
    for (const d of appointmentsSnap.docs) {
      await d.ref.delete();
    }
    const appointmentsVetSnap = await db.collection('appointments')
      .where('vetId', '==', uid)
      .get();
    for (const d of appointmentsVetSnap.docs) {
      await d.ref.delete();
    }

    // 4) Delete conversations where participants contains uid (and messages subcollection)
    const convsSnap = await db.collection('conversations')
      .where('participants', 'array-contains', uid)
      .get();
    for (const convDoc of convsSnap.docs) {
      const msgs = await convDoc.ref.collection('messages').get();
      const batch = db.batch();
      msgs.docs.forEach((d) => batch.delete(d.ref));
      if (!msgs.empty) await batch.commit();
      await convDoc.ref.delete();
    }

    // 5) Delete user document
    await userRef.delete();
  }

  const deleteUser = onCall(callableOptions, async (request) => {
    const { data, auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const uid = data?.uid;
    if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
    if (uid === authContext.uid) {
      throw new HttpsError('invalid-argument', 'Cannot delete your own account.');
    }

    await deleteUserData(uid);

    try {
      await auth.deleteUser(uid);
    } catch (e) {
      logger.warn('Auth deleteUser failed (user may not exist)', e.message);
    }

    return { ok: true };
  });

  const deleteMyAccount = onCall(callableOptions, async (request) => {
    try {
      const { auth: authContext } = request;
      if (!authContext || !authContext.uid) {
        throw new HttpsError('unauthenticated', 'You must be signed in to delete your account.');
      }
      const uid = authContext.uid;

      if (await userHasBlockingAppointment(db, uid)) {
        throw new HttpsError(
          'failed-precondition',
          'You cannot delete your account while you have an ongoing or upcoming appointment. Once those visits are completed or cancelled, you can delete your account.',
        );
      }

      await deleteUserData(uid);

      try {
        await auth.deleteUser(uid);
      } catch (e) {
        logger.warn('Auth deleteUser failed (user may not exist)', e.message);
      }

      return { ok: true };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('deleteMyAccount unexpected error:', e.message || e);
      throw new HttpsError('internal', 'Account deletion failed. Please try again or contact support.');
    }
  });

  const listUsers = onCall(callableOptions, async (request) => {
    const { data, auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const { role = null, disabled = null } = data || {};
    const snap = await db.collection('users').get();
    let users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    users = users.filter((u) => u.id !== authContext.uid);
    if (role) users = users.filter((u) => u.role === role);
    if (typeof disabled === 'boolean') users = users.filter((u) => !!u.disabled === disabled);
    return { users };
  });

  const getReport = onCall(callableOptions, async (request) => {
    const { auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const snap = await db.collection('users').get();
    let total = 0;
    let petOwners = 0;
    let vets = 0;
    let admins = 0;
    let disabled = 0;
    snap.docs.forEach((d) => {
      const r = d.data().role;
      total++;
      if (r === 'petOwner') petOwners++;
      else if (r === 'vet') vets++;
      else if (r === 'admin') admins++;
      if (d.data().disabled) disabled++;
    });
    return {
      total,
      byRole: { petOwner: petOwners, vet: vets, admin: admins },
      disabled,
    };
  });

  const createVetUser = onCall(callableOptions, async (request) => {
    const { data, auth: authContext } = request;
    await ensureAdmin({ auth: authContext });
    const { email, password, firstName, lastName, continueUrl } = data || {};
    if (!email || typeof email !== 'string' || !email.trim()) {
      throw new HttpsError('invalid-argument', 'Email is required.');
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
    }
    if (!firstName || !lastName) {
      throw new HttpsError('invalid-argument', 'First name and last name are required.');
    }
    const emailTrimmed = email.trim().toLowerCase();
    const firstNameTrimmed = formatDisplayName(firstName.trim());
    const lastNameTrimmed = formatDisplayName(lastName.trim());
    const displayNameVal = `${firstNameTrimmed} ${lastNameTrimmed}`.trim();

    if (!isValidEmail(emailTrimmed)) {
      throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    }

    // Check if email already exists in Firebase Auth before creating
    try {
      await auth.getUserByEmail(emailTrimmed);
      throw new HttpsError('already-exists', 'An account with this email already exists.');
    } catch (e) {
      if (e instanceof HttpsError && e.code === 'already-exists') throw e;
      const code = e.code || (e.errorInfo && e.errorInfo.code);
      if (code !== 'auth/user-not-found') {
        throw new HttpsError('internal', e.message || 'Failed to check existing email.');
      }
    }

    let userRecord;
    try {
      userRecord = await auth.createUser({
        email: emailTrimmed,
        password,
        displayName: displayNameVal,
        emailVerified: false,
      });
      await db.collection('users').doc(userRecord.uid).set({
        email: emailTrimmed,
        displayName: displayNameVal,
        firstName: firstNameTrimmed,
        lastName: lastNameTrimmed,
        role: 'vet',
        emailVerified: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (e.code === 'auth/email-already-exists' || e.message?.includes('already exists')) {
        throw new HttpsError('already-exists', 'An account with this email already exists.');
      }
      if (e.code === 'auth/invalid-email') {
        throw new HttpsError('invalid-argument', 'Invalid email address.');
      }
      throw new HttpsError('internal', e.message || 'Failed to create vet account.');
    }

    // Generate and send a verification email
    try {
      const actionCodeSettings = { url: continueUrl || 'https://localhost/auth.html?verified=true' };
      const verificationLink = await auth.generateEmailVerificationLink(emailTrimmed, actionCodeSettings);

      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser.value(),
          pass: gmailAppPassword.value(),
        },
      });

      await transporter.sendMail({
        from: `"TeleVet Health" <${gmailUser.value()}>`,
        to: emailTrimmed,
        subject: 'Verify your TeleVet Health account',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:12px;">
            <h2 style="color:#2563eb;margin-bottom:8px;">Welcome to TeleVet Health</h2>
            <p style="color:#374151;font-size:15px;">Hi ${firstNameTrimmed},</p>
            <p style="color:#374151;font-size:15px;">
              A veterinarian account has been created for you. Please verify your email address to activate your account.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${verificationLink}"
                 style="background:#2563eb;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
                Verify Email Address
              </a>
            </div>
            <p style="color:#6b7280;font-size:13px;">
              If the button above doesn't work, copy and paste this link into your browser:<br>
              <a href="${verificationLink}" style="color:#2563eb;word-break:break-all;">${verificationLink}</a>
            </p>
            <p style="color:#6b7280;font-size:13px;margin-top:24px;">
              If you did not expect this email, you can safely ignore it.
            </p>
          </div>
        `,
      });
    } catch (e) {
      logger.error('Failed to send verification email:', e.message);
      // Account was created — log the error but still return success so the admin knows
      // the account exists. The vet will be unable to log in until verified another way.
      return { ok: true, uid: userRecord.uid, email: emailTrimmed, emailSent: false };
    }

    return { ok: true, uid: userRecord.uid, email: emailTrimmed, emailSent: true };
  });

  return {
    disableUser,
    enableUser,
    listUsers,
    getReport,
    createVetUser,
    deleteUser,
    deleteMyAccount,
  };
}

module.exports = { makeAdminActions };

