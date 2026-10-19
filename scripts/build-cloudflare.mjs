import './build-netlify.mjs';
import fs from 'node:fs/promises';

await fs.writeFile('dist/_redirects','/ /video/ 302\n/memory /video/ 301\n/memory/ /video/ 301\n');
await fs.writeFile('dist/_headers',`/*
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=(self), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'
`);
console.log('Cloudflare assets and API routing ready.');
