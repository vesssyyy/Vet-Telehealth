/**
 * Centered in-app dialogs to replace native alert/confirm (browser chrome at top of window).
 */

const ROOT_ID = 'telehealth-app-dialog';

function injectStyles() {
    if (document.getElementById('telehealth-app-dialog-styles-v6')) return;
    const style = document.createElement('style');
    style.id = 'telehealth-app-dialog-styles-v6';
    style.textContent = `
#${ROOT_ID}.app-dialog {
  position: fixed; inset: 0; z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
  box-sizing: border-box;
}
#${ROOT_ID}.app-dialog.is-hidden { display: none !important; }
#${ROOT_ID} .app-dialog__backdrop {
  position: absolute; inset: 0;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
}
/* Portrait column; flex so long copy scrolls inside the panel on short screens */
#${ROOT_ID} .app-dialog__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  max-width: min(340px, calc(100vw - max(24px, calc(env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px)))));
  max-height: min(90vh, 640px);
  max-height: min(92dvh, calc(100dvh - max(24px, env(safe-area-inset-top, 0px)) - max(24px, env(safe-area-inset-bottom, 0px))));
  margin: auto;
  background: #fff;
  border-radius: 18px;
  box-shadow: 0 24px 48px -12px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06);
  padding: clamp(22px, 5vw, 32px) clamp(18px, 4vw, 22px) clamp(18px, 4vw, 26px);
  animation: app-dialog-in 0.2s ease-out;
}
/* Subtle error hint only */
#${ROOT_ID} .app-dialog__panel--error {
  background: linear-gradient(180deg, #fdfcfc 0%, #faf7f7 100%);
  box-shadow: 0 24px 48px -12px rgba(0,0,0,.22), 0 0 0 1px rgba(180, 83, 83, 0.12);
  border-left: 2px solid #e8b4b4;
}
@keyframes app-dialog-in {
  from { opacity: 0; transform: scale(0.96) translateY(6px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .app-dialog__panel { animation: none; }
}
#${ROOT_ID} .app-dialog__title {
  flex-shrink: 0;
  margin: 0 0 12px;
  font-size: clamp(1rem, 3.8vw, 1.0625rem);
  font-weight: 600;
  color: #111827;
  line-height: 1.35;
  text-align: center;
}
#${ROOT_ID} .app-dialog__title:empty { display: none; }
#${ROOT_ID} .app-dialog__message {
  flex: 0 1 auto;
  min-height: 0;
  max-height: min(38vh, 280px);
  max-height: min(42dvh, min(320px, calc(100dvh - 11rem)));
  margin: 0 0 clamp(16px, 4vw, 24px);
  padding: 0 2px;
  font-size: clamp(15px, 3.9vw, 16px);
  line-height: 1.6;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: center;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
#${ROOT_ID} .app-dialog__panel--error .app-dialog__message {
  color: #57534e;
}
#${ROOT_ID} .app-dialog__actions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  gap: 10px;
  align-items: stretch;
}
/* Yes / No side by side (stacks on very narrow phones for easier taps) */
#${ROOT_ID}.app-dialog--confirm .app-dialog__actions {
  flex-direction: row;
  flex-wrap: nowrap;
  gap: clamp(8px, 2.5vw, 12px);
  align-items: stretch;
}
@media (max-width: 320px) {
  #${ROOT_ID}.app-dialog--confirm .app-dialog__actions {
    flex-direction: column;
  }
  #${ROOT_ID}.app-dialog--confirm .app-dialog__btn {
    width: 100%;
    flex: none;
  }
}
#${ROOT_ID}.app-dialog--confirm .app-dialog__btn {
  width: auto;
  flex: 1 1 0;
  min-width: 0;
}
#${ROOT_ID} .app-dialog__btn {
  width: 100%;
  min-height: 48px;
  padding: 12px 18px;
  font-size: 16px;
  font-weight: 500;
  font-family: inherit;
  border-radius: 12px;
  cursor: pointer;
  border: none;
  transition: background 0.2s, opacity 0.2s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
#${ROOT_ID} .app-dialog__btn--secondary {
  background: #f3f4f6;
  color: #374151;
}
#${ROOT_ID} .app-dialog__btn--secondary:hover { background: #e5e7eb; }
#${ROOT_ID} .app-dialog__btn--primary {
  background: #2c5f7d;
  color: #fff;
}
#${ROOT_ID} .app-dialog__btn--primary:hover { background: #1e4159; }
/* Error alerts: primary action is muted rose (not brand blue) */
#${ROOT_ID} .app-dialog__panel--error .app-dialog__btn--primary {
  background: #b85858;
  color: #fff;
}
#${ROOT_ID} .app-dialog__panel--error .app-dialog__btn--primary:hover { background: #9c4848; }
#${ROOT_ID} .app-dialog__btn.is-hidden { display: none !important; }
`;
    document.head.appendChild(style);
}

