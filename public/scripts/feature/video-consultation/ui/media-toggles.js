// Wire mic/camera button toggles for current local media stream.
export function wireMediaToggle({ $, btnId, getTracks, icons, labels, onToggle }) {
    $(btnId)?.addEventListener('click', () => {
        const tracks = getTracks();
        if (!tracks || !tracks.length) return;
        const enabled = !tracks[0].enabled;
        tracks[0].enabled = enabled;
        const btn = $(btnId);
        if (!btn) return;
        const iconEl = btn.querySelector('i');
        if (iconEl) iconEl.className = enabled ? icons[0] : icons[1];
        btn.classList.toggle('muted', !enabled);
        btn.setAttribute('aria-label', enabled ? labels[0] : labels[1]);
        try { onToggle?.(enabled); } catch (_) {}
    });
}

