// Cloud Functions: admin user ops, reports, vet onboarding email, self-delete.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const { makeRtc } = require('./rtc');
const { makePayments } = require('./payments');
const { makeAdminActions } = require('./admin-actions');
const { makeSchedule } = require('./schedule');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const gmailUser = defineString('GMAIL_USER');
const gmailAppPassword = defineString('GMAIL_APP_PASSWORD');
// Test route secret key for card/debit flow (sk_test_…).
const paymongoSecretKeyTest = defineString('PAYMONGO_SECRET_KEY_TEST', { default: '' });
// Live route secret key for QRPh flow (sk_live_…).
const paymongoSecretKeyLive = defineString('PAYMONGO_SECRET_KEY_LIVE', { default: '' });
// Publishable key used by frontend for card/debit test payment method creation (pk_test_…).
const paymongoPublicKeyTest = defineString('PAYMONGO_PK_TEST', { default: '' });
// Publishable key used by frontend for QRPh live payment method creation (pk_live_…).
const paymongoPublicKeyLive = defineString('PAYMONGO_PK_LIVE', { default: '' });
// Optional TURN config for WebRTC cross-network reliability.
const rtcTurnUrls = defineString('RTC_TURN_URLS', { default: '' });
const rtcTurnUsername = defineString('RTC_TURN_USERNAME', { default: '' });
const rtcTurnCredential = defineString('RTC_TURN_CREDENTIAL', { default: '' });
// Interpret appointment dateStr + slot times as this UTC offset (e.g. +08:00 for Philippines). Must match how the web app treats local slots.
const appointmentSlotIsoOffset = defineString('APPOINTMENT_SLOT_ISO_OFFSET', { default: '+08:00' });

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

// Allow all origins so callables work from web.app, firebaseapp.com, localhost, and custom domains.
const callableOptions = { cors: true };

const payments = makePayments({
  onCall,
  HttpsError,
  callableOptions,
  admin,
  db,
  logger,
  paymongoSecretKeyTest,
  paymongoSecretKeyLive,
  paymongoPublicKeyTest,
  paymongoPublicKeyLive,
});
exports.payMongoCreatePaymentIntent = payments.payMongoCreatePaymentIntent;
exports.payMongoAttachPayment = payments.payMongoAttachPayment;
exports.payMongoGetPaymentIntentStatus = payments.payMongoGetPaymentIntentStatus;
exports.payMongoGetClientConfig = payments.payMongoGetClientConfig;

const rtc = makeRtc({
  onCall,
  HttpsError,
  callableOptions,
  rtcTurnUrls,
  rtcTurnUsername,
  rtcTurnCredential,
});
exports.getRtcIceServers = rtc.getRtcIceServers;

const adminActions = makeAdminActions({
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
});
exports.disableUser = adminActions.disableUser;
exports.enableUser = adminActions.enableUser;
exports.listUsers = adminActions.listUsers;
exports.getReport = adminActions.getReport;
exports.createVetUser = adminActions.createVetUser;
exports.deleteUser = adminActions.deleteUser;
exports.deleteMyAccount = adminActions.deleteMyAccount;

const schedule = makeSchedule({
  onSchedule,
  db,
  admin,
  logger,
  appointmentSlotIsoOffset,
});
exports.scheduledAutoEndPastConsultations = schedule.scheduledAutoEndPastConsultations;

// scheduledAutoEndPastConsultations export is wired above via `functions/schedule.js`.
