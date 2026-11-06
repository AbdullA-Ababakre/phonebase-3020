/** Read-only customer-path health check. Never sends physical actions or stores images. */
import '../shared/station-env.mjs';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readRentalLeaseRegistry, rentalLeaseActive, rentalLeaseAllowsDevice, createRentalLeaseToken } from '../shared/rental-leases.mjs';

const directory = '.runtime/station-health';
const deviceId = 'sf-black-arm-04';
const report = { at: new Date().toISOString(), deviceId, checks: [], healthy: false };
let previous;
try { previous = JSON.parse(await fs.readFile(`${directory}/latest.json`, 'utf8')); } catch {}
async function check(name, action) {
  const start = performance.now();
  try {
    const detail = await action();
    report.checks.push({ name, ok: true, ms: Math.round(performance.now() - start), ...detail });
  } catch {
    // Do not persist SDK error bodies, which may contain private screen text or URLs.
    report.checks.push({ name, ok: false, ms: Math.round(performance.now() - start), error: 'Read failed or safety/readiness check failed' });
  }
}
await check('local-control-plane', async () => {
  const response = await fetch('http://127.0.0.1:3013/health', { signal: AbortSignal.timeout(6000) });
  await response.arrayBuffer();
  if (!response.ok) throw Error();
  return { status: response.status };
});
let client;
try {
  const registry = await readRentalLeaseRegistry(process.env.PHONEBASE_RENTAL_LEASES_PATH || '.runtime/rental-leases.json');
  const lease = registry.leases.find(l => rentalLeaseActive(l) && rentalLeaseAllowsDevice(l, deviceId));
  if (!lease) throw Error();
  const token = createRentalLeaseToken(lease, process.env.PHONEBASE_LEASE_SIGNING_SECRET || process.env.PHONEBASE_REMOTE_TOKEN);
  await check('public-mcp-discovery', async () => {
    client = new Client({ name: 'phoneuse-readonly-health', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['public/downloads/phonebase-mcp.mjs'], stderr: 'pipe',
      env: { PATH: process.env.PATH, PHONEBASE_API_URL: 'https://robothand.phonefarm.ai', PHONEBASE_API_TOKEN: token, PHONEBASE_MCP_ALLOW_REMOTE: '1', PHONEBASE_MCP_ALLOW_HOME: '0' } }), { timeout: 10000 });
    const result = await client.listTools({}, { timeout: 10000 });
    if (!result.tools.some(t => t.name === 'phonebase_observe')) throw Error();
    return { toolCount: result.tools.length };
  });
  for (let sample = 0; sample < 2; sample++) {
    await check(`public-observe-${sample + 1}`, async () => {
      const result = await client.callTool({ name: 'phonebase_observe', arguments: { deviceId } }, undefined, { timeout: 10000 });
      const meta = result.structuredContent;
      const state = meta?.device?.state;
      if (result.isError || meta?.deviceId !== deviceId || !meta.device.connected || !state?.grbl?.connected ||
          state.grbl.state === 'Alarm' || state.screenSync?.status !== 'synchronized' || meta.frameAgeMs > 3000 ||
          !meta.frameSequence || !result.content?.some(c => c.type === 'image')) throw Error();
      const prior = report.checks.find(c => c.name === 'public-observe-1')?.frameSequence ?? previous?.checks?.find(c => c.name === 'public-observe-2')?.frameSequence;
      if (prior && meta.frameSequence <= prior) throw Error();
      return { frameSequence: meta.frameSequence, frameAgeMs: meta.frameAgeMs, width: meta.frameWidth, height: meta.frameHeight,
        hardwareState: state.grbl.state, busy: Boolean(state.grbl.activeOperation), synchronized: true };
    });
    if (!sample) await new Promise(resolve => setTimeout(resolve, 500));
  }
} catch { report.checks.push({ name: 'customer-assignment', ok: false, error: 'Customer path unavailable' }); }
finally { await client?.close(); }
report.healthy = report.checks.every(c => c.ok && c.ms < 2000);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
await fs.writeFile(`${directory}/latest.json.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
await fs.rename(`${directory}/latest.json.tmp`, `${directory}/latest.json`);
console.log(JSON.stringify(report));
process.exitCode = report.healthy ? 0 : 1;
