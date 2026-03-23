/** Cloud Functions: admin user ops, reports, vet onboarding email, self-delete. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const gmailUser = defineString('GMAIL_USER');
const gmailAppPassword = defineString('GMAIL_APP_PASSWORD');
/** Test: sk_test_… from PayMongo Dashboard → Developers (test mode). Set in functions/.env locally or Firebase params when deployed. */
const paymongoSecretKey = defineString('PAYMONGO_SECRET_KEY', { default: '' });
/** Optional TURN config for WebRTC cross-network reliability. */
const rtcTurnUrls = defineString('RTC_TURN_URLS', { default: '' });
const rtcTurnUsername = defineString('RTC_TURN_USERNAME', { default: '' });
const rtcTurnCredential = defineString('RTC_TURN_CREDENTIAL', { default: '' });

const PAYMONGO_API = 'https://api.paymongo.com/v1';

function paymongoBasicAuth(secret) {
  return `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
}

async function paymongoRequest(secret, method, path, body) {
  const headers = { Authorization: paymongoBasicAuth(secret) };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${PAYMONGO_API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.errors && json.errors[0];
    const msg = (e && (e.detail || e.title)) || `PayMongo request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function requirePaymongoSecret() {
  const v = paymongoSecretKey.value();
  if (!v || !String(v).trim()) {
    throw new HttpsError(
      'failed-precondition',
      'PayMongo is not configured. Set PAYMONGO_SECRET_KEY (sk_test_…) for the Functions emulator or production.',
    );
  }
  return String(v).trim();
}

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();
let storageBucket = null;
try {
  const bucketName = process.env.GCLOUD_PROJECT
    ? `${process.env.GCLOUD_PROJECT}.firebasestorage.app`
    : 'vet-telehealth-891d6.firebasestorage.app';
  storageBucket = admin.storage().bucket(bucketName);
} catch (e) {
  logger.warn('Storage bucket init skipped:', e.message);
}

/** Allow all origins so callables work from web.app, firebaseapp.com, localhost, and custom domains. */
const callableOptions = { cors: true };

function parseCsvParam(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

exports.getRtcIceServers = onCall(callableOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  const urls = parseCsvParam(rtcTurnUrls.value());
  const username = String(rtcTurnUsername.value() || '').trim();
  const credential = String(rtcTurnCredential.value() || '').trim();

  if (urls.length && username && credential) {
    iceServers.push({
      urls,
      username,
      credential,
    });
  } else {
    // Temporary fallback TURN for development/testing across strict mobile networks.
    // Replace with your own TURN in RTC_TURN_* params for production reliability/privacy.
    iceServers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }

  return {
    iceServers,
    hasTurn: urls.length > 0 && !!(username && credential),
  };
});

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

exports.disableUser = onCall(callableOptions, async (request) => {
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

exports.enableUser = onCall(callableOptions, async (request) => {
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

exports.deleteUser = onCall(callableOptions, async (request) => {
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

exports.deleteMyAccount = onCall(callableOptions, async (request) => {
  try {
    const { auth: authContext } = request;
    if (!authContext || !authContext.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to delete your account.');
    }
    const uid = authContext.uid;

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

exports.listUsers = onCall(callableOptions, async (request) => {
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

exports.getReport = onCall(callableOptions, async (request) => {
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

exports.createVetUser = onCall(callableOptions, async (request) => {
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
  const firstNameTrimmed = firstName.trim();
  const lastNameTrimmed = lastName.trim();
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

/** Clip and normalize user-provided strings for PayMongo metadata (no newlines). */
function paymongoDescriptionPart(raw, maxLen) {
  if (raw == null) return '';
  const t = String(raw)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '');
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/** Dashboard description: title, vet, pet owner (from auth), pet. Max ~512 chars for API safety. */
async function buildPaymongoConsultationDescription(request, data) {
  const token = request.auth.token || {};
  const ownerEmail = paymongoDescriptionPart(token.email, 120);
  let ownerName = paymongoDescriptionPart(token.name, 80);
  if (!ownerName && request.auth?.uid) {
    try {
      const rec = await admin.auth().getUser(request.auth.uid);
      ownerName = paymongoDescriptionPart(rec.displayName, 80);
    } catch (_) {
      /* ignore */
    }
  }
  const ownerLabel = ownerName && ownerEmail
    ? `${ownerName} (${ownerEmail})`
    : ownerName || ownerEmail || 'Pet owner';

  const title = paymongoDescriptionPart(data?.consultationTitle, 120);
  const vet = paymongoDescriptionPart(data?.vetName, 100);
  const clinic = paymongoDescriptionPart(data?.clinicName, 80);
  const vetLine = vet && clinic ? `${vet} · ${clinic}` : vet || clinic || '';
  const pet = paymongoDescriptionPart(data?.petName, 80);

  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (vetLine) parts.push(`Vet: ${vetLine}`);
  parts.push(`Pet owner: ${ownerLabel}`);
  if (pet) parts.push(`Pet: ${pet}`);

  let desc = parts.join(' | ');
  const max = 512;
  if (desc.length > max) {
    desc = `${desc.slice(0, max - 1)}…`;
  }
  return desc || 'TeleVet consultation';
}

/** PayMongo metadata values must be strings; keep within typical limits. */
function paymongoIntentMetadataFromDescription(description) {
  const v = paymongoDescriptionPart(description, 500);
  if (!v) return null;
  return { description: v };
}

/** Sandbox: create a Payment Intent (PHP). Amount in centavos. */
exports.payMongoCreatePaymentIntent = onCall(callableOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const secret = await requirePaymongoSecret();
  const data = request.data || {};
  const { amount: amountRaw } = data;
  const paymentMethod = String(data?.paymentMethod || 'card').trim().toLowerCase();
  if (!['card', 'qrph'].includes(paymentMethod)) {
    throw new HttpsError('invalid-argument', 'paymentMethod must be card or qrph.');
  }
  const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw)
    ? Math.floor(amountRaw)
    : 10000;
  const minAmount = paymentMethod === 'qrph' ? 2000 : 10000;
  if (amount < minAmount) {
    throw new HttpsError(
      'invalid-argument',
      `Amount must be at least ${minAmount} (${paymentMethod === 'qrph' ? 'PHP 20.00' : 'PHP 100.00'}).`,
    );
  }
  const uid = request.auth.uid;
  const description = await buildPaymongoConsultationDescription(request, data);
  const metadata = paymongoIntentMetadataFromDescription(description);
  try {
    const attributes = {
      amount,
      currency: 'PHP',
      payment_method_allowed: [paymentMethod],
      description,
    };
    if (metadata) {
      attributes.metadata = metadata;
    }
    const json = await paymongoRequest(secret, 'POST', '/payment_intents', {
      data: {
        type: 'payment_intent',
        attributes,
      },
    });
    const d = json.data;
    const piId = d.id;
    const attrs = d.attributes || {};
    if (attrs.description == null || attrs.description === '') {
      logger.warn('payMongoCreatePaymentIntent: response missing description', { piId });
    }
    await db.collection('paymongo_intents').doc(piId).set({
      uid,
      description,
      paymentMethod,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      paymentIntentId: piId,
      clientKey: d.attributes.client_key,
      amount: d.attributes.amount,
      paymentMethod,
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('payMongoCreatePaymentIntent', e.message || e);
    throw new HttpsError('internal', e.message || 'Could not start payment.');
  }
});

/** Server-side attach (secret key). return_url is used if the card requires 3DS redirect. */
exports.payMongoAttachPayment = onCall(callableOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const secret = await requirePaymongoSecret();
  const { paymentIntentId, paymentMethodId, returnUrl } = request.data || {};
  if (!paymentIntentId || !paymentMethodId) {
    throw new HttpsError('invalid-argument', 'paymentIntentId and paymentMethodId are required.');
  }
  if (!returnUrl || typeof returnUrl !== 'string') {
    throw new HttpsError('invalid-argument', 'returnUrl is required.');
  }
  try {
    const claim = await db.collection('paymongo_intents').doc(paymentIntentId).get();
    if (!claim.exists || claim.data().uid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'Invalid payment intent.');
    }

    const json = await paymongoRequest(
      secret,
      'POST',
      `/payment_intents/${encodeURIComponent(paymentIntentId)}/attach`,
      {
        data: {
          attributes: {
            payment_method: paymentMethodId,
            return_url: returnUrl,
          },
        },
      },
    );
    const attrs = json.data.attributes;
    const next = attrs.next_action || null;
    let redirectUrl = null;
    if (next) {
      redirectUrl =
        next.redirect?.url
        || next.redirect?.checkout_url
        || next.redirect_url
        || next.url
        || null;
    }
    const code = next && next.code ? next.code : null;
    return {
      status: attrs.status,
      nextActionType: next && next.type,
      redirectUrl,
      qrImageUrl: code && code.image_url ? code.image_url : null,
      qrLabel: code && code.label ? code.label : null,
      qrCodeId: code && code.id ? code.id : null,
      lastPaymentError: attrs.last_payment_error || null,
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('payMongoAttachPayment', e.message || e);
    throw new HttpsError('internal', e.message || 'Could not complete payment.');
  }
});

/** Verify intent belongs to caller and return status (for post-3DS return and polling). */
exports.payMongoGetPaymentIntentStatus = onCall(callableOptions, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const secret = await requirePaymongoSecret();
  const { paymentIntentId } = request.data || {};
  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    throw new HttpsError('invalid-argument', 'paymentIntentId is required.');
  }
  try {
    const claim = await db.collection('paymongo_intents').doc(paymentIntentId).get();
    if (!claim.exists || claim.data().uid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'This payment does not belong to your account.');
    }

    const json = await paymongoRequest(
      secret,
      'GET',
      `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      null,
    );
    const attrs = json.data.attributes;
    return {
      status: attrs.status,
      lastPaymentError: attrs.last_payment_error || null,
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('payMongoGetPaymentIntentStatus', e.message || e);
    throw new HttpsError('internal', e.message || 'Could not read payment status.');
  }
});
