import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
try {
  const owner = JSON.parse(readFileSync(resolve(root, '.runtime/fleet-supervisor.json'), 'utf8'));
  if (!Number.isInteger(owner.pid) || owner.pid <= 1) throw Error('Invalid fleet owner PID');
  const command = spawnSync('/bin/ps', ['-p', String(owner.pid), '-o', 'command='], {encoding:'utf8',timeout:3000}).stdout.trim();
  const cwd = spawnSync('/usr/sbin/lsof', ['-a','-p',String(owner.pid),'-d','cwd','-Fn'], {encoding:'utf8',timeout:3000}).stdout.split('\n').find(s=>s.startsWith('n'))?.slice(1);
  if (command === owner.command && command.endsWith(' bridge/fleet_supervisor.ts') && cwd === root) process.kill(owner.pid, 'SIGTERM');
} catch (error) {
  if (error.code !== 'ENOENT' && error.code !== 'ESRCH') console.error('Fleet owner shutdown was not confirmed:', error.message);
}
