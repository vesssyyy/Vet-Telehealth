import { app, auth } from '../../core/firebase/firebase-config.js';
import { formatDisplayName } from '../../core/app/utils.js';
import { appAlertError } from '../../core/ui/app-dialog.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-functions.js';
import { createAppointment, markAppointmentPaid } from '../appointment/petowner/services.js';
import { enrichAppointmentAttachedSkinFromHistory } from '../skin-disease/skin-analysis-repository.js';
import { createCardPaymentMethod, createQrPhPaymentMethod } from './paymongo-client.js';
import {
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE,
    DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST,
    MIN_CONSULTATION_PRICE_CENTAVOS_LIVE,
    MIN_CONSULTATION_PRICE_CENTAVOS_TEST,
} from '../appointment/shared/constants.js';

var BOOKING_MEDIA_DB = 'televet_booking_media';
var BOOKING_MEDIA_STORE = 'files';
/** Set when payment page loads with ?booking=1 (vet fee from booking payload). */
var paymentContextBooking = null;

function getBookingMediaFromIndexedDB(mediaKey) {
    return new Promise(function (resolve, reject) {
        if (!mediaKey) { resolve([]); return; }
        var request = indexedDB.open(BOOKING_MEDIA_DB, 1);
        request.onerror = function () { reject(new Error('Could not load attached files.')); };
        request.onupgradeneeded = function (e) {
            if (!e.target.result.objectStoreNames.contains(BOOKING_MEDIA_STORE)) {
                e.target.result.createObjectStore(BOOKING_MEDIA_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = function (e) {
            var db = e.target.result;
            var tx = db.transaction(BOOKING_MEDIA_STORE, 'readonly');
            var store = tx.objectStore(BOOKING_MEDIA_STORE);
            var getReq = store.get(mediaKey);
            getReq.onsuccess = function () {
                var record = getReq.result;
                db.close();
                var raw = record && record.files ? record.files : [];
                var out = [];
                for (var i = 0; i < raw.length; i++) {
                    var f = raw[i];
                    if (f instanceof File) {
                        out.push(f);
                    } else if (f && (f instanceof Blob || f.type != null)) {
                        var name = f.name || ('file_' + i + (f.type && f.type.indexOf('pdf') !== -1 ? '.pdf' : '.jpg'));
                        out.push(new File([f], name, { type: f.type || 'application/octet-stream' }));
                    }
                }
                resolve(out);
            };
            getReq.onerror = function () { db.close(); reject(getReq.error); };
        };
    });
}

function deleteBookingMediaFromIndexedDB(mediaKey) {
    return new Promise(function (resolve) {
        if (!mediaKey) { resolve(); return; }
        var request = indexedDB.open(BOOKING_MEDIA_DB, 1);
        request.onerror = function () { resolve(); };
        request.onsuccess = function (e) {
            var db = e.target.result;
            var tx = db.transaction(BOOKING_MEDIA_STORE, 'readwrite');
            var store = tx.objectStore(BOOKING_MEDIA_STORE);
            store.delete(mediaKey);
            tx.oncomplete = function () { db.close(); resolve(); };
            tx.onerror = function () { db.close(); resolve(); };
        };
    });
}

function formatPhpCentavos(centavos) {
    var n = Number(centavos);
    if (!Number.isFinite(n)) return '-';
    return 'PHP ' + (n / 100).toFixed(2);
}

var CARD_DIGITS_MAX = 19;

function cardDigitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
}

/** Groups of four (standard card spacing); PayMongo strips spaces in createCardPaymentMethod. */
function formatCardNumberDisplay(digits) {
    var d = cardDigitsOnly(digits).slice(0, CARD_DIGITS_MAX);
    var parts = [];
    for (var i = 0; i < d.length; i += 4) {
        parts.push(d.slice(i, i + 4));
    }
    return parts.join(' ');
}

function applyCardNumberFormatting(input) {
    if (!input) return;
    var oldVal = input.value;
    var selStart = input.selectionStart;
    var selEnd = input.selectionEnd;
    var formatted = formatCardNumberDisplay(oldVal);
    if (formatted === oldVal) return;

    var atEnd = selStart === oldVal.length && selEnd === oldVal.length;
    var digitsBeforeCaret = oldVal.slice(0, selStart).replace(/\D/g, '').length;

    input.value = formatted;

    if (atEnd) {
        input.setSelectionRange(formatted.length, formatted.length);
        return;
    }
    var pos = 0;
    var n = 0;
    for (; pos < formatted.length && n < digitsBeforeCaret; pos++) {
        if (/\d/.test(formatted.charAt(pos))) n++;
    }
    try {
        input.setSelectionRange(pos, pos);
    } catch (e) { /* ignore */ }
}

function bindCardNumberSpacing(input) {
    if (!input || input.dataset.cardFormatBound === '1') return;
    input.dataset.cardFormatBound = '1';
    input.addEventListener('input', function () {
        applyCardNumberFormatting(input);
    });
    input.addEventListener('paste', function (ev) {
        ev.preventDefault();
        var text = (ev.clipboardData && ev.clipboardData.getData('text')) || '';
        var merged = cardDigitsOnly(input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd));
        input.value = formatCardNumberDisplay(merged);
        try {
            input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) { /* ignore */ }
    });
}

function parseCardExpiry() {
    var m = parseInt(String(document.getElementById('pm-exp-month').value).replace(/\D/g, ''), 10);
    var yRaw = String(document.getElementById('pm-exp-year').value).replace(/\D/g, '');
    var y = parseInt(yRaw, 10);
    if (!Number.isFinite(m) || m < 1 || m > 12) {
        throw new Error('Enter a valid expiry month (01-12).');
    }
    if (!yRaw || !Number.isFinite(y)) {
        throw new Error('Enter a valid expiry year.');
    }
    if (yRaw.length === 4 && y >= 2000 && y <= 2099) {
        /* full year */
    } else if (yRaw.length === 2) {
        y = 2000 + y;
    } else {
        throw new Error('Enter expiry year as YY (e.g. 28) or YYYY.');
    }
    if (y < 2000 || y > 2099) {
        throw new Error('Enter a valid expiry year.');
    }
    return { expMonth: m, expYear: y };
}

function formatPaymentError(err) {
    if (!err) return 'Something went wrong.';
    var rawMessage = String(err.message || err.details || '');
    if (rawMessage.indexOf('is not allowed for payment intent') !== -1) {
        return 'Selected payment method is not enabled on the server yet. Deploy latest Cloud Functions, then try again.';
    }
    var c = err.code;
    if (c === 'functions/failed-precondition' || c === 'functions/permission-denied' || c === 'functions/unauthenticated') {
        return err.message || err.details || 'Request was rejected.';
    }
    if (err.details) return err.details;
    return err.message || String(err);
}

function payMongoReturnUrl() {
    var u = new URL(window.location.href);
    u.searchParams.set('booking', '1');
    u.searchParams.set('paymongo_return', '1');
    return u.toString();
}

var params = new URLSearchParams(window.location.search);
var summaryEl = document.getElementById('payment-booking-summary');
var successBadge = document.getElementById('payment-success-badge');
var placeholderText = document.getElementById('payment-placeholder-text');
var paymentForm = document.getElementById('payment-card-form');
var btnConfirmPay = document.getElementById('btn-confirm-pay');
var configWarning = document.getElementById('payment-config-warning');
var statusWait = document.getElementById('payment-status-wait');
var feeLine = document.getElementById('payment-fee-line');
var qrPanel = document.getElementById('payment-qr-panel');
var qrImage = document.getElementById('payment-qr-image');
var qrNote = document.getElementById('payment-qr-note');
var cardFields = document.getElementById('payment-card-fields');
var paymentHint = document.getElementById('payment-sandbox-hint');
var nameLabel = document.getElementById('pm-name-label');
var emailLabel = document.getElementById('pm-email-label');
var qrPollTimer = null;
var qrSessionLocked = false;

var functions = getFunctions(app);
var createPaymentIntent = httpsCallable(functions, 'payMongoCreatePaymentIntent');
var attachPayment = httpsCallable(functions, 'payMongoAttachPayment');
var getPaymentIntentStatus = httpsCallable(functions, 'payMongoGetPaymentIntentStatus');
var getPayMongoClientConfig = httpsCallable(functions, 'payMongoGetClientConfig');
var paymongoClientKeys = { card: '', qrph: '' };
var paymongoClientConfigLoading = null;

onAuthStateChanged(auth, function (user) {
    var em = document.getElementById('pm-email');
    if (em && user && user.email && !em.value) em.value = user.email;
});

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showBookingSummary(booking) {
    if (!summaryEl || !booking) return;
    var vetPart = booking.vetName ? formatDisplayName(String(booking.vetName)) : '-';
    var clinicPart = booking.clinicName ? formatDisplayName(String(booking.clinicName)) : '';
    var vetLine = vetPart + (clinicPart ? ' - ' + clinicPart : '');
    var titleText =
        (booking.title && String(booking.title).trim()) ||
        (booking.reason && String(booking.reason).trim()) ||
        '-';
    var titleHtml = escapeHtml(titleText);
    summaryEl.innerHTML =
        '<div class="payment-summary-row"><span class="sum-label">Veterinarian</span><span class="sum-value">' + escapeHtml(vetLine) + '</span></div>' +
        '<div class="payment-summary-row"><span class="sum-label">Pet</span><span class="sum-value">' + escapeHtml(booking.petName ? formatDisplayName(String(booking.petName)) : '-') + '</span></div>' +
        '<div class="payment-summary-row"><span class="sum-label">Title:</span><span class="sum-value payment-summary-title-text" title="' + titleHtml + '">' + titleHtml + '</span></div>' +
        '<div class="payment-summary-row"><span class="sum-label">Date &amp; time</span><span class="sum-value">' + (booking.timeDisplay || booking.dateStr || '-') + '</span></div>';
    summaryEl.style.display = 'block';
}

function setPayButtonLoading(loading, label) {
    if (!btnConfirmPay) return;
    btnConfirmPay.disabled = loading;
    if (loading) {
        btnConfirmPay.textContent = label || 'Processing...';
    } else {
        updateMethodUi();
    }
}

async function pollPaymentSucceeded(paymentIntentId, options) {
    var opts = options || {};
    var maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : 6 * 60 * 1000;
    var initialDelayMs = Number.isFinite(opts.initialDelayMs) ? opts.initialDelayMs : 1500;
    var maxDelayMs = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : 8000;
    var startedAt = Date.now();
    var delay = initialDelayMs;

    while ((Date.now() - startedAt) < maxWaitMs) {
        var res = await getPaymentIntentStatus({ paymentIntentId: paymentIntentId });
        var st = res.data && res.data.status;
        if (st === 'succeeded') return true;
        if (st === 'awaiting_payment_method') {
            var le = res.data && res.data.lastPaymentError;
            throw new Error((le && le.detail) || (le && le.title) || 'Payment was declined.');
        }

        await new Promise(function (r) { setTimeout(r, delay); });
        delay = Math.min(maxDelayMs, Math.round(delay * 1.35));
    }

    throw new Error('Payment is still processing. Keep this page open while we continue checking your payment.');
}

function selectedPaymentMethod() {
    var checked = document.querySelector('input[name="payment-method"]:checked');
    return checked && checked.value === 'qrph' ? 'qrph' : 'card';
}

function requiredPrefixForMethod(method) {
    return method === 'qrph' ? 'pk_live_' : 'pk_test_';
}

function bookingAmountCentavos(booking, method) {
    var m = method === 'qrph' ? 'qrph' : 'card';
    var min = m === 'qrph' ? MIN_CONSULTATION_PRICE_CENTAVOS_LIVE : MIN_CONSULTATION_PRICE_CENTAVOS_TEST;
    var def = m === 'qrph' ? DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE : DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST;
    if (m === 'qrph') {
        var live = booking && booking.amountCentavosLive;
        if (typeof live === 'number' && Number.isFinite(live) && live >= min) return Math.floor(live);
    } else {
        var test = booking && booking.amountCentavosTest;
        if (typeof test === 'number' && Number.isFinite(test) && test >= min) return Math.floor(test);
    }
    var legacy = booking && booking.amountCentavos;
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= min) return Math.floor(legacy);
    return def;
}

