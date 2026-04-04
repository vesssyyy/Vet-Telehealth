import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { withDr } from '../../../core/app/utils.js';
import { formatAppointmentDateNoWeekday } from '../../appointment/shared/time.js';
import { ownerDisplayName, vetDisplayName } from '../../messaging/shared-messaging.js';
import { buildSharedMediaMarkup } from '../utils/shared-media.js';

/** VC header datetime: avoid duplicating date when `timeDisplay` already includes it (pet-owner bookings). */
function formatConsultationHeaderDatetime(appointmentData) {
    const dateRaw = String(appointmentData.dateStr || appointmentData.date || '').trim();
    const timeRaw = String(appointmentData.timeDisplay || '').trim();
    if (!dateRaw && !timeRaw) return '';

    const sep = ' · ';
    const normalizeRangeDashes = (s) => s.replace(/\s*[–—]\s*/g, ' – ');

    if (timeRaw && /\s+at\s+/i.test(timeRaw)) {
        return normalizeRangeDashes(timeRaw.replace(/\s+at\s+/i, sep));
    }
    if (dateRaw && timeRaw) {
        const dateLabel = formatAppointmentDateNoWeekday(dateRaw);
        return `${dateLabel}${sep}${normalizeRangeDashes(timeRaw)}`;
    }
    if (timeRaw) return normalizeRangeDashes(timeRaw);
    return formatAppointmentDateNoWeekday(dateRaw);
}

/**
 * Populate VC appointment-related UI (pet, concern/media, participant labels/avatars, title/datetime).
 * Returns basic computed values for downstream logic.
 */