function ensureRoot() {
    injectStyles();
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'app-dialog is-hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
        <div class="app-dialog__backdrop" data-app-dialog-backdrop tabindex="-1"></div>
        <div class="app-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title-el" aria-describedby="app-dialog-msg-el">
            <h2 id="app-dialog-title-el" class="app-dialog__title"></h2>
            <p id="app-dialog-msg-el" class="app-dialog__message"></p>
            <div class="app-dialog__actions">
                <button type="button" class="app-dialog__btn app-dialog__btn--secondary" id="app-dialog-btn-cancel">No</button>
                <button type="button" class="app-dialog__btn app-dialog__btn--primary" id="app-dialog-btn-ok">Yes</button>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    return root;
}

let escapeHandler = null;

function hideRoot(root) {
    root.classList.add('is-hidden');
    root.setAttribute('aria-hidden', 'true');
    if (escapeHandler) {
        document.removeEventListener('keydown', escapeHandler);
        escapeHandler = null;
    }
}

/**
 * @param {string} message
 * @param {{ variant?: 'default' | 'error' }} [options] - Use `variant: 'error'` for failures / validation (reddish panel).
 * @returns {Promise<void>}
 */
export function appAlert(message, options = {}) {
    const variant = options.variant === 'error' ? 'error' : 'default';
    return new Promise((resolve) => {
        const root = ensureRoot();
        const panel = root.querySelector('.app-dialog__panel');
        const titleEl = root.querySelector('#app-dialog-title-el');
        const msgEl = root.querySelector('#app-dialog-msg-el');
        const cancelBtn = root.querySelector('#app-dialog-btn-cancel');
        const okBtn = root.querySelector('#app-dialog-btn-ok');
        const backdrop = root.querySelector('[data-app-dialog-backdrop]');

        root.classList.remove('app-dialog--confirm');
        panel?.classList.toggle('app-dialog__panel--error', variant === 'error');
        titleEl.textContent = '';
        msgEl.textContent = message;
        cancelBtn.classList.add('is-hidden');
        okBtn.textContent = 'OK';

        const finish = () => {
            root.classList.remove('app-dialog--confirm');
            panel?.classList.remove('app-dialog__panel--error');
            hideRoot(root);
            okBtn.removeEventListener('click', onOk);
            backdrop.removeEventListener('click', onOk);
            resolve();
        };
        const onOk = () => finish();

        okBtn.addEventListener('click', onOk);
        backdrop.addEventListener('click', onOk);

        escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish();
            }
        };
        document.addEventListener('keydown', escapeHandler);

        root.classList.remove('is-hidden');
        root.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => okBtn.focus());
    });
}

/** Shorthand for `appAlert(message, { variant: 'error' })`. */
export function appAlertError(message) {
    return appAlert(message, { variant: 'error' });
}

/**
 * @param {string} message
 * @param {{ confirmText?: string, cancelText?: string, title?: string }} [options]
 * @returns {Promise<boolean>}
 */
export function appConfirm(message, options = {}) {
    const { confirmText = 'Yes', cancelText = 'No', title = '' } = options;
    return new Promise((resolve) => {
        const root = ensureRoot();
        const panel = root.querySelector('.app-dialog__panel');
        const titleEl = root.querySelector('#app-dialog-title-el');
        const msgEl = root.querySelector('#app-dialog-msg-el');
        const cancelBtn = root.querySelector('#app-dialog-btn-cancel');
        const okBtn = root.querySelector('#app-dialog-btn-ok');
        const backdrop = root.querySelector('[data-app-dialog-backdrop]');

        root.classList.add('app-dialog--confirm');
        panel?.classList.remove('app-dialog__panel--error');

        titleEl.textContent = title || '';
        msgEl.textContent = message;
        cancelBtn.classList.remove('is-hidden');
        cancelBtn.textContent = cancelText;
        okBtn.textContent = confirmText;

        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            root.classList.remove('app-dialog--confirm');
            hideRoot(root);
            cancelBtn.removeEventListener('click', onCancel);
            okBtn.removeEventListener('click', onOk);
            backdrop.removeEventListener('click', onBackdrop);
            resolve(value);
        };

        const onCancel = () => done(false);
        const onOk = () => done(true);
        const onBackdrop = () => done(false);

        cancelBtn.addEventListener('click', onCancel, { once: true });
        okBtn.addEventListener('click', onOk, { once: true });
        backdrop.addEventListener('click', onBackdrop, { once: true });

        escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                done(false);
            }
        };
        document.addEventListener('keydown', escapeHandler);

        root.classList.remove('is-hidden');
        root.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => okBtn.focus());
    });
}