function isValidPublishableKeyForMethod(method, key) {
    var prefix = requiredPrefixForMethod(method);
    return typeof key === 'string' && key.trim().indexOf(prefix) === 0;
}

async function loadPayMongoClientConfig() {
    if (paymongoClientConfigLoading) return paymongoClientConfigLoading;
    paymongoClientConfigLoading = (async function () {
        var res = await getPayMongoClientConfig({});
        var keys = (res.data && res.data.publishableKeys) || {};
        paymongoClientKeys.card = String(keys.card || '').trim();
        paymongoClientKeys.qrph = String(keys.qrph || '').trim();
        if (!isValidPublishableKeyForMethod('card', paymongoClientKeys.card)) {
            throw new Error('Card test key is missing or invalid (expected pk_test_...).');
        }
        if (!isValidPublishableKeyForMethod('qrph', paymongoClientKeys.qrph)) {
            throw new Error('QRPh live key is missing or invalid (expected pk_live_...).');
        }
        return paymongoClientKeys;
    })();
    return paymongoClientConfigLoading;
}

function lockPaymentMethodSwitch(locked) {
    var methodInputs = document.querySelectorAll('input[name="payment-method"]');
    for (var i = 0; i < methodInputs.length; i++) {
        methodInputs[i].disabled = locked;
        var option = methodInputs[i].closest('.payment-method-option');
        if (option) {
            option.classList.toggle('is-disabled', locked);
        }
    }
}

