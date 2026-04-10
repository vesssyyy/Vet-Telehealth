/**
 * Video consultation — UI panels wiring (convo, notes, details, pet detail views).
 * Pure DOM/event code; no Firestore/WebRTC here.
 */
export function initVideoCallPanels(options = {}) {
    const {
        $ = (id) => document.getElementById(id),
        onMessageClick = null,
    } = options;

    const container = $('video-call-container');
    const convoPanel = $('video-call-convo-panel');
    const messageBtn = $('message-btn');

    const notesPanel = $('video-call-notes-panel');
    const notesBtn = $('notes-btn');

    const detailsPanel = $('video-call-details-panel');
    const participantBtn = $('participant-btn');

    function setConvoPanel(open) {
        convoPanel?.classList.toggle('is-hidden', !open);
        container?.classList.toggle('convo-open', open);
        if (open && notesPanel) {
            notesPanel.classList.add('is-hidden');
            container?.classList.remove('notes-open');
        }
    }
    const closeConvoPanel = () => setConvoPanel(false);
    const toggleConvoPanel = () => setConvoPanel(convoPanel?.classList.contains('is-hidden'));

    messageBtn?.addEventListener('click', () => {
        if (typeof onMessageClick === 'function') onMessageClick();
        else toggleConvoPanel();
    });
    $('convo-panel-close')?.addEventListener('click', closeConvoPanel);

    function setNotesPanel(open) {
        if (!notesPanel || !container) return;
        notesPanel.classList.toggle('is-hidden', !open);
        container.classList.toggle('notes-open', open);
        if (open) closeConvoPanel();
    }
    const closeNotesPanel = () => setNotesPanel(false);
    const toggleNotesPanel = () => setNotesPanel(notesPanel?.classList.contains('is-hidden'));
    notesBtn?.addEventListener('click', () => {
        if (notesPanel) toggleNotesPanel();
    });
    $('notes-panel-close')?.addEventListener('click', closeNotesPanel);

    function setDetailsPanel(open) {
        if (!detailsPanel) return;
        detailsPanel.classList.toggle('is-hidden', !open);
        detailsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    // Mobile details panel: pet sub-views
    const detailsPetDefaultView = $('details-pet-default-view');
    const detailsPetDetailView = $('details-pet-detail-view');
    const detailsPetDetailConcern = $('details-pet-detail-concern');
    const detailsPetDetailSharedImages = $('details-pet-detail-shared-images');

    function showDetailsPetDetailView(view) {
        detailsPetDefaultView?.classList.add('is-hidden');
        if (detailsPetDetailView) {
            detailsPetDetailView.classList.remove('is-hidden');
            detailsPetDetailView.setAttribute('aria-hidden', 'false');
        }
        detailsPetDetailConcern?.classList.toggle('is-hidden', view !== 'concern');
        detailsPetDetailSharedImages?.classList.toggle('is-hidden', view !== 'shared-images');
    }
    function showDetailsPetDefaultView() {
        detailsPetDefaultView?.classList.remove('is-hidden');
        if (detailsPetDetailView) {
            detailsPetDetailView.classList.add('is-hidden');
            detailsPetDetailView.setAttribute('aria-hidden', 'true');
        }
    }

    participantBtn?.addEventListener('click', () => {
        setDetailsPanel(true);
        showDetailsPetDefaultView();
    });
    $('details-panel-close')?.addEventListener('click', () => setDetailsPanel(false));
    $('details-concern-btn')?.addEventListener('click', () => showDetailsPetDetailView('concern'));
    $('details-shared-images-btn')?.addEventListener('click', () => showDetailsPetDetailView('shared-images'));
    $('details-pet-detail-back')?.addEventListener('click', showDetailsPetDefaultView);

    // Sidebar pet card: detail view toggles
    const petDefaultView = $('pet-default-view');
    const petDetailView = $('pet-detail-view');
    const petDetailConcern = $('pet-detail-concern');
    const petDetailSharedImages = $('pet-detail-shared-images');

    function showPetDetailView(view) {
        petDefaultView?.classList.add('is-hidden');
        if (petDetailView) {
            petDetailView.classList.remove('is-hidden');
            petDetailView.setAttribute('aria-hidden', 'false');
        }
        petDetailConcern?.classList.toggle('is-hidden', view !== 'concern');
        petDetailSharedImages?.classList.toggle('is-hidden', view !== 'shared-images');
    }

    function showPetDefaultView() {
        petDefaultView?.classList.remove('is-hidden');
        if (petDetailView) {
            petDetailView.classList.add('is-hidden');
            petDetailView.setAttribute('aria-hidden', 'true');
        }
    }

    $('concern-btn')?.addEventListener('click', () => showPetDetailView('concern'));
    $('shared-images-btn')?.addEventListener('click', () => showPetDetailView('shared-images'));
    $('pet-detail-back')?.addEventListener('click', showPetDefaultView);

    return {
        setConvoPanel,
        closeConvoPanel,
        toggleConvoPanel,
        setNotesPanel,
        closeNotesPanel,
        toggleNotesPanel,
        setDetailsPanel,
        showDetailsPetDefaultView,
        showDetailsPetDetailView,
        showPetDefaultView,
        showPetDetailView,
    };
}

