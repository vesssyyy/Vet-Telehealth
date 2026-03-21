/** Veterinary consultation summary PDF (jsPDF). */
const NOTES_LABELS = [
    ['observation', 'Observation'],
    ['assessment', 'Assessment'],
    ['prescription', 'Prescription'],
    ['careInstruction', 'Care Instruction'],
    ['followUp', 'Follow-Up'],
];

function orDash(val) {
    return (val != null && String(val).trim() !== '') ? String(val).trim() : '—';
}

function toBulletItems(text) {
    if (!text || String(text).trim() === '') return [];
    return String(text)
        .split(/\n+/)
        .map((s) => s.trim().replace(/^--/, '-'))
        .filter(Boolean);
}

function loadJsPDF() {
    if (typeof window !== 'undefined' && window.jspdf?.jsPDF) {
        return Promise.resolve(window.jspdf);
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        script.async = true;
        script.onload = () => {
            if (window.jspdf?.jsPDF) resolve(window.jspdf);
            else reject(new Error('jsPDF failed to load'));
        };
        script.onerror = () => reject(new Error('Failed to load jsPDF'));
        document.head.appendChild(script);
    });
}

/** @returns {Promise<Blob>} */
export async function generateConsultationPDF(data) {
    const { jsPDF } = await loadJsPDF();
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 16; // ~60px
    let y = margin;

    const owner = data.owner || {};
    const vet = data.vet || {};
    const pet = data.pet || {};
    const apt = data.appointment || {};
    const notes = data.consultationNotes || {};
    const dateTimeStr = data.consultationDateTime || [apt.dateStr, apt.timeDisplay || (apt.slotStart ? `${apt.slotStart} – ${apt.slotEnd || ''}` : '')].filter(Boolean).join(' | ') || '—';

    const ownerName = orDash(owner.displayName || owner.ownerName || owner.name);
    const ownerAddress = orDash(owner.address);
    const ownerEmail = orDash(owner.email || owner.ownerEmail);

    const vetName = orDash(vet.displayName || vet.vetName || vet.name);
    const clinicName = orDash(vet.clinicName || vet.clinic);
    const clinicEmail = orDash(vet.clinicEmail || vet.email);

    const petName = orDash(pet.name || pet.petName);
    const species = orDash(pet.species);
    const breed = orDash(pet.breed);
    const age = orDash(pet.age);
    const weight = orDash(pet.weight != null ? `${pet.weight} kg` : pet.weight);
    const sex = orDash(pet.sex);

    const appointmentTitle = orDash(apt.title || apt.reason);

    const grey = [208, 208, 208];
    const darkGrey = [154, 154, 154];
    const textGrey = [102, 102, 102];

    // --- Logo (centered, bordered) ---
    const logoW = 58;
    const logoH = 12;
    doc.setDrawColor(...grey);
    doc.setLineWidth(0.3);
    doc.rect((pageW - logoW) / 2, y, logoW, logoH, 'S');
    doc.setFontSize(8);
    doc.setTextColor(...darkGrey);
    doc.setFont(undefined, 'bold');
    doc.text('CLINIC LOGO', pageW / 2, y + logoH / 2 + 2, { align: 'center' });
    doc.setTextColor(0, 0, 0);
    doc.setFont(undefined, 'normal');
    y += logoH + 8;

    // --- Top info: Owner (left) | Vet (right) ---
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text(ownerName, margin, y);
    doc.setFont(undefined, 'normal');
    y += 5;
    doc.text(ownerAddress, margin, y);
    y += 5;
    doc.text(ownerEmail, margin, y);

    const col2Y = y - 10;
    doc.setFont(undefined, 'bold');
    doc.text(vetName, pageW - margin, col2Y, { align: 'right' });
    doc.setFont(undefined, 'normal');
    doc.text(clinicName, pageW - margin, col2Y + 5, { align: 'right' });
    doc.text(clinicEmail, pageW - margin, col2Y + 10, { align: 'right' });

    y += 12;

    // --- Divider ---
    doc.setDrawColor(...grey);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 8;

    // --- Title ---
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('VETERINARY CONSULTATION SUMMARY', pageW / 2, y, { align: 'center' });
    doc.setFont(undefined, 'normal');
    y += 3; // ~10px margin-bottom

    // --- Divider ---
    doc.line(margin, y, pageW - margin, y);
    y += 8;

    // --- Appointment ---
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text('Appointment Title:', margin, y);
    doc.setFont(undefined, 'normal');
    doc.text(appointmentTitle, margin + 45, y);
    y += 6;
    doc.setFont(undefined, 'bold');
    doc.text('Date & Time:', margin, y);
    doc.setFont(undefined, 'normal');
    doc.text(dateTimeStr, margin + 45, y);
    y += 10;

    // --- Divider ---
    doc.line(margin, y, pageW - margin, y);
    y += 8;

    // --- Pet Information (2x3 table) ---
    doc.setFont(undefined, 'bold');
    doc.text('Pet Information:', margin, y);
    y += 7;
    doc.setFont(undefined, 'normal');

    const contentW = pageW - margin * 2;
    const halfW = contentW / 2;
    const cellH = 7;
    const petRows = [
        [['Pet Name:', petName], ['Species:', species]],
        [['Breed:', breed], ['Age:', age]],
        [['Sex:', sex], ['Weight:', weight]],
    ];
    petRows.forEach((row, i) => {
        const rowTop = y + i * cellH;
        const textY = rowTop + 5;
        doc.setDrawColor(...grey);
        doc.rect(margin, rowTop, halfW, cellH, 'S');
        doc.rect(margin + halfW, rowTop, halfW, cellH, 'S');
        doc.setFont(undefined, 'bold');
        doc.text(row[0][0], margin + 3, textY);
        doc.setFont(undefined, 'normal');
        doc.text(row[0][1], margin + 32, textY);
        doc.setFont(undefined, 'bold');
        doc.text(row[1][0], margin + halfW + 3, textY);
        doc.setFont(undefined, 'normal');
        doc.text(row[1][1], margin + halfW + 32, textY);
    });
    y += petRows.length * cellH + 8;

    // --- Divider ---
    doc.line(margin, y, pageW - margin, y);
    y += 8;

    // --- Notes (Observation, Assessment, Prescription, Care Instruction, Follow-Up) ---
    doc.setFontSize(10);
    const textW = contentW - 4;

    NOTES_LABELS.forEach(([key, label]) => {
        doc.setFont(undefined, 'bold');
        doc.text(`${label}:`, margin, y);
        doc.setFont(undefined, 'normal');
        y += 5;
        const raw = orDash(notes[key]);
        const items = toBulletItems(raw);
        if (items.length > 0) {
            items.forEach((item) => {
                const lines = doc.splitTextToSize(item, textW - 6);
                lines.forEach((line) => {
                    doc.text(line, margin + 4, y);
                    y += 5;
                });
            });
        } else {
            const lines = doc.splitTextToSize(raw, textW - 6);
            lines.forEach((line) => {
                doc.text(line, margin + 4, y);
                y += 5;
            });
        }
        y += 4;
    });

    y += 8;

    // --- Divider ---
    doc.line(margin, y, pageW - margin, y);
    y += 12;

    // --- System message (centered, italic, grey) ---
    doc.setFont(undefined, 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...textGrey);
    const sysMsg = 'This document was automatically generated by the system based on the veterinary consultation record and does not require a physical signature.';
    const sysLines = doc.splitTextToSize(sysMsg, contentW);
    sysLines.forEach((line) => {
        doc.text(line, pageW / 2, y, { align: 'center' });
        y += 5;
    });
    doc.setTextColor(0, 0, 0);
    doc.setFont(undefined, 'normal');

    // --- Download info (bottom-right) ---
    const downloadY = pageH - 12;
    const downloadStr = 'Downloaded on: ' + new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    doc.setFontSize(8);
    doc.setTextColor(...textGrey);
    doc.text(downloadStr, pageW - margin, downloadY, { align: 'right' });
    doc.setTextColor(0, 0, 0);

    return doc.output('blob');
}