function updateMethodUi() {
    var method = selectedPaymentMethod();
    var amt = paymentContextBooking
        ? bookingAmountCentavos(paymentContextBooking, method)
        : bookingAmountCentavos(null, method);
    if (cardFields) cardFields.style.display = method === 'card' ? 'block' : 'none';
    if (feeLine) feeLine.textContent = formatPhpCentavos(amt);
    var cardInputIds = ['pm-number', 'pm-exp-month', 'pm-exp-year', 'pm-cvc'];
    for (var i = 0; i < cardInputIds.length; i++) {
        var cardInput = document.getElementById(cardInputIds[i]);
        if (!cardInput) continue;
        cardInput.required = method === 'card';
        if (method !== 'card') cardInput.setCustomValidity('');
    }
    if (paymentHint) {
        var exactLine = formatPhpCentavos(amt);
        paymentHint.innerHTML = method === 'card'
            ? '<span class="payment-mode-pill payment-mode-pill--test">Test only</span> - <code>4343 4343 4343 4345</code> or <code>5555 4444 4444 4457</code> - future MM/YY - any CVC'
            : '<span class="payment-mode-pill payment-mode-pill--live">Live</span> - Pay exactly <code>' + exactLine + '</code> using the generated QRPh code.';
    }
    if (nameLabel) nameLabel.textContent = method === 'card' ? 'Cardholder name' : 'Payer name';
    if (emailLabel) emailLabel.textContent = method === 'card' ? 'Email' : 'Payer email';
    if (btnConfirmPay) {
        btnConfirmPay.innerHTML = method === 'card'
            ? '<i class="fa fa-lock" aria-hidden="true"></i> Pay securely'
            : '<i class="fa fa-qrcode" aria-hidden="true"></i> Generate QR';
    }
}

