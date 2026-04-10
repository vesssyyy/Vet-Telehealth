// Televet Health — Pet Owner Profile
import { initProfile } from './profile-shared.js';

const formatRole = role => (role === 'vet' ? 'Veterinarian' : 'Pet Owner');

initProfile({
    defaultName: 'Pet Owner',

    buildProfile: (data, user) => ({
        displayName: data.displayName
            || `${data.firstName || ''} ${data.lastName || ''}`.trim()
            || user.displayName
            || user.email?.split('@')[0]
            || 'Pet Owner',
        email:     data.email     || user.email      || '—',
        role:      data.role      || 'petOwner',
        verified:  user.emailVerified || data.emailVerified,
        photoUrl:  data.photoURL  || user.photoURL   || '',
        createdAt: data.createdAt || null,
        bio:       data.bio       || '',
        address:   data.address   || '',
        phone:     data.phone     || '',
    }),

    getRole: profile => formatRole(profile.role),
});
