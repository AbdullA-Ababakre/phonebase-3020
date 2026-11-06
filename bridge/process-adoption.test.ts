import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { adoptedProcess, assertStationProcess, listenerPid, matchingProcess, processCommand } from './process-adoption';

test('an occupied unrelated listener is identified and rejected for hardware adoption', async () => {
  const server = createServer((_req, res) => res.end('test'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(listenerPid(port), process.pid);
    assert.throws(() => assertStationProcess(process.pid, process.cwd(), 'bridge/black_arm_driver.py', '/dev/cu.fake'), /does not belong/);
  } finally { server.close(); }
});

test('orphan observation preserves the existing process until explicitly stopped', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)']);
  await once(child, 'spawn');
  const pid = child.pid!;
  const observed = adoptedProcess(pid);
  assert.equal(matchingProcess(processCommand(pid)), pid);
  assert.doesNotThrow(() => process.kill(pid, 0));
  const exited = new Promise(resolve => observed.once('exit', resolve));
  assert.equal(observed.kill('SIGTERM'), true);
  await exited;
  assert.equal(observed.kill('SIGTERM'), false);
});