function clearQrPanel() {
    if (qrPanel) qrPanel.classList.remove('is-visible');
    if (qrImage) qrImage.removeAttribute('src');
    if (qrNote) qrNote.textContent = 'Scan this QRPh code using your banking or e-wallet app to complete payment.';
    qrSessionLocked = false;
    lockPaymentMethodSwitch(false);
    if (qrPollTimer) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
    }
}

function startQrPolling(paymentIntentId, booking) {
    if (statusWait) {
        statusWait.style.display = 'block';
        statusWait.textContent = 'Waiting for QRPh payment confirmation...';
    }
    if (qrPollTimer) clearInterval(qrPollTimer);
    qrPollTimer = setInterval(async function () {
        try {
            var res = await getPaymentIntentStatus({ paymentIntentId: paymentIntentId });
            var st = res.data && res.data.status;
            if (st === 'succeeded') {
                clearInterval(qrPollTimer);
                qrPollTimer = null;
                await completeBookingAfterPayment(booking);
            } else if (st === 'awaiting_payment_method') {
                clearInterval(qrPollTimer);
                qrPollTimer = null;
                qrSessionLocked = false;
                lockPaymentMethodSwitch(false);
                if (qrNote) qrNote.textContent = 'This QR is no longer payable (expired/failed). Click Generate QR to create a new one.';
                if (statusWait) statusWait.style.display = 'none';
            }
        } catch (e) {
            console.error(e);
        }
    }, 3000);
}

