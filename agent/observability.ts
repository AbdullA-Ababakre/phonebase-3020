import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type EventInput = {
  kind: string; level?: 'info' | 'warning' | 'error'; actor?: string; source?: string;
  deviceId?: string; requestId?: string; receiptId?: string; actionType?: string;
  status?: string; durationMs?: number; details?: unknown;
};
export function safeDetails(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth limit]';
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 500);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 24).map(v => safeDetails(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key,
    /token|secret|password|authorization|cookie|access.?code|fingerprint|^image$|imageData|imageBase64|base64|^text$|^body$|^url$/i.test(key)
      ? '[redacted]' : safeDetails(item, depth + 1)]));
  return null;
}
export function actionDetails(value: unknown) {
  const action = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const fields = ['type', 'point', 'start', 'end', 'viewport', 'frameSequence', 'durationMs', 'touchZ', 'key', 'axis', 'distance', 'feed'];
  return safeDetails({ ...Object.fromEntries(fields.filter(k => k in action).map(k => [k, action[k]])),
    ...(typeof action.text === 'string' ? { textLength: action.text.length } : {}) });
}
export function clientSource(value: unknown) {
  return ['dashboard', 'mcp', 'api'].includes(String(value)) ? String(value) : 'api';
}

export function actionConfirmation(result: unknown) {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  return value.phoneUiVerified === true ? 'phone UI visually verified' :
    value.phoneUiVerified === false ? 'phone UI not verified; inspect status and result' :
      'controller only; phone UI outcome not independently verified';
}

/** Sample only healthy, repetitive status polling. Never sample commands,
 * screenshots, errors or slow requests; those are needed to reconstruct trials. */
