import { createServer, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Public HTML/assets only. Authentication and video stay on the separate 3015
// gateway. Never proxy local operator APIs, arbitrary hosts, or write methods.
export function publicPathAllowed(raw) {
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[%\\]/.test(raw.split('?')[0])) return false;
  const pathname = new URL(raw, 'http://localhost').pathname;
  return ['/', '/console', '/favicon.svg', '/og.png', '/openapi-remote.json', '/llms.txt', '/llms-full.txt', '/agent-guide.txt', '/install.sh', '/sitemap.xml', '/robots.txt'].includes(pathname)
    || /^\/docs(?:\/[a-z0-9-]+)*\/?$/.test(pathname)
    || /^\/docs\/[a-z0-9-]+\.md$/.test(pathname)
    || /^\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|svg|webp|ico)$/.test(pathname)
    || /^\/_next\/static\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?|png|svg)$/.test(pathname)
    || /^\/downloads\/[a-zA-Z0-9_.-]+\.(?:mjs|sha256|pdf)$/.test(pathname)
    || /^\/examples\/remote-inspect\.(?:mjs|py)$/.test(pathname);
}

export function docsPath(pathname, clientDirectory) {
  if (/^\/docs(?:\/|$)/.test(pathname) ||
    ['/openapi-remote.json', '/llms.txt', '/llms-full.txt', '/agent-guide.txt', '/sitemap.xml', '/robots.txt'].includes(pathname) ||
    /^\/examples\/remote-inspect\.(?:mjs|py)$/.test(pathname)) return true;
  if (clientDirectory && pathname.startsWith('/_next/static/')) {
    const root = resolve(clientDirectory);
    const path = resolve(root, `.${pathname}`);
    return path.startsWith(root + '/') && existsSync(path);
  }
  return false;
}

export function createPublicConsoleServer({ upstreamPort = 3020, docsUpstreamPort, docsClientDirectory, publicHost = 'console.phonefarm.ai' } = {}) {
  return createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method) || !publicPathAllowed(req.url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return;
    }
    // Construct headers explicitly so cookies, Authorization, spoofed forwarded
    // hosts, Server Actions and internal middleware headers never reach 3020.
    const headers = {
      host: publicHost,
      'x-forwarded-host': publicHost,
      'x-forwarded-proto': 'https',
    };
    for (const name of ['accept', 'accept-encoding', 'rsc']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const port = docsUpstreamPort && docsPath(pathname, docsClientDirectory) ? docsUpstreamPort : upstreamPort;
    const upstream = httpRequest({
      hostname: '127.0.0.1', port,
      path: req.url, method: req.method, headers, timeout: 15000,
    }, response => {
      const safeHeaders = { ...response.headers };
      for (const name of ['set-cookie', 'connection', 'keep-alive', 'transfer-encoding']) delete safeHeaders[name];
      safeHeaders['x-content-type-options'] = 'nosniff';
      safeHeaders['referrer-policy'] = 'no-referrer';
      res.writeHead(response.statusCode ?? 502, safeHeaders);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Origin timeout')));
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Console temporarily unavailable');
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  });
}

// A separate production build lets us update the customer UI without stopping
// start-local.sh, whose exit trap also stops the hardware fleet.
async function startFrontendWorker(outDir) {
  const child = fork(fileURLToPath(new URL('./public_frontend_worker.mjs', import.meta.url)), [resolve(outDir)],
    { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Frontend startup timed out')); }, 20_000);
    const fail = error => { clearTimeout(timer); child.kill('SIGTERM'); reject(error); };
    const exited = () => fail(new Error('Frontend exited before becoming ready'));
    child.once('error', fail);
    child.once('exit', exited);
    child.once('message', value => {
      clearTimeout(timer);
      child.removeListener('error', fail);
      child.removeListener('exit', exited);
      if (!Number.isInteger(value?.port) || value.port < 1) return fail(new Error('Invalid frontend port'));
      accept(value.port);
    });
  });
  return { port, child };
}

export async function startPublicConsoleFrontend({
  outDir = fileURLToPath(new URL('../dist-public/', import.meta.url)),
  docsOutDir = fileURLToPath(new URL('../dist-docs/', import.meta.url)),
  port = 3040,
} = {}) {
  let origin = null;
  let docsOrigin = null;
  let upstreamPort = 3020;
  try {
    if (existsSync(resolve(outDir, 'server/index.js'))) {
      origin = await startFrontendWorker(outDir);
      upstreamPort = origin.port;
    }
    if (docsOutDir && existsSync(resolve(docsOutDir, 'server/index.js'))) docsOrigin = await startFrontendWorker(docsOutDir);
  } catch (error) {
    origin?.child.kill('SIGTERM');
    docsOrigin?.child.kill('SIGTERM');
    throw error;
  }
  const proxy = createPublicConsoleServer({ upstreamPort, docsUpstreamPort: docsOrigin?.port,
    docsClientDirectory: docsOutDir ? resolve(docsOutDir, 'client') : undefined });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    proxy.closeAllConnections(); proxy.close();
    origin?.child.kill('SIGTERM'); docsOrigin?.child.kill('SIGTERM');
  };
  for (const worker of [origin, docsOrigin].filter(Boolean)) worker.child.once('exit', () => {
    if (closing) return;
    console.error('Public frontend worker stopped; restarting the frontend service is required');
    close(); process.exitCode = 1;
  });
  try {
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    close();
    throw error;
  }
  return { proxy, close, workers: [origin?.child, docsOrigin?.child].filter(Boolean) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const frontend = await startPublicConsoleFrontend();
  console.log('Public Console read-only frontend listening on http://127.0.0.1:3040');
  process.once('SIGTERM', () => {
    frontend.close();
    process.exit(0);
  });
}