export async function populateVideoCallAppointmentUI(options = {}) {
    const {
        db,
        user,
        appointmentData,
        isVet,
        isPetOwner,
        otherParticipantLabelEl,
        localVideoLabelEl,
        consultationTitleEl,
        consultationDatetimeEl,
        $ = (id) => document.getElementById(id),
    } = options;

    const petName = appointmentData.petName || 'Pet';
    const detailsPetNameEl = $('details-pet-name');
    const petLabelEl = document.getElementById('pet-name-label');
    if (petLabelEl) petLabelEl.textContent = petName;
    if (detailsPetNameEl) detailsPetNameEl.textContent = petName;

    const ownerId = appointmentData.ownerId;
    const vetId = appointmentData.vetId;
    const petId = appointmentData.petId;

    const petImgEl = document.getElementById('pet-placeholder-img');
    const petImageWrap = document.querySelector('.sidebar-card-image--pet');
    if (petId && ownerId) {
        try {
            const petSnap = await getDoc(doc(db, 'users', ownerId, 'pets', petId));
            const petData = petSnap.exists() ? petSnap.data() : {};
            if (petImgEl && petData.imageUrl) {
                petImgEl.style.opacity = '0';
                petImgEl.style.transition = 'opacity 0.35s ease';
                petImgEl.onload = () => { requestAnimationFrame(() => { petImgEl.style.opacity = '1'; }); };
                petImgEl.src = petData.imageUrl;
                petImgEl.alt = petName;
                if (petImageWrap) petImageWrap.classList.add('has-pet-image');
            }
            const setBasicInfo = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value != null && value !== '' ? String(value) : '—';
            };
            setBasicInfo('pet-years-old', petData.age);
            setBasicInfo('pet-weight', petData.weight != null ? `${petData.weight} kg` : null);
            setBasicInfo('pet-species', petData.species);
            setBasicInfo('pet-breed', petData.breed);
            const detailsPetImg = $('details-pet-img');
            const detailsPetFallback = $('details-pet-fallback');
            const detailsPetAvatar = detailsPetImg?.closest('.details-pet-avatar');
            if (detailsPetImg && petData.imageUrl) {
                detailsPetImg.style.opacity = '0';
                detailsPetImg.style.transition = 'opacity 0.35s ease';
                detailsPetImg.onload = () => { requestAnimationFrame(() => { detailsPetImg.style.opacity = '1'; }); };
                detailsPetImg.src = petData.imageUrl;
                detailsPetImg.alt = petName;
                detailsPetImg.removeAttribute('aria-hidden');
                if (detailsPetFallback) detailsPetFallback.setAttribute('aria-hidden', 'true');
                if (detailsPetAvatar) detailsPetAvatar.classList.add('has-avatar');
            }
            setBasicInfo('details-pet-age', petData.age);
            setBasicInfo('details-pet-weight', petData.weight != null ? `${petData.weight} kg` : null);
            setBasicInfo('details-pet-species', petData.species);
            setBasicInfo('details-pet-breed', petData.breed);
        } catch (e) {
            console.warn('Could not load pet data', e);
        }
    }

    const concernText = (appointmentData.reason && String(appointmentData.reason).trim()) || '';
    const concernPlaceholder = document.querySelector('#pet-detail-concern .sidebar-pet-detail-placeholder');
    if (concernPlaceholder) concernPlaceholder.textContent = concernText || 'No concern provided.';
    const detailsConcernEl = $('details-concern-text');
    if (detailsConcernEl) detailsConcernEl.textContent = concernText || 'No concern provided.';

    const mediaUrls = Array.isArray(appointmentData.mediaUrls) ? appointmentData.mediaUrls : [];
    const sharedImagesPane = $('pet-detail-shared-images');
    if (sharedImagesPane) {
        const placeholder = sharedImagesPane.querySelector('.sidebar-pet-detail-placeholder');
        if (placeholder) {
            if (mediaUrls.length === 0) {
                placeholder.textContent = 'No images shared for this consultation.';
                placeholder.classList.remove('is-hidden');
            } else {
                placeholder.classList.add('is-hidden');
                let gallery = sharedImagesPane.querySelector('.sidebar-pet-shared-gallery');
                if (!gallery) {
                    gallery = document.createElement('div');
                    gallery.className = 'sidebar-pet-shared-gallery';
                    sharedImagesPane.appendChild(gallery);
                }
                gallery.innerHTML = buildSharedMediaMarkup(mediaUrls);
            }
        }
    }

    const detailsGallery = $('details-shared-gallery');
    const detailsSharedPlaceholder = $('details-shared-placeholder');
    if (detailsGallery && detailsSharedPlaceholder) {
        if (mediaUrls.length === 0) {
            detailsSharedPlaceholder.textContent = 'No images shared for this consultation.';
            detailsSharedPlaceholder.classList.remove('is-hidden');
            detailsGallery.innerHTML = '';
        } else {
            detailsSharedPlaceholder.classList.add('is-hidden');
            detailsGallery.innerHTML = buildSharedMediaMarkup(mediaUrls);
        }
    }

    const otherUid = isPetOwner ? vetId : ownerId;
    const otherParticipantNameEl = document.getElementById('other-participant-name');
    const otherParticipantImgEl = document.getElementById('other-participant-img');
    const otherParticipantInitialEl = document.getElementById('other-participant-initial');
    const otherAvatarWrap = document.getElementById('other-participant-avatar');

    try {
        if (otherUid) {
            const otherSnap = await getDoc(doc(db, 'users', otherUid));
            const otherData = otherSnap.exists() ? otherSnap.data() : {};
            const displayOtherName = isPetOwner
                ? vetDisplayName(otherData, withDr)
                : ownerDisplayName(otherData);
            if (otherParticipantNameEl) otherParticipantNameEl.textContent = displayOtherName;
            const photoURL = otherData.photoURL || otherData.photoUrl || '';
            if (photoURL && otherParticipantImgEl) {
                otherParticipantImgEl.style.opacity = '0';
                otherParticipantImgEl.style.transition = 'opacity 0.35s ease';
                otherParticipantImgEl.onload = () => { requestAnimationFrame(() => { otherParticipantImgEl.style.opacity = '1'; }); };
                otherParticipantImgEl.src = photoURL;
                otherParticipantImgEl.alt = displayOtherName;
                if (otherAvatarWrap) otherAvatarWrap.classList.add('has-avatar');
            } else if (otherParticipantInitialEl) {
                const initial = (displayOtherName || '?').trim().charAt(0).toUpperCase();
                otherParticipantInitialEl.textContent = initial;
            }
            if (otherParticipantLabelEl) otherParticipantLabelEl.classList.add('is-hidden');

            const detailsOtherName = $('details-other-name');
            const detailsOtherImg = $('details-other-img');
            const detailsOtherInitial = $('details-other-initial');
            const detailsOtherAvatarWrap = $('details-other-avatar-wrap');
            if (detailsOtherName) detailsOtherName.textContent = displayOtherName;
            if (photoURL && detailsOtherImg) {
                detailsOtherImg.style.opacity = '0';
                detailsOtherImg.style.transition = 'opacity 0.35s ease';
                detailsOtherImg.onload = () => { requestAnimationFrame(() => { detailsOtherImg.style.opacity = '1'; }); };
                detailsOtherImg.src = photoURL;
                detailsOtherImg.alt = displayOtherName;
                detailsOtherImg.removeAttribute('aria-hidden');
                if (detailsOtherInitial) detailsOtherInitial.setAttribute('aria-hidden', 'true');
                if (detailsOtherAvatarWrap) detailsOtherAvatarWrap.classList.add('has-avatar');
            } else if (detailsOtherInitial) {
                detailsOtherInitial.textContent = (displayOtherName || '?').trim().charAt(0).toUpperCase();
                detailsOtherInitial.removeAttribute('aria-hidden');
                if (detailsOtherImg) detailsOtherImg.setAttribute('aria-hidden', 'true');
            }

            const convoNameEl = document.getElementById('convo-panel-with-name');
            const convoImgEl = document.getElementById('convo-panel-avatar-img');
            const convoFallbackEl = document.getElementById('convo-panel-avatar-fallback');
            if (convoNameEl) convoNameEl.textContent = displayOtherName;
            if (photoURL && convoImgEl) {
                convoImgEl.style.opacity = '0';
                convoImgEl.style.transition = 'opacity 0.35s ease';
                convoImgEl.onload = () => { requestAnimationFrame(() => { convoImgEl.style.opacity = '1'; }); };
                convoImgEl.src = photoURL;
                convoImgEl.alt = displayOtherName;
                convoImgEl.classList.remove('is-hidden');
                if (convoFallbackEl) convoFallbackEl.classList.add('is-hidden');
            } else if (convoFallbackEl) {
                convoFallbackEl.textContent = (displayOtherName || '?').trim().charAt(0).toUpperCase();
                convoFallbackEl.classList.remove('is-hidden');
                if (convoImgEl) convoImgEl.classList.add('is-hidden');
            }
        } else {
            if (otherParticipantNameEl) otherParticipantNameEl.textContent = isPetOwner ? 'Vet' : 'Pet Owner';
            if (otherParticipantInitialEl) otherParticipantInitialEl.textContent = '?';
            const detailsOtherName = $('details-other-name');
            if (detailsOtherName) detailsOtherName.textContent = isPetOwner ? 'Vet' : 'Pet Owner';
            const detailsOtherInitial = $('details-other-initial');
            if (detailsOtherInitial) {
                detailsOtherInitial.textContent = '?';
                detailsOtherInitial.removeAttribute('aria-hidden');
            }
        }
    } catch (e) {
        console.warn('Could not load other participant', e);
        if (otherParticipantNameEl) otherParticipantNameEl.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
        if (otherParticipantInitialEl) otherParticipantInitialEl.textContent = '?';
        const convoNameEl = document.getElementById('convo-panel-with-name');
        if (convoNameEl) convoNameEl.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
        const detailsOtherName = $('details-other-name');
        if (detailsOtherName) detailsOtherName.textContent = isPetOwner ? 'Veterinarian' : 'Pet Owner';
        const detailsOtherInitial = $('details-other-initial');
        if (detailsOtherInitial) {
            detailsOtherInitial.textContent = '?';
            detailsOtherInitial.removeAttribute('aria-hidden');
        }
    }

    let myName = isVet ? 'Vet' : 'Pet Owner';
    try {
        const meSnap = await getDoc(doc(db, 'users', user.uid));
        const meData = meSnap.exists() ? meSnap.data() : {};
        myName = (meData.displayName || user.displayName || '').trim() || myName;
    } catch (e) {
        console.warn('Could not load current user for label', e);
    }
    const localLabel = isVet ? withDr(myName) : myName;
    if (localVideoLabelEl) localVideoLabelEl.textContent = localLabel;
    if (otherParticipantLabelEl) otherParticipantLabelEl.classList.add('is-hidden');

    const convoNameEl = document.getElementById('convo-panel-with-name');
    const ownerNameForTitle = isPetOwner ? myName : (otherParticipantNameEl?.textContent || '');
    if (convoNameEl) convoNameEl.textContent = `${petName} – ${ownerNameForTitle}`;

    if (consultationTitleEl) {
        const title = (appointmentData.title && String(appointmentData.title).trim()) || '';
        consultationTitleEl.textContent = title || `${petName} — ${(appointmentData.reason || 'Consultation').toString().slice(0, 30)}`;
    }
    if (consultationDatetimeEl && (appointmentData.dateStr || appointmentData.date || appointmentData.timeDisplay)) {
        consultationDatetimeEl.textContent = formatConsultationHeaderDatetime(appointmentData) || '—';
    }

    return {
        petName,
        ownerId,
        vetId,
        otherParticipantNameEl,
        myName,
    };
}

