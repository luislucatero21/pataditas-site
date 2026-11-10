#!/usr/bin/env node
// Give every file in assets/ (except the stable ones below) a content hash in its
// name, e.g. styles.css -> styles.3f9a2c1b7e.css, and rewrite every reference in
// the site's .html, .css, .txt and .xml files. Safe to run again: unchanged files
// keep their name; an edited file gets a new hash and its references follow.
//
//   node scripts/fingerprint-assets.mjs           rename and rewrite
//   node scripts/fingerprint-assets.mjs --check   exit 1 if any name is stale
//
// vercel.json serves hashed names with a 1-year immutable cache, so run this after
// editing any asset (check-site.mjs fails until you do).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASSETS = path.join(ROOT, 'assets');
// Stable URLs: fetched by social cards, search engines or iOS by a fixed name.
export const STABLE = /^(og-[a-z-]+\.jpg|apple-touch-icon\.png|icon-192\.png|icon\.webp)$/;
export const HASHED = /^(.+)\.([0-9a-f]{10})(\.[a-z0-9]+)$/;
const SKIP_DIRS = new Set(['.git', '.vercel', 'node_modules', 'scripts', 'docs']);

export const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);

export function plan() {
  const moves = [];
  for (const name of fs.readdirSync(ASSETS).sort()) {
    if (STABLE.test(name)) continue;
    const m = name.match(HASHED);
    const base = m ? m[1] : name.slice(0, name.lastIndexOf('.'));
    const ext = m ? m[3] : name.slice(name.lastIndexOf('.'));
    const want = `${base}.${hashOf(path.join(ASSETS, name))}${ext}`;
    if (want !== name) moves.push([name, want]);
  }
  return moves;
}

function textFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return textFiles(p);
    return /\.(html|css|txt|xml)$/.test(e.name) ? [p] : [];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const moves = plan();
  if (process.argv.includes('--check')) {
    if (moves.length) {
      console.error(moves.map(([a, b]) => `stale asset name: ${a} (expected ${b})`).join('\n'));
      process.exit(1);
    }
    console.log('OK: asset names match their content');
    process.exit(0);
  }
  for (const [from, to] of moves) {
    fs.renameSync(path.join(ASSETS, from), path.join(ASSETS, to));
    const files = textFiles(ROOT); // after the rename, so a renamed stylesheet is rewritten under its new name
    const re = new RegExp(`assets/${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\\s,)?#]|$)`, 'g');
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      const t = s.replace(re, `assets/${to}`);
      if (t !== s) fs.writeFileSync(f, t);
    }
    console.log(`${from} -> ${to}`);
  }
  console.log(moves.length ? `${moves.length} asset(s) renamed` : 'nothing to rename');
}
