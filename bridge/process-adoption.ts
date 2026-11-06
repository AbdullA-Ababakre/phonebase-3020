import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

export type ManagedProcess = {
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

function output(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3_000 });
  if (result.error) throw result.error;
  return result.stdout.trim();
}

export function listenerPid(port: number): number | null {
  const rows = output("/usr/sbin/lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])
    .split(/\s+/).filter(Boolean).map(Number);
  const pids = [...new Set(rows)];
  if (pids.length > 1 || pids.some(pid => !Number.isInteger(pid) || pid <= 1)) {
    throw new Error(`Ambiguous listener on ${port}; refusing adoption or duplicate startup.`);
  }
  return pids[0] ?? null;
}

export function processCommand(pid: number) {
  return output("/bin/ps", ["-p", String(pid), "-o", "command="]);
}

export function assertStationProcess(pid: number, root: string, script: string, serial?: string) {
  const cwd = output("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n").find(row => row.startsWith("n"))?.slice(1);
  if (cwd !== root || !processCommand(pid).endsWith(` ${script}`)) {
    throw new Error(`Listener ${pid} does not belong to this station; refusing adoption.`);
  }
  if (serial && !output("/usr/sbin/lsof", ["-p", String(pid), "-Fn"])
    .split("\n").includes(`n${serial}`)) {
    throw new Error(`Driver ${pid} does not own the configured serial; refusing adoption.`);
  }
}

/** Observe an orphan without restarting its controller or inventing homing state. */
export function adoptedProcess(pid: number): ManagedProcess {
  const command = processCommand(pid);
  if (!command) throw new Error(`Process ${pid} exited before adoption.`);
  const events = new EventEmitter();
  let alive = true;
  const timer = setInterval(() => {
    try { if (processCommand(pid) === command) return; } catch { return; }
    alive = false; clearInterval(timer); events.emit("exit", null, null);
  }, 1_000);
  timer.unref();
  return {
    once: (event, listener) => events.once(event, listener),
    kill: (signal = "SIGTERM") => {
      try {
        if (!alive || processCommand(pid) !== command) return false;
        process.kill(pid, signal); return true;
      } catch { return false; }
    },
  };
}

export function matchingProcess(command: string): number | null {
  const matches = output("/bin/ps", ["-axo", "pid=,command="]).split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(match => match?.[2] === command).map(match => Number(match![1]));
  if (matches.length > 1) throw new Error("Multiple matching capture processes; refusing adoption.");
  return matches[0] ?? null;
}

export function matchingProcessPrefix(prefix: string): number | null {
  const matches = output('/bin/ps', ['-axo', 'pid=,command=']).split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(match => match?.[2].startsWith(prefix)).map(match => Number(match![1]));
  if (matches.length > 1) throw new Error('Ambiguous existing capture; refusing duplicate startup.');
  return matches[0] ?? null;
}
