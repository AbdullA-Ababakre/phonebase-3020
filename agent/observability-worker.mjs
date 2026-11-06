import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { ObservabilityStore } = await import('./observability.ts');
const store = new ObservabilityStore(workerData.path);
parentPort.on('message', message => {
  try {
    const result = message.method === 'query'
      ? store.query(new URLSearchParams(message.args[0]))
      : store[message.method](...message.args);
    parentPort.postMessage({id:message.id,result});
  } catch {
    parentPort.postMessage({id:message.id,error:'Activity storage unavailable'});
  }
});
