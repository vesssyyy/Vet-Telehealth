/**
 * Wraps plain password inputs in .password-input-wrap and adds an eye toggle.
 * Safe to call once per page (or again after injecting new password fields into root).
 */
const BTN_HTML = `
<span class="pwt-icon pwt-eye" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
</span>
<span class="pwt-icon pwt-eye-off" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
</span>
`.trim();

function bindToggle(input, btn) {
    const setState = (revealed) => {
        input.type = revealed ? 'text' : 'password';
        btn.classList.toggle('is-revealed', revealed);
        btn.setAttribute('aria-pressed', revealed ? 'true' : 'false');
        btn.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
    };
    btn.addEventListener('click', () => setState(input.type === 'password'));
}

/**
 * @param {ParentNode} [root=document]
 */
export function initPasswordToggleFields(root = document) {
    root.querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.closest('.password-input-wrap')) return;

        const wrap = document.createElement('div');
        wrap.className = 'password-input-wrap';
        const parent = input.parentNode;
        parent.insertBefore(wrap, input);
        wrap.appendChild(input);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'password-toggle-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = BTN_HTML;
        wrap.appendChild(btn);
        bindToggle(input, btn);
    });
}
