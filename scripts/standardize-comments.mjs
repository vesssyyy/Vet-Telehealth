// One-off: normalize // comments (run: node scripts/standardize-comments.mjs)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const dirs = [path.join(root, 'public', 'scripts'), path.join(root, 'functions')];
const files = [];
dirs.forEach((d) => walk(d, files));

let total = 0;
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  const orig = s;

  s = s.replace(/\{ \/\* ignore \*\/ \}/g, '{}');
  s = s.replace(/\{ \/\* noop \*\/ \}/g, '{}');
  s = s.replace(/\{ \/\* skip \*\/ \}/g, '{}');
  s = s.replace(/\{ \/\* ok \*\/ \}/g, '{}');
  s = s.replace(/\{ \/\* may not exist \*\/ \}/g, '{}');

  s = s.replace(/^(\s*)\/\*(?!\*)\s*(.+?)\s*\*\/\s*$/gm, (full, indent, inner) => {
    const t = inner.trim();
    if (t.includes('\n')) return full;
    if (t.includes('*/')) return full;
    return `${indent}// ${t}`;
  });

  s = s.replace(/^(\s*)\/\*\*\s+(.+?)\s*\*\/\s*$/gm, (full, indent, inner) => {
    const t = inner.trim();
    if (t.startsWith('@')) return full;
    if (t.includes('\n')) return full;
    return `${indent}// ${t}`;
  });

  s = s.replace(/^(\s*)\/\/ \* /gm, '$1// ');

  if (s !== orig) {
    fs.writeFileSync(f, s);
    total++;
    console.log(f);
  }
}
console.log('Updated', total, 'files');
