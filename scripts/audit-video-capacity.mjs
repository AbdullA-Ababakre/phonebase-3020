/** Read-only concurrent video acceptance. No focus changes, leases, motion, or image storage. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  seconds: { type: 'string', default: '60' }, target: { type: 'string', default: '10' },
  output: { type: 'string' }, fleet: { type: 'string', default: 'config/device-fleet.json' },
  api: { type: 'string', default: 'http://127.0.0.1:3013' },
} });
const seconds = Number(values.seconds), target = Number(values.target), api = new URL(values.api);
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600 ||
    !Number.isInteger(target) || target < 1 || target > 32 ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || api.username || api.password) {
  throw Error('Use a loopback API, --seconds 5..3600, and --target 1..32');
}
function command(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 10000 }).trim(); }
  catch { return null; }
}
const python = `import subprocess,plistlib,json
roots=plistlib.loads(subprocess.check_output(['ioreg','-r','-c','AppleT8132USBXHCI','-l','-a']))
interfaces=plistlib.loads(subprocess.check_output(['ioreg','-r','-c','IOUSBHostInterface','-l','-a']))
alts={n.get('locationID'):n.get('bAlternateSetting') for n in interfaces if n.get('bInterfaceClass')==14 and n.get('bInterfaceSubClass')==2}
def devices(n,path):
 out=[]
 if 'idVendor' in n and 'USB Address' in n:
  loc=n.get('locationID',0);v=n['idVendor'];p=n.get('idProduct',0)
  out.append(dict(name=n.get('USB Product Name',n.get('IORegistryEntryName')),location=hex(loc),vendor=v,product=p,speed=n.get('USBSpeed'),path=path,activeAlternate=alts.get(loc),cameraIdentity=('0x%x%04x%04x'%(loc,v,p)) if v==3034 and p==22616 else None))
 for c in n.get('IORegistryEntryChildren',[]):out+=devices(c,path+[c.get('IORegistryEntryName','')])
 return out
print(json.dumps([dict(root=hex(n.get('locationID',0)),devices=devices(n,[])) for n in roots]))`;
let topology = null;
try { topology = JSON.parse(command('python3', ['-c', python])); } catch {}
let fleet = null;
try { fleet = JSON.parse(await readFile(values.fleet, 'utf8')); } catch {}
async function inventory() {
  const response = await fetch(new URL('/api/v1/devices', api), { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw Error(`Device inventory failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.devices)) throw Error('Invalid device inventory');
  return data.devices;
}
const initial = await inventory(), connected = initial.filter(d => d.connected);
const startedAt = Date.now(), duration = seconds * 1000, stats = new Map(), sockets = [];
for (const device of connected) {
  const s = { frames: 0, freshFrames: 0, ages: [], lastAt: startedAt, maxGapMs: 0,
    lastSequence: null, binaryBytes: 0, errors: 0, closes: 0 };
  stats.set(device.id, s);
  const url = new URL('/api/live/socket', api); url.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('deviceId', device.id); url.searchParams.set('raw', '1');
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; sockets.push(ws);
  ws.addEventListener('message', event => {
    if (typeof event.data !== 'string') { s.binaryBytes += event.data.byteLength; return; }
    let frame; try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type !== 'frame' || !Number.isFinite(frame.capturedAt) ||
        !Number.isFinite(frame.sequence) || frame.sequence === s.lastSequence) return;
    const now = Date.now(), age = now - frame.capturedAt;
    s.lastSequence = frame.sequence; s.frames++;
    if (age < -1000 || age > 1000) return;
    s.freshFrames++; s.ages.push(age); s.maxGapMs = Math.max(s.maxGapMs, now - s.lastAt); s.lastAt = now;
  });
  ws.addEventListener('error', () => s.errors++);
  ws.addEventListener('close', () => s.closes++);
}
console.error(`Observing ${connected.length} connected devices simultaneously for ${seconds}s; target ${target}. No actions sent.`);
await new Promise(resolve => setTimeout(resolve, duration));
const endedAt = Date.now();
const final = await inventory().catch(() => []);
const rows = connected.map(device => {
  const s = stats.get(device.id), current = final.find(d => d.id === device.id);
  const ages = s.ages.sort((a, b) => a - b), fps = s.freshFrames * 1000 / (endedAt - startedAt);
  const maxGapMs = Math.max(s.maxGapMs, endedAt - s.lastAt);
  const p95AgeMs = ages.length ? ages[Math.max(0, Math.ceil(ages.length * .95) - 1)] : null;
  const scheduled = current?.state?.videoCapture?.scheduled !== false;
  return { id: device.id, connected: Boolean(current?.connected), scheduled,
    freshFrames: s.freshFrames, frames: s.frames, fps, p95AgeMs, maxGapMs,
    receivedMbps: s.binaryBytes * 8 / (endedAt - startedAt) / 1000,
    socketErrors: s.errors, unexpectedCloses: s.closes,
    tapCapability: current?.capabilities?.actions?.tap?.available === true,
    videoPass: Boolean(current?.connected) && scheduled && fps >= 10 && p95AgeMs !== null &&
      p95AgeMs <= 500 && maxGapMs <= 1000 && !s.errors && !s.closes };
});
for (const socket of sockets) socket.close();
const configured = fleet?.devices ?? [];
if (topology) for (const root of topology) for (const device of root.devices) {
  if (device.cameraIdentity) device.deviceId = configured.find(d => d.cameraIdentity?.toLowerCase() === device.cameraIdentity)?.id ?? null;
}
const report = { at: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt, target,
  criteria: { minimumFps: 10, maximumP95AgeMs: 500, maximumGapMs: 1000,
    note: 'Local control-plane frame metadata age, not sensor-to-customer display latency. Physical touch accuracy, simultaneous motion, and remote customer acceptance require separate tests.' },
  host: { model: command('sysctl', ['-n', 'hw.model']), cpu: command('sysctl', ['-n', 'machdep.cpu.brand_string']),
    memoryBytes: Number(command('sysctl', ['-n', 'hw.memsize'])), swap: command('sysctl', ['vm.swapusage']) },
  topology, policy: fleet?.videoCapture ?? null, connectedCount: connected.length,
  videoPassingCount: rows.filter(d => d.videoPass).length, devices: rows,
  passed: connected.length >= target && final.filter(d => d.connected).length >= target &&
    rows.filter(d => d.videoPass).length >= target && rows.every(d => d.videoPass) };
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
