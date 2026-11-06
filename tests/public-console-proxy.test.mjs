import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPublicConsoleServer, publicPathAllowed } from '../scripts/public_console_proxy.mjs';

test('public frontend allows only public pages and static resources', () => {
  for (const path of ['/downloads/phonebase-mcp.mjs', '/downloads/phonebase-mcp.mjs.sha256']) assert.equal(publicPathAllowed(path), true, path);
  for (const path of ['/console', '/console?_rsc=123', '/docs/mcp', '/docs/quickstart.md', '/agent-guide.txt', '/install.sh', '/og.png', '/_next/static/chunks/index-ab.js', '/_next/static/css/index.css']) assert.equal(publicPathAllowed(path), true, path);
  for (const path of ['/api/status', '/api/v1/devices', '/calibrate', '/.env', '//evil.test/console', '/%63onsole', '/console/../api/status', '/_next/static/../../api/status', '/_next/static/chunks/app.js.map']) assert.equal(publicPathAllowed(path), false, path);
});

test('proxy strips credentials/host spoofing and never forwards writes or local APIs', async t => {
  const requests = [];
  const origin = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('set-cookie', 'private-session=test');
    res.end('PhoneUse Console');
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const proxy = createPublicConsoleServer({ upstreamPort: origin.address().port });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); origin.closeAllConnections(); origin.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const response = await fetch(`${base}/console`, { headers: {
    Authorization: 'Bearer private', Cookie: 'secret=test',
    'x-forwarded-host': 'localhost', 'x-middleware-subrequest': 'middleware',
  } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'PhoneUse Console');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(requests[0].headers.host, 'console.phonefarm.ai');
  assert.equal(requests[0].headers['x-forwarded-host'], 'console.phonefarm.ai');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers['x-middleware-subrequest'], undefined);
  assert.equal((await fetch(`${base}/console`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/status`)).status, 404);
  assert.equal(requests.length, 1);
});
