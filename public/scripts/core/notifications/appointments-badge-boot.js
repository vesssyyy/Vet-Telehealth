import { subscribeVetAppointmentNotifications } from './appointment-notifications.js';

// Boot once per page load (no-op if imported multiple times).
if (!window.__telehealthAppointmentsNotifBoot) {
    window.__telehealthAppointmentsNotifBoot = true;
    subscribeVetAppointmentNotifications();
}

