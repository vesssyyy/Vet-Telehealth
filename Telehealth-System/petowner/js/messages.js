/**
 * Televet Health — Pet Owner Messages UI
 * Handles modal and UI interactions.
 * Firestore integration to be added separately.
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const overlay = $('new-conversation-overlay');
    const modal = $('new-conversation-modal');
    const closeBtn = $('new-conversation-close');
    const cancelBtn = $('new-conversation-cancel');
    const form = $('new-conversation-form');
    const listLoading = $('messages-list-loading');
    const listEmpty = $('messages-list-empty');
    const listRoot = $('messages-conversation-list');
    const emptySinglePanel = $('messages-empty-single-panel');
    const messagesWrapper = $('messages-wrapper');
    const chatWelcome = $('messages-chat-welcome');
    const chatActive = $('messages-chat-active');
    const chatBack = $('messages-chat-back');
    const headerNewBtn = $('messages-new-btn');
    const composeInput = $('messages-compose-input');
    const sendBtn = $('messages-send-btn');
    const messagesWrapperEl = $('messages-wrapper');

    function isMobileView() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function openModal() {
        if (!overlay || !modal) return;
        $('new-conversation-error')?.classList.add('is-hidden');
        overlay.classList.add('is-open');
        modal.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        modal.focus();
    }

    function closeModal() {
        if (overlay) overlay.classList.remove('is-open');
        if (modal) modal.classList.remove('is-open');
        if (overlay) overlay.setAttribute('aria-hidden', 'true');
        if (modal) modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        $('new-conv-pet').value = '';
        $('new-conv-vet').value = '';
        const petTriggerText = $('new-conv-pet-trigger')?.querySelector('.new-conv-trigger-text');
        const vetTriggerText = $('new-conv-vet-trigger')?.querySelector('.new-conv-trigger-text');
        if (petTriggerText) petTriggerText.textContent = 'Select Pet';
        if (vetTriggerText) vetTriggerText.textContent = 'Select Vet';
    }

    function showPlaceholder() {
        if (chatWelcome) chatWelcome.classList.remove('is-hidden');
        if (chatActive) chatActive.classList.add('is-hidden');
        if (messagesWrapperEl && isMobileView()) {
            messagesWrapperEl.classList.remove('messages-wrapper--conversation-open');
        }
    }

    function showChat() {
        if (chatWelcome) chatWelcome.classList.add('is-hidden');
        if (chatActive) chatActive.classList.remove('is-hidden');
        if (messagesWrapperEl && isMobileView()) {
            messagesWrapperEl.classList.add('messages-wrapper--conversation-open');
        }
    }

    function setListState(loading, empty, hasItems) {
        if (listLoading) listLoading.classList.toggle('is-hidden', !loading);
        if (listEmpty) listEmpty.classList.toggle('is-hidden', !empty);
        if (listRoot) listRoot.style.display = hasItems ? '' : 'none';
        if (headerNewBtn) headerNewBtn.classList.toggle('is-hidden', empty);
        if (emptySinglePanel) emptySinglePanel.classList.toggle('is-hidden', !empty);
        if (messagesWrapper) messagesWrapper.classList.toggle('is-hidden', empty);
    }

    /** Placeholder: simulate "new message" — show conversation UI with one sent message (no modal). */
    function showPlaceholderConversation() {
        setListState(false, false, true);

        // One placeholder conversation in the list
        if (listRoot) {
            listRoot.innerHTML = '';
            const item = document.createElement('li');
            item.className = 'messages-conversation-item is-active';
            item.setAttribute('role', 'listitem');
            item.innerHTML = `
                <div class="messages-conv-avatar"><i class="fa fa-user-md" aria-hidden="true"></i></div>
                <div class="messages-conv-body">
                    <div class="messages-conv-title"><span class="conv-pet">My Pet</span><span class="conv-plus"> + </span><span class="conv-vet">Dr. Smith</span></div>
                    <div class="messages-conv-preview">Your message here</div>
                    <div class="messages-conv-meta">Just now</div>
                </div>
            `;
            listRoot.appendChild(item);
            listRoot.style.display = '';
        }

        // Chat header placeholder
        const vetNameEl = $('messages-chat-vet-name');
        const specialtyEl = $('messages-chat-specialty');
        const petBadgeEl = $('messages-chat-pet-badge');
        if (vetNameEl) vetNameEl.textContent = 'Dr. Smith';
        if (specialtyEl) specialtyEl.textContent = 'Veterinarian';
        if (petBadgeEl) petBadgeEl.textContent = 'My Pet';

        // One sent message in the chat body
        const body = $('messages-chat-body');
        if (body) {
            body.innerHTML = '';
            const row = document.createElement('div');
            row.className = 'message-row message-row--sent';
            const timeStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            row.innerHTML = `
                <div class="message-row-avatar"><i class="fa fa-user" aria-hidden="true"></i></div>
                <div class="message-bubble message-bubble--sent">
                    <div>Your message here</div>
                    <div class="message-bubble-time">${timeStr}</div>
                </div>
            `;
            body.appendChild(row);
            body.scrollTop = body.scrollHeight;
        }

        if (isMobileView()) {
            /* On mobile, stay on list view; user taps conversation to open chat */
        } else {
            showChat();
        }
    }

    /** When a conversation list item is clicked: set active, show chat (on mobile slides in convo view). */
    function onConversationItemClick(item) {
        if (!item || !listRoot) return;
        listRoot.querySelectorAll('.messages-conversation-item').forEach((i) => i.classList.remove('is-active'));
        item.classList.add('is-active');
        showChat();
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function init() {
        setListState(false, true, false);
        showPlaceholder();

        [closeBtn, cancelBtn, overlay].forEach((el) => {
            el?.addEventListener('click', (e) => {
                if (el === overlay && e.target !== overlay) return;
                closeModal();
            });
        });

        // Placeholder: New Message shows "I have a message" UI (no modal)
        headerNewBtn?.addEventListener('click', showPlaceholderConversation);
        $('messages-new-btn-center')?.addEventListener('click', showPlaceholderConversation);
        $('messages-new-btn-welcome')?.addEventListener('click', showPlaceholderConversation);

        chatBack?.addEventListener('click', () => {
            showPlaceholder();
            listRoot?.querySelectorAll('.messages-conversation-item').forEach((i) => i.classList.remove('is-active'));
        });

        /* Click on conversation item: open that conversation (on mobile, slides to chat view) */
        listRoot?.addEventListener('click', (e) => {
            const item = e.target.closest('.messages-conversation-item');
            if (item) {
                e.preventDefault();
                onConversationItemClick(item);
            }
        });

        form?.addEventListener('submit', (e) => {
            e.preventDefault();
            const pet = $('new-conv-pet')?.value;
            const vet = $('new-conv-vet')?.value;
            if (!pet || !vet) {
                const errEl = $('new-conversation-error');
                if (errEl) {
                    errEl.textContent = 'Please select both a pet and a veterinarian.';
                    errEl.classList.remove('is-hidden');
                }
                return;
            }
            closeModal();
            showPlaceholder();
        });

        /* Auto-grow compose textarea: 1 line min, 5 lines max then scroll */
        const MAX_LINES = 5;
        function resizeComposeInput() {
            if (!composeInput) return;
            composeInput.style.height = 'auto';
            const style = getComputedStyle(composeInput);
            const lineHeight = parseFloat(style.lineHeight) || composeInput.scrollHeight;
            const maxHeight = lineHeight * MAX_LINES;
            const h = Math.min(Math.max(composeInput.scrollHeight, lineHeight), maxHeight);
            composeInput.style.height = h + 'px';
        }
        composeInput?.addEventListener('input', resizeComposeInput);
        composeInput?.addEventListener('paste', () => setTimeout(resizeComposeInput, 0));

        sendBtn?.addEventListener('click', () => {
            const text = (composeInput?.value || '').trim();
            if (!text) return;
            const body = $('messages-chat-body');
            if (body) {
                const row = document.createElement('div');
                row.className = 'message-row message-row--sent';
                const now = new Date();
                const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                row.innerHTML = `
                    <div class="message-row-avatar"><i class="fa fa-user" aria-hidden="true"></i></div>
                    <div class="message-bubble message-bubble--sent">
                        <div>${escapeHtml(text)}</div>
                        <div class="message-bubble-time">${timeStr}</div>
                    </div>
                `;
                body.appendChild(row);
                body.scrollTop = body.scrollHeight;
            }
            composeInput.value = '';
            resizeComposeInput();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        const petDropdown = $('new-conv-pet-dropdown');
        const vetDropdown = $('new-conv-vet-dropdown');
        const petTrigger = $('new-conv-pet-trigger');
        const vetTrigger = $('new-conv-vet-trigger');
        const petMenu = $('new-conv-pet-menu');
        const vetMenu = $('new-conv-vet-menu');

        function closeAllDropdowns() {
            petDropdown?.classList.remove('is-open');
            vetDropdown?.classList.remove('is-open');
        }

        petTrigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = petDropdown?.classList.toggle('is-open');
            vetDropdown?.classList.remove('is-open');
        });
        vetTrigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = vetDropdown?.classList.toggle('is-open');
            petDropdown?.classList.remove('is-open');
        });

        document.addEventListener('click', closeAllDropdowns);
        petMenu?.addEventListener('click', (e) => e.stopPropagation());
        vetMenu?.addEventListener('click', (e) => e.stopPropagation());

        const demoPets = [
            { id: 'p1', name: 'Max', species: 'dog' },
            { id: 'p2', name: 'Bella', species: 'cat' },
            { id: 'p3', name: 'Charlie', species: 'dog' },
        ];
        const demoVets = [
            { id: 'v1', name: 'Dr. Jane Smith', clinic: 'Happy Paws Clinic' },
            { id: 'v2', name: 'Dr. John Davis', clinic: 'Pet Care Center' },
        ];
        if (petMenu) {
            petMenu.innerHTML = demoPets
                .map((p) => `<button type="button" class="new-conv-item" role="menuitem" data-pet-id="${p.id}" data-pet-name="${escapeHtml(p.name)}"><i class="fa fa-paw dropdown-item-icon"></i><span>${escapeHtml(p.name)}</span></button>`)
                .join('');
            petMenu.querySelectorAll('.new-conv-item').forEach((btn) => {
                btn.addEventListener('click', () => {
                    $('new-conv-pet').value = btn.dataset.petId;
                    petTrigger.querySelector('.new-conv-trigger-text').textContent = btn.dataset.petName;
                    petDropdown?.classList.remove('is-open');
                });
            });
        }
        if (vetMenu) {
            vetMenu.innerHTML = demoVets
                .map((v) => `<button type="button" class="new-conv-item" role="menuitem" data-vet-id="${v.id}" data-vet-name="${escapeHtml(v.name)}" data-vet-clinic="${escapeHtml(v.clinic || '')}"><i class="fa fa-user-md dropdown-item-icon"></i><span>${escapeHtml(v.name)}${v.clinic ? ' – ' + escapeHtml(v.clinic) : ''}</span></button>`)
                .join('');
            vetMenu.querySelectorAll('.new-conv-item').forEach((btn) => {
                btn.addEventListener('click', () => {
                    $('new-conv-vet').value = btn.dataset.vetId;
                    const text = btn.dataset.vetName + (btn.dataset.vetClinic ? ' – ' + btn.dataset.vetClinic : '');
                    vetTrigger.querySelector('.new-conv-trigger-text').textContent = text;
                    vetDropdown?.classList.remove('is-open');
                });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
