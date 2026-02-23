/** Televet Health — Vet Dashboard */
(function () {
    'use strict';
    const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

    document.addEventListener('DOMContentLoaded', () => {
        const dateEl = document.getElementById('dashboard-date');
        if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const dateSelect = document.getElementById('appointment-date-select');
        const dateInput = document.getElementById('appointment-date-input');
        const dropdown = document.getElementById('vet-view-dropdown');
        const trigger = document.getElementById('vet-view-trigger');
        const triggerText = trigger?.querySelector('.vet-view-trigger-text');
        const menu = document.getElementById('vet-view-menu');
        if (!dateInput) return;
        dateInput.min = dateInput.value = todayISO();
        const toggle = () => { const show = dateSelect?.value === 'custom'; dateInput.disabled = !show; dateInput.style.display = show ? '' : 'none'; if (!dateInput.value && dateInput.min) dateInput.value = dateInput.min; };
        dateSelect?.addEventListener('change', toggle);
        toggle();

        if (dropdown && trigger && triggerText && menu) {
            const setOpen = (open) => { dropdown.classList.toggle('is-open', open); trigger.setAttribute('aria-expanded', open); };
            menu.querySelectorAll('.vet-view-item').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const val = btn.dataset.value;
                    const label = val === 'custom' ? 'Choose date…' : 'Today';
                    dateSelect.value = val;
                    triggerText.textContent = label;
                    setOpen(false);
                    dateSelect.dispatchEvent(new Event('change'));
                });
            });
            trigger.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!dropdown.classList.contains('is-open')); });
            dropdown.addEventListener('click', (e) => e.stopPropagation());
            document.addEventListener('click', () => setOpen(false));
        }

        dateInput.addEventListener('change', () => { if (dateInput.value && dateInput.min && dateInput.value < dateInput.min) { alert('You cannot select a past date.'); dateInput.value = dateInput.min; } });
    });
})();
