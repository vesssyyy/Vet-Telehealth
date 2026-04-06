'use strict';

/**
 * Capitalize the first letter of each whitespace-separated word (display names).
 * @param {string|null|undefined} str
 * @returns {string}
 */
function formatDisplayName(str) {
  const s = String(str ?? '').trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join(' ');
}

module.exports = { formatDisplayName };
