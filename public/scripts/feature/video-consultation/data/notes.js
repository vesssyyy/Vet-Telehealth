import { updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import {
    CONSULTATION_NOTES_FIELDS,
} from '../utils/notes-fields.js';
import {
    getMappedFieldValues,
    setMappedFieldValues,
} from '../utils/field-mapping.js';

/**
 * Wire vet notes autosave and expose form getters/setters.
 */
export function initVideoCallNotes(options = {}) {
    const {
        isVet = false,
        appointmentRef = null,
        appointmentData = null,
        notesTextareas = [],
        resizeNotesTextarea = () => {},
        $ = (id) => document.getElementById(id),
    } = options;

    const notesAutosaveEl = $('notes-autosave-status');
    let notesSaveTimeout = null;
    const NOTES_DEBOUNCE_MS = 1200;

    function getNotesFromForm() {
        return getMappedFieldValues(CONSULTATION_NOTES_FIELDS, $);
    }

    function setNotesToForm(data) {
        setMappedFieldValues(CONSULTATION_NOTES_FIELDS, data, $);
        notesTextareas?.forEach((id) => resizeNotesTextarea($(id)));
    }

    function showNotesAutosaveStatus(text, isSuccess = true) {
        if (!notesAutosaveEl) return;
        notesAutosaveEl.textContent = text;
        notesAutosaveEl.classList.toggle('is-saved', isSuccess);
        notesAutosaveEl.classList.toggle('is-saving', !isSuccess && text);
        if (text) {
            setTimeout(() => {
                notesAutosaveEl.textContent = '';
                notesAutosaveEl.classList.remove('is-saved', 'is-saving');
            }, 2500);
        }
    }

    async function saveNotesToFirestore() {
        if (!isVet || !appointmentRef) return;
        const notes = getNotesFromForm();
        try {
            showNotesAutosaveStatus('Saving…', false);
            await updateDoc(appointmentRef, {
                consultationNotes: notes,
                consultationNotesUpdatedAt: serverTimestamp(),
            });
            showNotesAutosaveStatus('Saved');
        } catch (e) {
            console.warn('Notes auto-save failed:', e);
            showNotesAutosaveStatus('Save failed');
        }
    }

    function scheduleNotesSave() {
        if (!isVet) return;
        if (notesSaveTimeout) clearTimeout(notesSaveTimeout);
        notesSaveTimeout = setTimeout(saveNotesToFirestore, NOTES_DEBOUNCE_MS);
    }

    if (isVet) {
        const saved = appointmentData?.consultationNotes;
        if (saved && typeof saved === 'object') setNotesToForm(saved);
        CONSULTATION_NOTES_FIELDS.forEach(({ id }) => {
            const el = $(id);
            if (el) {
                el.addEventListener('input', scheduleNotesSave);
                el.addEventListener('paste', () => setTimeout(scheduleNotesSave, 0));
            }
        });
    }

    return {
        getNotesFromForm,
        setNotesToForm,
        saveNotesToFirestore,
        scheduleNotesSave,
    };
}

