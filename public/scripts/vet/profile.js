/** Televet Health — Vet Profile */
import { withDr } from '../core/utils.js';
import { initProfile } from '../core/profile-shared.js';

initProfile({
    defaultName:    'Veterinarian',
    formatName:     withDr,
    defaultInitials: 'V',

    buildProfile: (data, user) => ({
        displayName: data.displayName
            || `${data.firstName || ''} ${data.lastName || ''}`.trim()
            || user.displayName
            || user.email?.split('@')[0]
            || 'Veterinarian',
        email:     data.email     || user.email    || '—',
        photoUrl:  data.photoURL  || user.photoURL || '',
        createdAt: data.createdAt || null,
        bio:       data.bio       || '',
        address:   data.address   || '',
        phone:     data.phone     || '',
    }),

    getRole: () => 'Veterinarian',
});
