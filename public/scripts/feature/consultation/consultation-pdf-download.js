// Load appointment + related profiles and download consultation summary PDF.
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { db } from '../../core/firebase/firebase-config.js';
import { appAlertError } from '../../core/ui/app-dialog.js';
import { generateConsultationPDF } from '../../core/pdf/consultation-pdf.js';

async function fetchDoc(path, ...segments) {
    try {
        const s = await getDoc(doc(db, path, ...segments));
        return s.exists() ? s.data() : {};
    } catch (e) {
        console.warn('fetchDoc', path, e);
        return {};
    }
}

export async function downloadConsultationReportForAppointment(appointmentId, buttonEl) {
    if (!appointmentId?.trim()) {
        await appAlertError('Missing appointment.');
        return;
    }
    const prevHtml = buttonEl?.innerHTML;
    const setBusy = (busy) => {
        if (!buttonEl) return;
        buttonEl.disabled = busy;
        if (busy) {
            buttonEl.innerHTML = '<i class="fa fa-spinner fa-spin" aria-hidden="true"></i>';
        } else if (prevHtml != null) {
            buttonEl.innerHTML = prevHtml;
        }
    };
    try {
        setBusy(true);
        const snap = await getDoc(doc(db, 'appointments', appointmentId.trim()));
        if (!snap.exists()) {
            await appAlertError('Appointment not found.');
            return;
        }
        const aptData = { id: snap.id, ...snap.data() };
        const { ownerId, vetId, petId } = aptData;
        const [ownerProfile, vetProfile, petData] = await Promise.all([
            ownerId ? fetchDoc('users', ownerId) : Promise.resolve({}),
            vetId ? fetchDoc('users', vetId) : Promise.resolve({}),
            ownerId && petId ? fetchDoc('users', ownerId, 'pets', petId) : Promise.resolve({}),
        ]);
        const consultationNotes = aptData.consultationNotes && typeof aptData.consultationNotes === 'object'
            ? aptData.consultationNotes
            : {};
        const timeDisplayForPdf = aptData.timeDisplay
            || (aptData.slotStart && aptData.slotEnd ? `${aptData.slotStart} – ${aptData.slotEnd}` : aptData.slotStart || '');
        const dateStr = aptData.dateStr || aptData.date || '';
        const blob = await generateConsultationPDF({
            owner: {
                displayName: aptData.ownerName || ownerProfile.displayName,
                address: ownerProfile.address,
                email: aptData.ownerEmail || ownerProfile.email,
            },
            vet: {
                displayName: aptData.vetName || vetProfile.displayName,
                clinicName: aptData.clinicName || vetProfile.clinicName || vetProfile.clinic,
                clinicAddress: vetProfile.clinicAddress || vetProfile.address,
                clinicEmail: vetProfile.clinicEmail || vetProfile.email,
                licenseNumber: vetProfile.licenseNumber,
            },
            pet: {
                name: aptData.petName || petData.name,
                species: petData.species || aptData.petSpecies,
                breed: petData.breed,
                age: petData.age,
                weight: petData.weight,
                sex: petData.sex,
            },
            appointment: {
                title: aptData.title,
                reason: aptData.reason,
                dateStr,
                timeDisplay: timeDisplayForPdf,
                slotStart: aptData.slotStart,
                slotEnd: aptData.slotEnd,
            },
            consultationNotes,
            consultationDateTime: [dateStr, timeDisplayForPdf].filter(Boolean).join(' · ') || undefined,
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Consultation-Summary-${aptData.petName || 'Pet'}-${new Date().toISOString().slice(0, 10)}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        console.error('PDF generation failed:', e);
        await appAlertError('Could not generate the PDF. Please try again.');
    } finally {
        setBusy(false);
    }
}