async function completeBookingAfterPayment(booking) {
    var piRef = sessionStorage.getItem('paymongo_pi_id') || '';
    var refEl = document.getElementById('payment-intent-ref');
    var mediaFiles = [];
    if (booking.mediaKey) {
        mediaFiles = await getBookingMediaFromIndexedDB(booking.mediaKey);
    }
    var paidMethod = booking.paymentMethod || selectedPaymentMethod();
    var paidAmountCentavos = bookingAmountCentavos(booking, paidMethod);
    var skinAttach = booking.attachedSkinAnalysis || null;
    var u = auth.currentUser;
    if (u && skinAttach && typeof skinAttach === 'object') {
        try {
            var hydratedApt = await enrichAppointmentAttachedSkinFromHistory({
                ownerId: u.uid,
                attachedSkinAnalysis: skinAttach,
            });
            if (hydratedApt && hydratedApt.attachedSkinAnalysis) {
                skinAttach = hydratedApt.attachedSkinAnalysis;
            }
        } catch (e) {
            /* keep session snapshot */
        }
    }
    var data = {
        title: booking.title || null,
        petId: booking.petId,
        petName: booking.petName,
        petSpecies: booking.petSpecies || '',
        vetId: booking.vetId,
        vetName: booking.vetName,
        clinicName: booking.clinicName || '',
        reason: booking.reason,
        dateStr: booking.dateStr,
        timeDisplay: booking.timeDisplay,
        mediaFiles: mediaFiles,
        slotStart: booking.slotStart || null,
        slotEnd: booking.slotEnd || null,
        costPaidCentavos: paidAmountCentavos,
        paymentMethod: paidMethod,
        paymentIntentId: booking.paymentIntentId || piRef || null,
        attachedSkinAnalysis: skinAttach,
    };
    var res = await createAppointment(data);
    await markAppointmentPaid(res.id, {
        amountCentavos: paidAmountCentavos,
        paymentMethod: paidMethod,
        paymentIntentId: booking.paymentIntentId || piRef || null,
    });
    await deleteBookingMediaFromIndexedDB(booking.mediaKey);
    sessionStorage.removeItem('televet_booking');
    sessionStorage.removeItem('paymongo_pi_id');
    clearQrPanel();
    if (summaryEl) summaryEl.style.display = 'none';
    if (paymentForm) paymentForm.classList.remove('is-visible');
    if (placeholderText) placeholderText.style.display = 'none';
    if (successBadge) successBadge.style.display = 'inline-flex';
    if (statusWait) statusWait.style.display = 'none';
    if (refEl && piRef) {
        refEl.style.display = 'block';
        refEl.textContent = 'Reference: ' + piRef;
    }
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
}

