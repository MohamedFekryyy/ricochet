// Bundles the ES-module app into one self-contained HTML file: styles
// inlined, modules concatenated in dependency order. Written to both
// index.html (the deployed Pages entry - a single file so a stale cache
// can never mix old JS/CSS with a new page) and dist/ricochet.html
// (served by the link bridge). No dependencies; the module code is
// written so plain concatenation (imports/exports stripped) is exact.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const read = (p) => readFileSync(p, 'utf8');

const seen = new Set();
function bundle(file) {
  if (seen.has(file)) return '';
  seen.add(file);
  const code = read(join(SRC, file));
  const importRe = /^import\s+[^'"]*['"]\.\/([\w.-]+)['"];\s*$/gm;
  const deps = [...code.matchAll(importRe)].map((m) => m[1]);
  let out = deps.map(bundle).join('');
  const stripped = code
    .replace(importRe, '')
    .replace(/^export\s+(?=(async\s+)?(function|const|let|class))/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  out += `\n// ---- ${file} ----\n${stripped}\n`;
  return out;
}

const js = bundle('main.js');
const css = read(join(ROOT, 'styles.css'));
let html = read(join(ROOT, 'dev.html'));
html = html.replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="./src/main.js"></script>', () => `<script>\n${js}\n</script>`);

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'ricochet.html'), html);
writeFileSync(join(ROOT, 'index.html'), html);
console.log(`index.html + dist/ricochet.html written (${html.length} bytes, ${seen.size} modules)`);
