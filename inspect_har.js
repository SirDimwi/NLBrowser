const fs = require('fs');

const harPath = process.argv[2];
const pathFilter = process.argv[3]; // e.g. /api/planets/16377
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har.log.entries;

for (const e of entries) {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch { continue; }
  if (!url.hostname.includes('nexuslegacy')) continue;
  if (pathFilter && !url.pathname.includes(pathFilter)) continue;

  console.log('='.repeat(80));
  console.log(`${req.method} ${url.pathname}${url.search}`);
  console.log('\n-- Request headers --');
  for (const h of req.headers) {
    if (['cookie','referer','accept-encoding','accept-language','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','priority','user-agent'].includes(h.name.toLowerCase())) continue;
    console.log(`${h.name}: ${h.value}`);
  }
  console.log('\n-- Cookie present? --', req.headers.some(h => h.name.toLowerCase() === 'cookie'));
  const res = e.response;
  console.log('\n-- Response status --', res.status);
  const content = res.content;
  if (content && content.text) {
    let text = content.text;
    try {
      const json = JSON.parse(text);
      text = JSON.stringify(json, null, 2);
    } catch {}
    console.log('\n-- Response body (truncated 1500 chars) --');
    console.log(text.slice(0, 1500));
  }
  console.log('');
  break; // only first match per filter call; remove break to see all
}
