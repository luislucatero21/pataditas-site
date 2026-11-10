#!/usr/bin/env node
// Static checks for pataditasapp.com. No dependencies: `node scripts/check-site.mjs`.
// Checks canonicals, hreflang reciprocity, sitemap coverage, JSON-LD validity,
// FAQPage text against visible text, internal links and assets, redirects and
// App Store campaign tokens. Exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = 'https://www.pataditasapp.com/';
const SKIP_DIRS = new Set(['.git', '.vercel', 'node_modules', 'scripts', 'docs']);
const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [path.relative(ROOT, p)];
  });
}
const files = walk(ROOT);
const htmlFiles = files.filter((f) => f.endsWith('.html') && f !== '404.html');
const urlOf = (f) => SITE + (f.endsWith('index.html') ? f.slice(0, -'index.html'.length) : f);
const fileOf = (url) => {
  const p = url.slice(SITE.length);
  return p === '' || p.endsWith('/') ? p + 'index.html' : p;
};
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
const norm = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// FAQ comparison ignores whitespace, because inline tags (<strong>, <li>) shift spaces around punctuation.
const squash = (s) => norm(s).replace(/\s+/g, '');

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const redirectSources = new Set(vercel.redirects.map((r) => r.source));

const pages = {};
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const canon = [...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
  const alts = Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
  pages[f] = { html, canon, alts };
}

// 1. canonical self-reference
for (const [f, p] of Object.entries(pages)) {
  if (p.canon.length !== 1) fail(f, `expected 1 canonical, found ${p.canon.length}`);
  else if (p.canon[0] !== urlOf(f)) fail(f, `canonical ${p.canon[0]} is not ${urlOf(f)}`);
}

// 2. hreflang: self-listed, x-default present, every target exists and links back with the same set
for (const [f, p] of Object.entries(pages)) {
  const entries = Object.entries(p.alts);
  if (!entries.length) { fail(f, 'no hreflang alternates'); continue; }
  if (!p.alts['x-default']) fail(f, 'no x-default alternate');
  if (!entries.some(([h, u]) => h !== 'x-default' && u === urlOf(f))) fail(f, 'hreflang set does not include the page itself');
  const lang = (p.html.match(/<html lang="([^"]+)"/) || [])[1];
  const selfH = entries.find(([h, u]) => h !== 'x-default' && u === urlOf(f));
  if (selfH && lang && !lang.toLowerCase().startsWith(selfH[0].toLowerCase().split('-')[0])) fail(f, `html lang ${lang} does not match hreflang ${selfH[0]}`);
  for (const [h, u] of entries) {
    const tf = fileOf(u);
    if (!pages[tf]) { fail(f, `hreflang ${h} points to missing page ${u}`); continue; }
    const back = pages[tf].alts;
    if (JSON.stringify(Object.entries(back).sort()) !== JSON.stringify(entries.sort())) fail(f, `hreflang set differs from the one on ${tf}`);
  }
}

// 3. sitemap coverage and alternates
const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const smUrls = {};
for (const m of sm.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
  const loc = m[1].match(/<loc>([^<]+)<\/loc>/)[1];
  if (!/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(m[1])) fail('sitemap.xml', `bad lastmod for ${loc}`);
  smUrls[loc] = Object.fromEntries([...m[1].matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((x) => [x[1], x[2]]));
}
for (const f of Object.keys(pages)) {
  const u = urlOf(f);
  if (!smUrls[u]) fail('sitemap.xml', `missing ${u}`);
  else if (JSON.stringify(Object.entries(smUrls[u]).sort()) !== JSON.stringify(Object.entries(pages[f].alts).sort())) fail('sitemap.xml', `alternates for ${u} differ from the page`);
}
for (const u of Object.keys(smUrls)) if (!pages[fileOf(u)]) fail('sitemap.xml', `lists ${u} but the file does not exist`);

// 4. JSON-LD parses; FAQPage text is visible on the page
for (const [f, p] of Object.entries(pages)) {
  const visible = squash(p.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<head>[\s\S]*?<\/head>/, ''));
  for (const m of p.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { fail(f, `JSON-LD does not parse: ${e.message}`); continue; }
    if (data['@context'] !== 'https://schema.org') fail(f, `JSON-LD ${data['@type']} without schema.org @context`);
    if (data['@type'] === 'FAQPage') {
      for (const q of data.mainEntity) {
        if (!visible.includes(squash(q.name))) fail(f, `FAQ question not visible: ${q.name}`);
        if (!visible.includes(squash(q.acceptedAnswer.text))) fail(f, `FAQ answer not visible: ${q.acceptedAnswer.text.slice(0, 60)}…`);
      }
    }
    if (['Article', 'WebPage'].includes(data['@type']) && data.dateModified && !/^\d{4}-\d{2}-\d{2}$/.test(data.dateModified)) fail(f, 'bad dateModified');
  }
}

// 5. internal links and assets resolve
const exists = (rel) => fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile();
for (const [f, p] of Object.entries(pages)) {
  const refs = [...p.html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1])
    .concat([...p.html.matchAll(/srcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])));
  for (const r of refs) {
    if (/^(https?:|mailto:|data:)/.test(r)) continue;
    let target = r.startsWith('/') ? r.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(f), r.split(/[?#]/)[0]));
    target = target.split(/[?#]/)[0];
    if (target === '.' || target === '' || target.endsWith('/')) target = (target === '.' ? '' : target) + 'index.html';
    if (!exists(target) && !redirectSources.has('/' + target)) fail(f, `broken link or asset: ${r}`);
  }
  for (const m of p.html.matchAll(/href="(https:\/\/apps\.apple\.com[^"]*)"/g)) {
    if (!/ct=web_[a-z-]+/.test(m[1])) fail(f, `App Store link without ct=web_<lang> campaign token: ${m[1]}`);
  }
}

// 6. every non-index page has an extensionless redirect
for (const f of Object.keys(pages)) {
  if (f.endsWith('index.html')) continue;
  const src = '/' + f.replace(/\.html$/, '');
  if (!redirectSources.has(src)) fail('vercel.json', `no redirect from ${src}`);
}

// 7. llms.txt links point to real pages
const llms = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
for (const m of llms.matchAll(/\((https:\/\/www\.pataditasapp\.com\/[^)#\s]*)/g)) {
  if (!pages[fileOf(m[1])]) fail('llms.txt', `links to missing page ${m[1]}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) in ${htmlFiles.length} pages`);
  process.exit(1);
}
console.log(`OK: ${htmlFiles.length} pages, ${Object.keys(smUrls).length} sitemap URLs, canonicals, hreflang, JSON-LD, FAQ text, links, redirects and llms.txt checked`);
