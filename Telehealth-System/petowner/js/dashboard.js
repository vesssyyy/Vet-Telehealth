/**
 * Dashboard-specific scripts for pet owner portal
 * Pet switching and Add Pet are handled by pet-manager.js
 */
(function () {
    'use strict';

    const dateEl = document.getElementById('dashboard-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
})();
