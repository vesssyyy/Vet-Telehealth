# Televet Health — Telehealth System

Veterinary telehealth: pet owner and veterinarian portals with appointments, messages, and scheduling.

## Roles

- **petOwner** — Book appointments, message vets, manage pets
- **vet** — View appointments, messages, manage schedule
- **admin** — Admin dashboard: disable/enable/delete users, list users, view user-count reports (via Cloud Functions)

## Structure

- **public/** — UI: HTML pages, styles, scripts, assets
  - **admin/** — Admin dashboard (list users, reports, disable/delete); only users with `role: 'admin'` can access
- **functions/** — Firebase Cloud Functions (admin API: `disableUser`, `enableUser`, `deleteUser`, `listUsers`, `getReport`)
- **config/** — Environment and tooling config (e.g. `.env.example`)
- **docs/** — Documentation and setup

## Run locally

Open `public/index.html` in a browser, or serve the `public` folder with a local server (e.g. Live Server) so module scripts load correctly.

## Deploy backend (Cloud Functions)

1. Install Firebase CLI: `npm install -g firebase-tools`
2. Log in: `firebase login`
3. From project root: `cd functions && npm install && cd ..`
4. Deploy: `firebase deploy --only functions`

Admin features (user list, disable/delete, reports) require the deployed functions. The admin UI is at `public/admin/dashboard.html`; only users whose Firestore `users/{uid}` document has `role: 'admin'` can open it (and call the functions).

**Create the first admin:** In Firebase Console → Firestore → `users` collection, open the document for the user who should be admin and set the field `role` to `admin` (or add the field if missing).

See **docs/README.md** for full setup and run instructions.
