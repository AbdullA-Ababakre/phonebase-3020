import { Worker } from 'node:worker_threads';
import type { comparePhoneFrames, FrameSyncResult } from './frame-sync';

type Input = Parameters<typeof comparePhoneFrames>[0];
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (value: FrameSyncResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function fail(error: Error) {
  const previous = worker;
  worker = null;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
  void previous?.terminate();
}
function getWorker() {
  if (worker) return worker;
  const created = new Worker(new URL('./frame-sync-background-worker.mjs', import.meta.url), { execArgv: [] });
  worker = created;
  created.on('message', ({ id, result, error }) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (error) item.reject(new Error('Screen comparison failed'));
    else item.resolve(result);
    if (!pending.size) created.unref();
  });
  created.on('error', () => { if (worker === created) fail(new Error('Screen comparison worker failed')); });
  created.on('exit', () => { if (worker === created) fail(new Error('Screen comparison worker stopped')); });
  created.unref();
  return created;
}
/** Same pixels and scoring as synchronous comparison; bounded and fail-closed. */
export function comparePhoneFramesBackground(input: Input): Promise<FrameSyncResult> {
  if (pending.size >= 4) return Promise.reject(new Error('Screen comparison is busy'));
  const current = getWorker();
  current.ref();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Screen comparison timed out')), 2000);
    pending.set(id, { resolve, reject, timer });
    try { current.postMessage({ id, input }); }
    catch { fail(new Error('Unable to dispatch screen comparison')); }
  });
}
export function stopFrameSyncBackground() { fail(new Error('Screen comparison stopped')); }
