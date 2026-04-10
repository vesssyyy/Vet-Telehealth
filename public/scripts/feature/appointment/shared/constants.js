// Appointment feature constants (shared by pet owner + vet).
export const APPOINTMENTS_COLLECTION = 'appointments';
export const CLINIC_HOURS_PLACEHOLDER = 'Online consultation (time TBC)';
export const DEFAULT_MIN_ADVANCE_MINUTES = 60;
export const DEFAULT_SLOT_DURATION_MINUTES = 30;

// Legacy single fee / default when vet has not set split fees (centavos). PHP 100.00
export const DEFAULT_CONSULTATION_PRICE_CENTAVOS = 10000;
// Default test (card) fee when unset (centavos).
export const DEFAULT_CONSULTATION_PRICE_CENTAVOS_TEST = DEFAULT_CONSULTATION_PRICE_CENTAVOS;
// Default live (QRPh) fee when unset (centavos).
export const DEFAULT_CONSULTATION_PRICE_CENTAVOS_LIVE = DEFAULT_CONSULTATION_PRICE_CENTAVOS;
// Minimum test (card) charge (PHP 2.00).
export const MIN_CONSULTATION_PRICE_CENTAVOS_TEST = 200;
// Minimum live (QRPh) charge (PHP 2.00).
export const MIN_CONSULTATION_PRICE_CENTAVOS_LIVE = 200;
