import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../../../../');
const dashboardPath = path.join(root, 'public/styles/petowner/dashboard.css');
const outPath = path.join(root, 'public/styles/petowner/pet-panels.css');

const d = fs.readFileSync(dashboardPath, 'utf8');
const i = d.indexOf('/* Toast */');
const j = d.indexOf('@media (max-width: 768px)');
if (i === -1 || j === -1) throw new Error('Slice markers not found');
const chunk = d.slice(i, j).trim();

const btn = `/* Buttons */
.btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 11px 19px; font-size: 15px; font-weight: 500;
    border-radius: 8px; text-decoration: none; cursor: pointer;
    transition: all 0.2s ease; border: none;
}
.btn i { font-size: 15px; }
.btn-primary { background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-dark) 100%); color: white; }
.btn-primary:hover { opacity: 0.95; transform: translateY(-1px); }
.btn-secondary { background: var(--bg-light); color: var(--primary-color); border: 1px solid var(--border-color); }
.btn-secondary:hover { background: var(--border-color); }
.btn-outline { background: transparent; color: var(--primary-color); border: 1px solid var(--primary-color); }
.btn-outline:hover { background: rgba(44, 95, 125, 0.08); }
.btn-link { background: none; color: var(--primary-color); padding: 6px 0; }
.btn-link:hover { text-decoration: underline; }

`;

const extra = `
.add-pet-breed-other-wrap { margin-top: 10px; }
.add-pet-breed-other-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-dark);
    margin-bottom: 6px;
}
@media (max-width: 480px) {
    .add-pet-panel { max-width: 100%; }
    .add-pet-row { grid-template-columns: 1fr; }
}
`;

const pets = `
/* Profile — pet list */
.profile-section-pets { width: 100%; }
.profile-section-pets .profile-pets-toolbar { display: flex; justify-content: flex-end; margin-bottom: 14px; }
.profile-pets-list { display: flex; flex-direction: column; gap: 12px; }
.profile-pet-row {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 14px 16px; border: 1px solid #e8ecf1; border-radius: 10px;
    background: #fafbfc;
}
.profile-pet-row-avatar {
    width: 48px; height: 48px; border-radius: 50%; overflow: hidden;
    flex-shrink: 0; background: linear-gradient(135deg, var(--primary-color) 0%, var(--accent-color) 100%);
    display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.9); font-size: 20px;
}
.profile-pet-row-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.profile-pet-row-main { flex: 1; min-width: 140px; display: flex; align-items: center; }
.profile-pet-row-name { font-size: 16px; font-weight: 600; color: var(--text-dark); margin: 0; }
.profile-pet-row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.profile-pets-empty { text-align: center; padding: 24px 16px; color: var(--text-light); font-size: 14px; line-height: 1.5; }
.profile-pets-empty.is-hidden { display: none !important; }
`;

fs.writeFileSync(outPath, btn + chunk + extra + pets);
console.log('Wrote', outPath);
