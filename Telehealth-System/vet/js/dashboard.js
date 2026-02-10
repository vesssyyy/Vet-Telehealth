/** Televet Health — Vet Dashboard */
(function () {
    'use strict';
    const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

    document.addEventListener('DOMContentLoaded', () => {
        const dateEl = document.getElementById('dashboard-date');
        if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const dateSelect = document.getElementById('appointment-date-select'), dateInput = document.getElementById('appointment-date-input');
        if (!dateInput) return;
        dateInput.min = dateInput.value = todayISO();
        const toggle = () => { const show = dateSelect?.value === 'custom'; dateInput.disabled = !show; dateInput.style.display = show ? '' : 'none'; if (!dateInput.value && dateInput.min) dateInput.value = dateInput.min; };
        dateSelect?.addEventListener('change', toggle);
        toggle();
        dateInput.addEventListener('change', () => { if (dateInput.value && dateInput.min && dateInput.value < dateInput.min) { alert('You cannot select a past date.'); dateInput.value = dateInput.min; } });
    });
})();
