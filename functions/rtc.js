'use strict';

function parseCsvParam(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeRtc({
  onCall,
  HttpsError,
  callableOptions,
  rtcTurnUrls,
  rtcTurnUsername,
  rtcTurnCredential,
}) {
  if (!onCall || !HttpsError) {
    throw new Error('makeRtc: missing onCall/HttpsError');
  }

  const getRtcIceServers = onCall(callableOptions, async (request) => {
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

  return { getRtcIceServers };
}

module.exports = { makeRtc };