async function runPayMongoThenBook(booking) {
    var user = auth.currentUser;
    if (!user) throw new Error('You must be signed in.');
    clearQrPanel();
    var method = selectedPaymentMethod();

    var consultationTitle =
        (booking.title && String(booking.title).trim()) ||
        (booking.reason && String(booking.reason).trim()) ||
        '';
    var amountCentavos = bookingAmountCentavos(booking, method);
    var piRes = await createPaymentIntent({
        amount: amountCentavos,
        paymentMethod: method,
        consultationTitle: consultationTitle,
        vetName: booking.vetName || '',
        clinicName: booking.clinicName || '',
        petName: booking.petName || '',
    });
    var resolvedMethod = (piRes.data && piRes.data.paymentMethod) ? String(piRes.data.paymentMethod).toLowerCase() : '';
    if (resolvedMethod && resolvedMethod !== method) {
        throw new Error('Payment backend is outdated (method mismatch). Please deploy latest Cloud Functions and try again.');
    }
    var pid = piRes.data.paymentIntentId;
    var pmId;
    var methodPublicKey = method === 'qrph' ? paymongoClientKeys.qrph : paymongoClientKeys.card;
    if (method === 'qrph') {
        pmId = await createQrPhPaymentMethod(methodPublicKey, {
            name: document.getElementById('pm-name').value,
            email: document.getElementById('pm-email').value || (user.email || ''),
        });
    } else {
        var exp = parseCardExpiry();
        pmId = await createCardPaymentMethod(methodPublicKey, {
            cardNumber: document.getElementById('pm-number').value,
            expMonth: exp.expMonth,
            expYear: exp.expYear,
            cvc: document.getElementById('pm-cvc').value,
            name: document.getElementById('pm-name').value,
            email: document.getElementById('pm-email').value || (user.email || ''),
        });
    }

    sessionStorage.setItem('paymongo_pi_id', pid);
    if (feeLine && piRes.data.amount != null) {
        feeLine.textContent = formatPhpCentavos(piRes.data.amount);
    }

    var attachRes = await attachPayment({
        paymentIntentId: pid,
        paymentMethodId: pmId,
        returnUrl: payMongoReturnUrl(),
    });
    var d = attachRes.data || {};
    if (method === 'qrph' && d.nextActionType === 'consume_qr' && d.qrImageUrl) {
        if (qrImage) {
            qrImage.style.opacity = '0';
            qrImage.style.transition = 'opacity 0.35s ease';
            qrImage.onload = function () { requestAnimationFrame(function () { qrImage.style.opacity = '1'; }); };
            qrImage.src = d.qrImageUrl;
        }
        if (qrPanel) qrPanel.classList.add('is-visible');
        if (qrNote) qrNote.textContent = 'QR generated. It expires in about 30 minutes and is one-time use.';
        qrSessionLocked = true;
        lockPaymentMethodSwitch(true);
        booking.amountCentavos = amountCentavos;
        booking.paymentMethod = method;
        booking.paymentIntentId = pid;
        startQrPolling(pid, booking);
        return;
    }
    if (d.status === 'succeeded') {
        booking.amountCentavos = amountCentavos;
        booking.paymentMethod = method;
        booking.paymentIntentId = pid;
        await completeBookingAfterPayment(booking);
        return;
    }
    if (d.redirectUrl) {
        booking.paymentMethod = method;
        booking.amountCentavos = amountCentavos;
        booking.paymentIntentId = pid;
        try {
            sessionStorage.setItem('televet_booking', JSON.stringify(booking));
        } catch (e) { /* ignore */ }
        window.location.href = d.redirectUrl;
        return;
    }
    if (d.status === 'processing' || d.status === 'awaiting_next_action') {
        if (statusWait) {
            statusWait.style.display = 'block';
            statusWait.textContent = method === 'qrph'
                ? 'Waiting for QRPh payment confirmation...'
                : 'Confirming card payment... this may take up to a few minutes.';
        }
        var ok = await pollPaymentSucceeded(pid, method === 'qrph'
            ? { maxWaitMs: 10 * 60 * 1000, initialDelayMs: 3000, maxDelayMs: 6000 }
            : { maxWaitMs: 6 * 60 * 1000, initialDelayMs: 1200, maxDelayMs: 8000 });
        if (ok) {
            booking.amountCentavos = amountCentavos;
            booking.paymentMethod = method;
            booking.paymentIntentId = pid;
            await completeBookingAfterPayment(booking);
        }
        return;
    }
    if (d.status === 'awaiting_payment_method') {
        var le = d.lastPaymentError;
        throw new Error((le && le.detail) || (le && (le.title)) || 'Payment could not be completed.');
    }
    throw new Error('Unexpected payment status: ' + (d.status || 'unknown'));
}

async function handlePayMongoReturn() {
    var piStored = sessionStorage.getItem('paymongo_pi_id');
    var stored = sessionStorage.getItem('televet_booking');
    if (!piStored || !stored) {
        if (statusWait) statusWait.style.display = 'none';
        if (placeholderText) {
            placeholderText.style.display = 'block';
            placeholderText.textContent = 'Could not resume payment (session expired). Start again from Appointments.';
        }
        return;
    }
    var booking = JSON.parse(stored);
    paymentContextBooking = booking;
    if (!booking.paymentMethod) booking.paymentMethod = 'card';
    try {
        if (statusWait) {
            statusWait.style.display = 'block';
            statusWait.textContent = 'Finalizing payment after PayMongo return...';
        }
        await pollPaymentSucceeded(piStored, { maxWaitMs: 8 * 60 * 1000, initialDelayMs: 1200, maxDelayMs: 8000 });
        await completeBookingAfterPayment(booking);
    } catch (e) {
        console.error(e);
        if (statusWait) statusWait.style.display = 'none';
        await appAlertError(formatPaymentError(e) || 'Payment confirmation failed.');
    }
}

