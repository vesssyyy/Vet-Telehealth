/**
 * Video consultation — convo compose (attachment preview, emoji picker, textarea autosize).
 * No Firestore writes here; this module only manages UI state.
 */
export function initVideoCallConvoCompose(options = {}) {
    const { $ = (id) => document.getElementById(id) } = options;

    const convoAttachPreview = $('video-call-convo-attach-preview');
    const convoAttachName = $('video-call-convo-attach-name');
    const convoAttachInput = $('video-call-convo-attach-input');
    const convoAttachBtn = $('video-call-convo-attach-btn');
    const convoEmojiBtn = $('video-call-convo-emoji-btn');
    const convoInput = $('video-call-convo-input');

    let convoPendingFile = null;

    function clearConvoAttach() {
        convoPendingFile = null;
        convoAttachPreview?.classList.add('is-hidden');
        if (convoAttachName) convoAttachName.textContent = '';
        if (convoAttachInput) convoAttachInput.value = '';
    }

    function resizeConvoInput() {
        if (!convoInput) return;
        convoInput.style.height = 'auto';
        const lh = parseFloat(getComputedStyle(convoInput).lineHeight) || convoInput.scrollHeight;
        convoInput.style.height = Math.min(Math.max(convoInput.scrollHeight, lh), lh * 5) + 'px';
    }

    if (convoAttachBtn && convoAttachInput) {
        convoAttachBtn.addEventListener('click', () => convoAttachInput.click());
        convoAttachInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            convoPendingFile = file;
            convoAttachPreview?.classList.remove('is-hidden');
            if (convoAttachName) convoAttachName.textContent = file.name;
        });
    }
    $('video-call-convo-attach-remove')?.addEventListener('click', clearConvoAttach);

    const CONVO_EMOJI_LIST = ['😀','😊','😁','😂','🤣','😃','😄','😅','😉','😍','😘','🥰','🙂','🤗','😋','😜','😎','🤔','😐','😏','🙄','😌','😔','😴','😷','🤒','🤢','🤧','😵','😤','😡','👍','👎','👏','🙌','🙏','✌️','🤞','👌','❤️','🧡','💛','💚','💙','💜','🖤','💕','💖','💪','🐾','🐕','🐈','🦴','⭐','🔥','✨','💯'];
    let convoEmojiPickerEl = null;

    function closeConvoEmojiPicker() {
        if (convoEmojiPickerEl) convoEmojiPickerEl.classList.remove('is-open');
        if (convoEmojiBtn) convoEmojiBtn.setAttribute('aria-expanded', 'false');
    }

    function insertConvoEmojiAtCursor(emoji) {
        if (!convoInput) return;
        const start = convoInput.selectionStart ?? convoInput.value.length;
        const end = convoInput.selectionEnd ?? convoInput.value.length;
        const newVal = convoInput.value.slice(0, start) + emoji + convoInput.value.slice(end);
        if (newVal.length > (convoInput.getAttribute('maxlength') || 2000)) return;
        convoInput.value = newVal;
        const newPos = start + emoji.length;
        convoInput.setSelectionRange(newPos, newPos);
        convoInput.focus();
        resizeConvoInput();
    }

    function getOrCreateConvoEmojiPicker() {
        if (convoEmojiPickerEl) return convoEmojiPickerEl;
        convoEmojiPickerEl = document.createElement('div');
        convoEmojiPickerEl.id = 'video-call-emoji-picker';
        convoEmojiPickerEl.className = 'video-call-emoji-picker';
        convoEmojiPickerEl.setAttribute('role', 'listbox');
        convoEmojiPickerEl.setAttribute('aria-label', 'Choose emoji');
        CONVO_EMOJI_LIST.forEach((emoji) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'video-call-emoji-picker-item';
            btn.textContent = emoji;
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-label', `Insert ${emoji}`);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                insertConvoEmojiAtCursor(emoji);
                closeConvoEmojiPicker();
            });
            convoEmojiPickerEl.appendChild(btn);
        });
        document.body.appendChild(convoEmojiPickerEl);
        document.addEventListener('click', (e) => {
            if (convoEmojiPickerEl?.classList.contains('is-open') && !convoEmojiPickerEl.contains(e.target) && e.target !== convoEmojiBtn) {
                closeConvoEmojiPicker();
            }
        });
        return convoEmojiPickerEl;
    }

    function positionConvoEmojiPicker() {
        const wrap = convoInput?.closest('.video-call-convo-compose');
        if (!wrap || !convoEmojiPickerEl) return;
        const br = wrap.getBoundingClientRect();
        const margin = 8;
        const maxH = 200;
        let left = Math.max(margin, br.left);
        const maxW = Math.min(280, window.innerWidth - margin * 2);
        let width = Math.min(br.width, maxW, window.innerWidth - left - margin);
        if (left + width > window.innerWidth - margin) width = window.innerWidth - left - margin;
        left = Math.min(left, window.innerWidth - width - margin);
        const bottom = Math.min(window.innerHeight - br.top + margin, window.innerHeight - maxH - margin);
        Object.assign(convoEmojiPickerEl.style, { left: `${left}px`, width: `${Math.max(width, 200)}px`, bottom: `${bottom}px`, top: '', right: '' });
    }

    convoEmojiBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const picker = getOrCreateConvoEmojiPicker();
        const isOpen = picker.classList.toggle('is-open');
        convoEmojiBtn.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) positionConvoEmojiPicker();
    });

    if (convoInput) {
        convoInput.addEventListener('input', resizeConvoInput);
        convoInput.addEventListener('paste', () => setTimeout(resizeConvoInput, 0));
    }

    return {
        elements: { convoInput },
        getText: () => (convoInput?.value || ''),
        setText: (v) => { if (convoInput) convoInput.value = String(v ?? ''); resizeConvoInput(); },
        clearText: () => { if (convoInput) convoInput.value = ''; resizeConvoInput(); },
        resizeConvoInput,
        getPendingFile: () => convoPendingFile,
        clearConvoAttach,
    };
}

