import { parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { comparePhoneFrames } = await tsImport('./frame-sync.ts', import.meta.url);
parentPort.on('message', ({ id, input }) => {
  try {
    const result = comparePhoneFrames({ ...input, digitalJpeg: Buffer.from(input.digitalJpeg), physicalJpeg: Buffer.from(input.physicalJpeg) });
    parentPort.postMessage({ id, result });
  } catch { parentPort.postMessage({ id, error: true }); }
});
