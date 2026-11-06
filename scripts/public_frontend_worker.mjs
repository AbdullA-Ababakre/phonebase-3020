// One vinext build per process: its React/RSC manifests use process globals.
import { resolve } from 'node:path';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

const origin = await startProdServer({ host: '127.0.0.1', port: 0,
  outDir: resolve(process.argv[2]), silent: true });
process.send?.({ port: origin.port });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  origin.server.closeAllConnections();
  origin.server.close(() => process.exit(0));
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);
