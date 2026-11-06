import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readPhonebaseAccessCode } from '../shared/connection-code.mjs';
import gatewayAliases from '../config/remote-gateway-aliases.json' with { type: 'json' };

export function connectionFromInvitation(input) {
  let value = String(input ?? '').trim();
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.has('access')) value = fragment.get('access');
    else if (fragment.has('controlPlane') && fragment.has('token')) {
      return validateConnection(fragment.get('controlPlane'), fragment.get('token'));
    }
  } catch { /* Standalone access codes are not URLs. */ }
  const decoded = readPhonebaseAccessCode(value);
  return validateConnection(decoded.gatewayUrl, decoded.token);
}

function validateConnection(base, token) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !token || token.length > 256) throw Error('Use a valid HTTPS Phonebase invitation.');
  return { baseUrl: gatewayAliases[url.origin] ?? url.origin, accessToken: token };
}

export function makeHostConfig(connection, clientPath, nodePath = process.execPath) {
  return { mcpServers: { phonebase: { command: nodePath, args: [resolve(clientPath)], env: {
    PHONEBASE_API_URL: connection.baseUrl, PHONEBASE_API_TOKEN: connection.accessToken,
    PHONEBASE_MCP_ALLOW_REMOTE: '1',
  } } } };
}

async function readPrivateInvitation() {
  if (process.env.PHONEBASE_ACCESS_CODE) return process.env.PHONEBASE_ACCESS_CODE;
  if (!process.stdin.isTTY) throw Error('Run --configure in a terminal, or provide PHONEBASE_ACCESS_CODE through your secret manager.');
  process.stderr.write('Paste your private Phonebase invitation or access code (hidden), then press Enter: ');
  return new Promise((resolveInput, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); };
    const onData = chunk => {
      for (const ch of chunk.toString()) {
        if (ch === '\u0003') { cleanup(); reject(Error('Setup cancelled.')); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); resolveInput(value); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && value.length < 4096) value += ch;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}

export async function configureClient(clientPath, output = 'phonebase-mcp.config.json') {
  const connection = connectionFromInvitation(await readPrivateInvitation());
  const response = await fetch(connection.baseUrl + '/api/v1/devices', {
    headers: { Authorization: 'Bearer ' + connection.accessToken }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`Connection rejected (HTTP ${response.status}). Check your invitation with the operator.`);
  const payload = await response.json();
  if (payload.ok !== true || !Array.isArray(payload.devices)) throw Error('The gateway returned an invalid device list.');
  const destination = resolve(output);
  try {
    await writeFile(destination, JSON.stringify(makeHostConfig(connection, clientPath), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('Configuration already exists. Choose a new output path: --configure ./another-config.json');
    throw error;
  }
  process.stdout.write(`Connection verified: ${payload.devices.length} assigned device(s).\nPrivate configuration saved to ${destination}\nImport its phonebase entry into your MCP host and reconnect the host. Keep this file private.\n`);
  if (!payload.devices.length) process.stdout.write('No devices are assigned yet. Ask the operator to assign a device before operating.\n');
}