if (params.get('booking') === '1') {
    var storedBooking = sessionStorage.getItem('televet_booking');
    if (storedBooking) {
        try {
            var booking = JSON.parse(storedBooking);
            paymentContextBooking = booking;
            showBookingSummary(booking);

            if (params.get('paymongo_return') === '1') {
                if (placeholderText) placeholderText.style.display = 'none';
                if (paymentForm) paymentForm.classList.remove('is-visible');
                if (configWarning) configWarning.style.display = 'none';
                if (statusWait) statusWait.style.display = 'block';
                handlePayMongoReturn();
            } else {
                loadPayMongoClientConfig().then(function () {
                    if (placeholderText) placeholderText.style.display = 'none';
                    updateMethodUi();
                    if (paymentForm) paymentForm.classList.add('is-visible');
                    if (paymentForm) {
                        var methodInputs = document.querySelectorAll('input[name="payment-method"]');
                        for (var i = 0; i < methodInputs.length; i++) {
                            methodInputs[i].addEventListener('change', async function () {
                                if (qrSessionLocked && this.value !== 'qrph') {
                                    this.checked = false;
                                    var qrRadio = document.querySelector('input[name="payment-method"][value="qrph"]');
                                    if (qrRadio) qrRadio.checked = true;
                                    await appAlertError('QR payment is still active. Please wait for success or expiration before switching methods.');
                                    return;
                                }
                                clearQrPanel();
                                updateMethodUi();
                            });
                        }
                        var pmNum = document.getElementById('pm-number');
                        if (pmNum) {
                            bindCardNumberSpacing(pmNum);
                            if (pmNum.value) applyCardNumberFormatting(pmNum);
                        }
                        var expM = document.getElementById('pm-exp-month');
                        var expY = document.getElementById('pm-exp-year');
                        if (expM && expY) {
                            expM.addEventListener('input', function () {
                                expM.value = expM.value.replace(/\D/g, '').slice(0, 2);
                                if (expM.value.length >= 2) expY.focus();
                            });
                            expY.addEventListener('input', function () {
                                expY.value = expY.value.replace(/\D/g, '').slice(0, 4);
                            });
                        }
                        paymentForm.addEventListener('submit', async function (ev) {
                            ev.preventDefault();
                            var u = auth.currentUser;
                            if (!u) return;
                            var method = selectedPaymentMethod();
                            var keyForMethod = method === 'qrph' ? paymongoClientKeys.qrph : paymongoClientKeys.card;
                            if (!isValidPublishableKeyForMethod(method, keyForMethod)) {
                                await appAlertError(method === 'qrph'
                                    ? 'QRPh live key is not configured. Contact support.'
                                    : 'Card test key is not configured. Contact support.');
                                return;
                            }
                            setPayButtonLoading(true, method === 'qrph' ? 'Generating QR...' : 'Processing...');
                            try {
                                await runPayMongoThenBook(booking);
                            } catch (e) {
                                console.error(e);
                                await appAlertError(formatPaymentError(e) || 'Payment failed. Please try again.');
                            } finally {
                                setPayButtonLoading(false);
                            }
                        });
                    }
                }).catch(async function (e) {
                    if (placeholderText) {
                        placeholderText.textContent = 'Complete payment below once PayMongo keys are configured.';
                        placeholderText.style.display = 'block';
                    }
                    if (paymentForm) paymentForm.classList.remove('is-visible');
                    if (configWarning) configWarning.style.display = 'block';
                    await appAlertError(formatPaymentError(e) || 'PayMongo client keys are not configured.');
                });
            }
        } catch (e) {
            console.warn('Invalid booking data:', e);
            if (placeholderText) placeholderText.textContent = 'Invalid booking data. Go back to Appointments and try again.';
        }
    } else if (!params.get('paymongo_return')) {
        if (placeholderText) placeholderText.textContent = 'No pending booking. Choose a slot from Appointments first.';
    }
} else {
    if (placeholderText) placeholderText.textContent = 'Open this page from the booking flow (Appointments -> book -> pay) to see your summary and pay.';
}

