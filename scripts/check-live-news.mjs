import { readFileSync } from 'node:fs';
const path = process.argv[2] || '/tmp/live_news2.json';
const p = JSON.parse(readFileSync(path, 'utf8'));
console.log(path, '-> articles:', p.articles.length, 'total:', p.total,
  'fetchedAt:', p.fetchedAt ? new Date(p.fetchedAt).toISOString() : null);
const bad = p.articles.filter((x) => typeof x.lat !== 'number' || typeof x.lon !== 'number' || !x.url || !x.title);
console.log('malformed:', bad.length, 'distinct urls:', new Set(p.articles.map((x) => x.url)).size);
const newest = p.articles.slice().sort((a, b) => (b.seenMs || 0) - (a.seenMs || 0))[0];
console.log('newest:', newest ? `${newest.title} · ${newest.domain} · ${newest.place} · ${newest.lat},${newest.lon} · ${new Date(newest.seenMs).toISOString()}` : null);
