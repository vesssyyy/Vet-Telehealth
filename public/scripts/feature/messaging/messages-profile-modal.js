// Profile details modal for messages chat header (peer user + pet).
import { escapeHtml, formatDisplayName, withDr } from '../../core/app/utils.js';
import { ownerDisplayName, vetDisplayName } from './shared-messaging.js';

const $ = id => document.getElementById(id);

function formatValue(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'object' && v !== null && typeof v.toDate === 'function') {
        try {
            const d = v.toDate();
            if (d instanceof Date && !Number.isNaN(d.getTime())) {
                return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            }
        } catch (_) {}
        return '—';
    }
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    const s = String(v).trim();
    return s || '—';
}

// Title for the profile modal (name only; details omit Name).
export function getPeerProfileTitle(data) {
    const role = (data?.role || '').toLowerCase();
    const name = role === 'vet'
        ? vetDisplayName(data || {}, withDr)
        : ownerDisplayName(data || {});
    const s = String(name || '').trim();
    if (s) return formatDisplayName(s);
    return role === 'vet' ? 'Veterinarian' : 'Pet owner';
}

// Key/value rows for the peer profile modal from Firestore user fields.
export function buildPeerProfileRows(data) {
    const role = (data?.role || '').toLowerCase();
    const rows = [
        { label: 'Email', value: formatValue(data?.email) },
        { label: 'Address', value: formatValue(data?.address) },
        { label: 'Contact', value: formatValue(data?.phone) },
    ];
    if (role === 'vet') {
        rows.push(
            { label: 'Specialization', value: formatValue(data?.specialization) },
            { label: 'License no.', value: formatValue(data?.licenseNumber) },
        );
    }
    return rows;
}

const PET_LABELS = {
    name: 'Name',
    species: 'Species',
    breed: 'Breed',
    sex: 'Sex',
    gender: 'Gender',
    age: 'Age (years)',
    weight: 'Weight (kg)',
    color: 'Color',
    microchip: 'Microchip',
    notes: 'Notes',
    bio: 'Bio',
};

const PET_ORDER = ['species', 'breed', 'sex', 'gender', 'age', 'weight', 'color', 'microchip', 'notes', 'bio'];

// Modal title: pet document name, else conversation pet name, else "Pet".
export function getPetProfileTitle(pet, conversationPetName = '') {
    const fromDoc = pet && pet.name != null ? String(pet.name).trim() : '';
    const raw = fromDoc || String(conversationPetName || '').trim();
    if (!raw) return 'Pet';
    return formatDisplayName(raw);
}

const SKIP_PET_KEYS = new Set([
    'imageUrl', 'imageStoragePath', 'photoURL', 'photoUrl', 'createdAt', 'updatedAt',
]);

// Key/value rows for pet details in the modal (ordered fields, skip internal keys).
export function buildPetProfileRows(pet) {
    if (!pet || typeof pet !== 'object') {
        return [];
    }
    const used = new Set(['name']);
    const rows = [];

    for (const key of PET_ORDER) {
        if (!(key in pet) || SKIP_PET_KEYS.has(key)) continue;
        const raw = pet[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const label = PET_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
        let val = raw;
        if (key === 'weight' && typeof raw === 'number') val = `${raw} kg`;
        rows.push({ label, value: formatValue(val) });
        used.add(key);
    }

    for (const [key, raw] of Object.entries(pet)) {
        if (used.has(key) || SKIP_PET_KEYS.has(key) || key === 'id' || key === 'name') continue;
        if (raw === undefined || raw === null || raw === '') continue;
        if (typeof raw === 'object' && raw !== null && typeof raw.toDate !== 'function') continue;
        const label = PET_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
        rows.push({ label, value: formatValue(raw) });
    }

    return rows;
}

function renderRowsHtml(rows) {
    return rows.map(r => `
        <div class="messages-profile-row">
            <dt class="messages-profile-dt">${escapeHtml(r.label)}</dt>
            <dd class="messages-profile-dd">${escapeHtml(r.value)}</dd>
        </div>
    `).join('');
}

// @returns {{ open: (title: string, rows: {label: string, value: string}[]) => void, close: () => void, isOpen: () => boolean }}
export function wireMessagesProfileModal() {
    const overlay = $('messages-profile-overlay');
    const titleEl = $('messages-profile-title');
    const bodyEl = $('messages-profile-body');
    const closeBtn = $('messages-profile-close');

    function close() {
        if (!overlay?.classList.contains('is-open')) return;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
    }

    function open(title, rows) {
        if (!overlay || !titleEl || !bodyEl) return;
        titleEl.textContent = title;
        bodyEl.innerHTML = rows.length
            ? `<dl class="messages-profile-dl">${renderRowsHtml(rows)}</dl>`
            : '';
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        closeBtn?.focus();
    }

    closeBtn?.addEventListener('click', close);
    overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    return {
        open,
        close,
        isOpen: () => Boolean(overlay?.classList.contains('is-open')),
    };
}
