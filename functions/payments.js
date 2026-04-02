'use strict';

function makePayments({
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
}) {
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

  function resolvePaymongoKeyMode(paymentMethod) {
    return paymentMethod === 'qrph' ? 'live' : 'test';
  }

  function requirePaymongoSecretByMode(keyMode) {
    const isLive = keyMode === 'live';
    const raw = isLive ? paymongoSecretKeyLive.value() : paymongoSecretKeyTest.value();
    const v = String(raw || '').trim();
    if (!v) {
      throw new HttpsError(
        'failed-precondition',
        isLive
          ? 'PayMongo live route is not configured. Set PAYMONGO_SECRET_KEY_LIVE (sk_live_…).'
          : 'PayMongo test route is not configured. Set PAYMONGO_SECRET_KEY_TEST (sk_test_…).',
      );
    }
    return v;
  }

  function requirePaymongoPublicKeyByMode(keyMode) {
    const isLive = keyMode === 'live';
    const raw = isLive ? paymongoPublicKeyLive.value() : paymongoPublicKeyTest.value();
    const v = String(raw || '').trim();
    if (!v) {
      throw new HttpsError(
        'failed-precondition',
        isLive
          ? 'PayMongo live publishable key is not configured. Set PAYMONGO_PK_LIVE (pk_live_…).'
          : 'PayMongo test publishable key is not configured. Set PAYMONGO_PK_TEST (pk_test_…).',
      );
    }
    return v;
  }

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
  const payMongoCreatePaymentIntent = onCall(callableOptions, async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Must be logged in.');
    }
    const data = request.data || {};
    const { amount: amountRaw } = data;
    const paymentMethod = String(data?.paymentMethod || 'card').trim().toLowerCase();
    if (!['card', 'qrph'].includes(paymentMethod)) {
      throw new HttpsError('invalid-argument', 'paymentMethod must be card or qrph.');
    }
    const keyMode = resolvePaymongoKeyMode(paymentMethod);
    const secret = requirePaymongoSecretByMode(keyMode);
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
        keyMode,
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
  const payMongoAttachPayment = onCall(callableOptions, async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Must be logged in.');
    }
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
      const keyMode = String(claim.data().keyMode || resolvePaymongoKeyMode(claim.data().paymentMethod || 'card'));
      const secret = requirePaymongoSecretByMode(keyMode);

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
  const payMongoGetPaymentIntentStatus = onCall(callableOptions, async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Must be logged in.');
    }
    const { paymentIntentId } = request.data || {};
    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      throw new HttpsError('invalid-argument', 'paymentIntentId is required.');
    }
    try {
      const claim = await db.collection('paymongo_intents').doc(paymentIntentId).get();
      if (!claim.exists || claim.data().uid !== request.auth.uid) {
        throw new HttpsError('permission-denied', 'This payment does not belong to your account.');
      }
      const keyMode = String(claim.data().keyMode || resolvePaymongoKeyMode(claim.data().paymentMethod || 'card'));
      const secret = requirePaymongoSecretByMode(keyMode);

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

  /** Return method-specific publishable keys so frontend can keep live keys out of static files. */
  const payMongoGetClientConfig = onCall(callableOptions, async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Must be logged in.');
    }
    const pkTest = requirePaymongoPublicKeyByMode('test');
    const pkLive = requirePaymongoPublicKeyByMode('live');
    return {
      publishableKeys: {
        card: pkTest,
        qrph: pkLive,
      },
    };
  });

  return {
    payMongoCreatePaymentIntent,
    payMongoAttachPayment,
    payMongoGetPaymentIntentStatus,
    payMongoGetClientConfig,
  };
}

module.exports = { makePayments };

