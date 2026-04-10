// Firestore + Storage for saved skin health analyses (per user).
import { db, storage } from '../../core/firebase/firebase-config.js';
import {
    collection,
    addDoc,
    doc,
    deleteDoc,
    query,
    orderBy,
    limit,
    onSnapshot,
    getDocs,
    getDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-storage.js';

export const SKIN_ANALYSES_COLLECTION = 'skinAnalyses';
export const SKIN_ANALYSES_PAGE_SIZE = 50;

// Firestore collection: users/{uid}/skinAnalyses.
export function skinAnalysesCol(uid) {
    return collection(db, 'users', uid, SKIN_ANALYSES_COLLECTION);
}

// Store analysis image in Firebase Storage; returns HTTPS URL and storage path.
export async function uploadSkinAnalysisImage(uid, blob, contentType = 'image/jpeg') {
    const ct = contentType || blob.type || 'image/jpeg';
    const ext = /png/i.test(ct) ? 'png' : 'jpg';
    const path = `skin-analyses/${uid}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const r = ref(storage, path);
    await uploadBytes(r, blob, { contentType: ct });
    const imageUrl = await getDownloadURL(r);
    return { imageUrl, imageStoragePath: path };
}

// Create Firestore skin analysis document; returns new document id.
export async function saveSkinAnalysisRecord(uid, fields) {
    const docRef = await addDoc(skinAnalysesCol(uid), {
        ...fields,
        savedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
    });
    return docRef.id;
}

// Realtime listener for recent analyses (sorted by savedAt); returns unsubscribe.
export function subscribeSkinAnalyses(uid, callback, maxDocs = SKIN_ANALYSES_PAGE_SIZE) {
    const q = query(skinAnalysesCol(uid), orderBy('savedAt', 'desc'), limit(maxDocs));
    return onSnapshot(
        q,
        (snap) => {
            const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
            items.sort((a, b) => savedAtToMs(b.savedAt) - savedAtToMs(a.savedAt));
            callback(items);
        },
        (err) => console.error('skinAnalyses subscription:', err)
    );
}

// One-shot fetch for pickers (messages, booking flow).
export async function listSkinAnalyses(uid, maxDocs = SKIN_ANALYSES_PAGE_SIZE) {
    const q = query(skinAnalysesCol(uid), orderBy('savedAt', 'desc'), limit(maxDocs));
    const snap = await getDocs(q);
    const items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    items.sort((a, b) => savedAtToMs(b.savedAt) - savedAtToMs(a.savedAt));
    return items;
}

// Extract Storage object path from a Firebase getDownloadURL-style HTTPS URL.
function objectPathFromFirebaseDownloadUrl(url) {
    try {
        const pathname = new URL(url.trim()).pathname;
        const m = pathname.match(/\/v\d\/b\/[^/]+\/o\/(.+)$/);
        if (!m) return '';
        return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch {
        return '';
    }
}

// Resolve Storage path for this user from record.path or from imageUrl under skin-analyses/{uid}/.
function resolveSkinAnalysisObjectPath(uid, record) {
    const prefix = `skin-analyses/${uid}/`;
    const raw = typeof record.imageStoragePath === 'string' ? record.imageStoragePath.trim() : '';
    if (raw.startsWith(prefix)) return raw;
    const url = typeof record.imageUrl === 'string' ? record.imageUrl.trim() : '';
    if (!url) return '';
    const fromUrl = objectPathFromFirebaseDownloadUrl(url);
    return fromUrl.startsWith(prefix) ? fromUrl : '';
}

// Delete Firestore doc and Storage object when the path belongs to this user.
export async function deleteSkinAnalysisRecord(uid, record) {
    const analysisId = record?.id;
    if (!analysisId) return;
    const p = resolveSkinAnalysisObjectPath(uid, record);
    if (p) {
        try {
            await deleteObject(ref(storage, p));
        } catch (err) {
            console.warn('deleteSkinAnalysisRecord: storage', err);
        }
    }
    await deleteDoc(doc(db, 'users', uid, SKIN_ANALYSES_COLLECTION, analysisId));
}

// Convert Firestore Timestamp, seconds/nanoseconds map, or compatible value to epoch ms.
export function savedAtToMs(t) {
    if (!t) return 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') {
        try {
            return t.toDate().getTime();
        } catch {
        }
    }
    const sec = t.seconds ?? t._seconds;
    if (sec != null && Number.isFinite(Number(sec))) {
        const ns = Number(t.nanoseconds ?? t._nanoseconds ?? 0);
        return Number(sec) * 1000 + Math.floor(ns / 1e6);
    }
    return 0;
}

// Best-effort saved time in ms from snapshot fields, ISO string, or Firestore timestamps.
export function skinAnalysisSavedAtToMs(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const rawMs = rec.savedAtMs;
    if (rawMs != null && typeof rawMs === 'object' && typeof rawMs.toMillis === 'function') {
        const ms = rawMs.toMillis();
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const n = Number(typeof rawMs === 'string' ? String(rawMs).trim() : rawMs);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    const iso = String(rec.savedAtIso || '').trim();
    if (iso) {
        const parsed = Date.parse(iso);
        if (Number.isFinite(parsed)) return parsed;
    }
    const m = savedAtToMs(rec.savedAt) || savedAtToMs(rec.createdAt);
    return m > 0 ? m : null;
}

// Build a plain object safe to embed in messages or appointment attachments.
export function skinAnalysisToShareSnapshot(rec) {
    const id = rec.id != null ? String(rec.id) : '';
    const savedMs = skinAnalysisSavedAtToMs(rec);
    return {
        imageUrl: String(rec.imageUrl || ''),
        conditionName: String(rec.conditionName || ''),
        savedName: String(rec.savedName || '').trim().slice(0, 120),
        confidence: typeof rec.confidence === 'number' && !Number.isNaN(rec.confidence) ? rec.confidence : 0,
        notes: String(rec.notes || '').trim(),
        savedRecordId: id,
        apiLabel: String(rec.apiLabel || ''),
        petType: String(rec.petType || ''),
        ...(savedMs != null
            ? { savedAtMs: savedMs, savedAtIso: new Date(savedMs).toISOString() }
            : {}),
    };
}

// If attachment lacks saved time, read users/{ownerUid}/skinAnalyses/{savedRecordId} and merge timestamps.
export async function mergeHistorySavedAtIntoAttachedSnapshot(snapshot, ownerUid) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    if (skinAnalysisSavedAtToMs(snapshot) != null) return snapshot;
    const rid = String(snapshot.savedRecordId || '').trim();
    const uid = String(ownerUid || '').trim();
    if (!rid || !uid) return snapshot;
    try {
        const snap = await getDoc(doc(db, 'users', uid, SKIN_ANALYSES_COLLECTION, rid));
        if (!snap.exists()) return snapshot;
        const data = snap.data();
        const combined = { ...data, id: rid };
        let ms = skinAnalysisSavedAtToMs(combined);
        if (ms == null) {
            const t = savedAtToMs(data?.savedAt) || savedAtToMs(data?.createdAt);
            ms = t > 0 ? t : null;
        }
        if (ms == null) return snapshot;
        return { ...snapshot, savedAtMs: ms, savedAtIso: new Date(ms).toISOString() };
    } catch {
        return snapshot;
    }
}

// Fill missing savedAt on appointment.attachedSkinAnalysis from the owner’s skinAnalyses history doc.
export async function enrichAppointmentAttachedSkinFromHistory(apt) {
    if (!apt?.attachedSkinAnalysis || typeof apt.attachedSkinAnalysis !== 'object') return apt;
    const ownerUid = String(apt.ownerId || apt.ownerID || '').trim();
    if (!ownerUid) return apt;
    const merged = await mergeHistorySavedAtIntoAttachedSnapshot(apt.attachedSkinAnalysis, ownerUid);
    if (merged === apt.attachedSkinAnalysis) return apt;
    return { ...apt, attachedSkinAnalysis: merged };
}
