const fs = require('fs');

const harPath = process.argv[2];
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har.log.entries;

console.log(`Total entries: ${entries.length}`);

// Group by URL path (strip query, strip host) -> collect methods, sample
const groups = new Map();

for (const e of entries) {
  const req = e.request;
  const res = e.response;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    continue;
  }
  if (!url.hostname.includes('nexuslegacy')) continue;

  const key = `${req.method} ${url.pathname}`;
  if (!groups.has(key)) {
    groups.set(key, { count: 0, sample: e, host: url.hostname });
  }
  groups.get(key).count++;
}

console.log(`\nUnique nexuslegacy endpoints (host + method + path): ${groups.size}\n`);
for (const [key, info] of groups) {
  console.log(`${String(info.count).padStart(4)}x  ${info.host}  ${key}`);
}