export class RoutinePollSampler {
  private last = new Map<string, number>();
  readonly intervalMs = 30_000;
  skipped = 0;
  sample(event: EventInput, now = Date.now()): EventInput | null {
    const details = event.details as { method?: string; path?: string } | undefined;
    const routine = (event.kind === 'http.request' || event.kind === 'gateway.request') &&
      details?.method === 'GET' &&
      (details.path === '/api/v1/devices' || details.path === '/api/v1/admin/rentals') &&
      /^2\d\d$/.test(event.status ?? '') && event.level !== 'error' && event.level !== 'warning' &&
      typeof event.durationMs === 'number' && event.durationMs < 500;
    if (!routine) return event;
    const key = JSON.stringify([event.kind, event.source, event.actor, event.deviceId, details?.path]);
    const last = this.last.get(key);
    if (last !== undefined && now - last < this.intervalMs) { this.skipped++; return null; }
    // Keep memory bounded even if arbitrary actor headers are supplied locally.
    if (this.last.size >= 2_000) for (const [key, at] of this.last) {
      if (now - at >= this.intervalMs) this.last.delete(key);
    }
    if (this.last.size >= 2_000) this.last.delete(this.last.keys().next().value!);
    this.last.set(key, now);
    return { ...event, details: { ...details, sampled: true, sampleIntervalMs: this.intervalMs } };
  }
}
export class ObservabilityStore {
  private db: DatabaseSync;
  private lastPrune = 0;
  private writeFailures = 0;
  private polls = new RoutinePollSampler();
  constructor(path: string, private retentionDays = 30, private maxEvents = 250_000) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=50;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        level TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, deviceId TEXT NOT NULL,
        requestId TEXT NOT NULL, receiptId TEXT NOT NULL, actionType TEXT NOT NULL,
        status TEXT NOT NULL, durationMs REAL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE INDEX IF NOT EXISTS events_request ON events(requestId);
      CREATE INDEX IF NOT EXISTS events_device_at ON events(deviceId,at);
      CREATE INDEX IF NOT EXISTS events_actor_at ON events(actor,at);
      CREATE TABLE IF NOT EXISTS incidents (
        key TEXT PRIMARY KEY, title TEXT NOT NULL, level TEXT NOT NULL, deviceId TEXT NOT NULL,
        openedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, resolvedAt INTEGER,
        occurrences INTEGER NOT NULL, details TEXT NOT NULL);
    `);
    if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }
  record(event: EventInput) {
    const sampled = this.polls.sample(event);
    if (!sampled) return;
    event = sampled;
    try {
      const bounded = (v?: string) => String(v ?? '').slice(0, 180);
      this.db.prepare('INSERT INTO events (at,kind,level,actor,source,deviceId,requestId,receiptId,actionType,status,durationMs,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(Date.now(), bounded(event.kind), event.level ?? 'info', bounded(event.actor ?? 'system'), bounded(event.source ?? 'system'), bounded(event.deviceId), bounded(event.requestId), bounded(event.receiptId), bounded(event.actionType), bounded(event.status), Number.isFinite(event.durationMs) ? Math.max(0,event.durationMs!) : null, JSON.stringify(safeDetails(event.details ?? {})));
      if (Date.now() - this.lastPrune > 60_000) {
        this.lastPrune = Date.now();
        this.db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - this.retentionDays * 86_400_000);
        const row = this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?').get(this.maxEvents) as {id?:number}|undefined;
        if (row?.id) this.db.prepare('DELETE FROM events WHERE id <= ?').run(row.id);
        this.db.prepare('DELETE FROM incidents WHERE resolvedAt IS NOT NULL AND resolvedAt < ?').run(Date.now() - this.retentionDays*86_400_000);
      }
    } catch { this.writeFailures++; console.error('Phonebase observability write failed'); }
  }
  flag(key: string, active: boolean, title: string, deviceId = '', details: unknown = {}, level = 'warning') {
    try {
      const now = Date.now();
      const prior = this.db.prepare('SELECT resolvedAt FROM incidents WHERE key = ?').get(key) as {resolvedAt: number|null}|undefined;
      if (!active) {
        if (prior?.resolvedAt === null) {
          this.db.prepare('UPDATE incidents SET resolvedAt = ?, updatedAt = ? WHERE key = ?').run(now, now, key);
          this.record({kind:'incident.resolved', deviceId, status:'resolved', details:{key,title}});
        }
        return;
      }
      this.db.prepare(`INSERT INTO incidents VALUES (?,?,?,?,?,?,NULL,1,?) ON CONFLICT(key) DO UPDATE SET
        title=excluded.title, level=excluded.level, updatedAt=excluded.updatedAt,
        openedAt=CASE WHEN incidents.resolvedAt IS NULL THEN incidents.openedAt ELSE excluded.openedAt END,
        resolvedAt=NULL, occurrences=incidents.occurrences+1, details=excluded.details`)
        .run(key, title, level, deviceId, now, now, JSON.stringify(safeDetails(details)));
      if (!prior || prior.resolvedAt !== null) this.record({kind:'incident.opened', level:level==='error'?'error':'warning', deviceId, status:'open', details:{key,title,...(safeDetails(details) as object)}});
    } catch { this.writeFailures++; }
  }
  query(params: URLSearchParams) {
    const terms = ['at >= ?']; const values: Array<string|number> = [];
    const since = Number(params.get('since'));
    values.push(Number.isFinite(since) && since > 0 ? since : Date.now() - 86_400_000);
    for (const key of ['deviceId','actor','source','level','requestId','receiptId','kind']) {
      const value = params.get(key); if (value) { terms.push(`${key} = ?`); values.push(value.slice(0,180)); }
    }
    const q=params.get('q')?.slice(0,120); if(q) {terms.push('(requestId LIKE ? OR receiptId LIKE ? OR actionType LIKE ? OR status LIKE ?)');values.push(...Array(4).fill(`%${q}%`));}
    const where=terms.join(' AND ');
    const count=this.db.prepare(`SELECT count(*) AS count FROM events WHERE ${where}`).get(...values) as {count:number};
    const cursor=Number(params.get('before')); if(cursor>0){terms.push('id < ?');values.push(cursor);}
    const requested=Number(params.get('limit')) || 100;const limit=Math.max(1,Math.min(500,Math.floor(requested)));
    const rows=this.db.prepare(`SELECT * FROM events WHERE ${terms.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values,limit) as Array<{id:number; details:string}>;
    return {events:rows.map(row=>({...row,details:JSON.parse(String(row.details))})), total:count.count, nextCursor:rows.length===limit?rows.at(-1)?.id:null};
  }
  summary() {
    const since=Date.now()-86_400_000;
    const metrics=this.db.prepare(`SELECT count(*) AS events, sum(level='error') AS errors, sum(kind='action.completed') AS completedActions, sum(kind='action.failed') AS failedActions FROM events WHERE at >= ?`).get(since);
    const timings=this.db.prepare("SELECT durationMs FROM events WHERE at >= ? AND kind = 'gateway.request' AND durationMs IS NOT NULL ORDER BY durationMs").all(since);
    const total=timings.length;
    const incidents=this.db.prepare('SELECT * FROM incidents ORDER BY (resolvedAt IS NULL) DESC, updatedAt DESC LIMIT 100').all().map(row=>{const r=row as {key:string;occurrences:number;resolvedAt:number|null;details:string};return {...r,details:JSON.parse(String(r.details))};});
    return {metrics, gatewayP95Ms:total?timings[Math.min(total-1,Math.floor(total*.95))].durationMs:null, incidents,
      storage:{retentionDays:this.retentionDays,maxEvents:this.maxEvents,writeFailures:this.writeFailures,
        routinePollsSampledOut:this.polls.skipped, routinePollSampleIntervalMs:this.polls.intervalMs}, updatedAt:Date.now()};
  }
  close(){this.db.close();}
}
export function requestIdentity(value: unknown) {
  const id=typeof value==='string'?value:'';
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(id)?id:randomUUID();
}
