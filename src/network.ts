/** Authenticated pull transport; never dispatches commands or launches processes. */
import type { Database } from 'bun:sqlite';
import { journal, tx } from './store';
import { ack, ackAll, deliver, readOwnUnread, signal, summarize } from './inbox';
import { submitReport } from './report';
import { address, authenticate, instanceId, listenerAddress, NetworkError, type Capability, type Peer } from './external';

export const BODY_LIMIT = 64 * 1024;
export type Envelope = { id: string; origin: string; sender: string; recipient: string; type: string; body: string; at: string };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function requireCapability(peer: Peer, capability: Capability) {
  if (!peer.capabilities.includes(capability)) throw new NetworkError(403, 'capability denied');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkError(400, 'JSON object required');
  return value as Record<string, unknown>;
}
async function body(req: Request): Promise<Record<string, unknown>> {
  const length = req.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new NetworkError(413, 'body too large');
  const reader = req.body?.getReader();
  if (!reader) throw new NetworkError(400, 'body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new NetworkError(413, 'body too large'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    throw new NetworkError(400, 'invalid JSON');
  } finally { reader.releaseLock(); }
}
function envelope(input: Record<string, unknown>, peer: Peer): Envelope {
  for (const key of ['id','origin','sender','recipient','type','body','at']) {
    if (typeof input[key] !== 'string') throw new NetworkError(400, `invalid envelope ${key}`);
  }
  const e = input as unknown as Envelope;
  if (!e.id.startsWith(`${peer.name}/`) || !/^[a-zA-Z0-9_/-]{1,180}$/.test(e.id) || e.origin !== peer.name)
    throw new NetworkError(403, 'envelope origin denied');
  const sender = address(e.sender);
  if (peer.kind === 'agent' ? e.sender !== peer.name : sender.peer !== peer.name) throw new NetworkError(403, 'sender denied');
  if (e.type.length < 1 || e.type.length > 64 || !Number.isFinite(Date.parse(e.at))) throw new NetworkError(400, 'invalid type or timestamp');
  address(e.recipient);
  // Canonical field order makes retries independent of JSON key order.
  return { id: e.id, origin: e.origin, sender: e.sender, recipient: e.recipient, type: e.type, body: e.body, at: e.at };
}
function duplicate(db: Database, peer: Peer, e: Envelope) {
  const old = db.query('SELECT peer,payload FROM network_envelope WHERE id = ?').get(e.id) as { peer: string; payload: string } | null;
  if (old && (old.peer !== peer.name || old.payload !== JSON.stringify(e))) throw new NetworkError(409, 'envelope id already used');
  return !!old;
}
function remember(db: Database, peer: Peer, e: Envelope, inboxId: string) {
  db.prepare('INSERT INTO network_envelope(id,peer,payload,inbox_id) VALUES (?,?,?,?)').run(e.id, peer.name, JSON.stringify(e), inboxId);
}

export function networkHandler(db: Database): (req: Request) => Promise<Response> {
  const local = instanceId(db);
  return async (req) => {
    let peer: Peer | undefined;
    let operation = 'unknown';
    let target: string | undefined;
    let status = 500;
    try {
      peer = authenticate(db, req.headers.get('authorization'));
      const path = new URL(req.url).pathname;
      const knownPath = ['/v1', '/v1/', '/v1/inbox/unread', '/v1/inbox/read', '/v1/inbox/ack', '/v1/inbox/write', '/v1/report/submit'].includes(path);
      operation = knownPath ? `${req.method} ${path}` : 'unsupported';
      const info = path === '/v1' || path === '/v1/';
      const capability: Capability | undefined = path.startsWith('/v1/inbox/')
        ? (path === '/v1/inbox/write' ? 'inbox.write' : 'inbox.read')
        : path === '/v1/report/submit' ? 'report.submit' : undefined;
      if (!info && !capability) throw new NetworkError(403, 'operation denied');
      if (capability) requireCapability(peer, capability);
      const done = (value: unknown) => { status = 200; return json(value); };
      if (info && req.method === 'GET') return done({ version: 1, instance: local, peer: peer.name, kind: peer.kind,
        capabilities: peer.capabilities, destinations: peer.destinations, direction: 'pull', pollSeconds: 5, bodyLimit: BODY_LIMIT });
      // A honden peer can exchange envelopes. Multi-agent inbox delegation needs a future protocol.
      if (peer.kind !== 'agent' && path !== '/v1/inbox/write') throw new NetworkError(403, 'agent operation required');
      if (req.method === 'GET' && path === '/v1/inbox/unread') {
        target = peer.name;
        return done({ unread: summarize(db, peer.name).total });
      }
      if (req.method === 'GET' && path === '/v1/inbox/read') {
        target = peer.name;
        const messages = readOwnUnread(db, peer.name).map((m) => ({ id: `${local}/${m.id}`, origin: local,
          sender: m.sender, recipient: peer!.name, type: m.type, body: m.body, at: m.createdAt }));
        return done({ messages });
      }
      if (req.method !== 'POST') throw new NetworkError(403, 'operation denied');
      const input = await body(req);
      // Authentication may have been revoked/rotated while the request body was arriving.
      peer = authenticate(db, req.headers.get('authorization'));
      requireCapability(peer, capability!);
      if (path === '/v1/inbox/ack') {
        target = peer.name;
        const result = db.transaction(() => {
          if (input['all'] === true) return ackAll(db, peer!.name);
          const ids = input['ids'];
          if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id.startsWith(`${local}/`)))
            throw new NetworkError(400, 'invalid message ids');
          const snapshot = db.query('SELECT ids FROM inbox_read_snapshot WHERE agent = ?').get(peer!.name) as { ids: string } | null;
          const shown: string[] = snapshot ? JSON.parse(snapshot.ids).ids : [];
          const native = ids.map((id: string) => id.slice(local.length + 1));
          if (native.some((id) => !shown.includes(id))) throw new NetworkError(403, 'message was not read by this peer');
          return ack(db, peer!.name, native);
        }).immediate();
        if (!result.ok) throw new NetworkError(409, result.message ?? 'ack refused');
        return done({ changed: result.changed.map((id) => `${local}/${id}`) });
      }
      if (path === '/v1/inbox/write' || path === '/v1/report/submit') {
        const e = envelope(input, peer);
        target = e.recipient;
        const recipient = address(e.recipient);
        if (recipient.peer) throw new NetworkError(403, 'outbound forwarding is not enabled');
        if (path === '/v1/inbox/write' && !peer.destinations.includes(e.recipient)) throw new NetworkError(403, 'destination denied');
        if (path === '/v1/report/submit' && (e.recipient !== 'gunshi' || e.type !== 'report.submit')) throw new NetworkError(403, 'reports go to gunshi');
        const result = db.transaction(() => {
          if (duplicate(db, peer!, e)) return { duplicate: true };
          if (path === '/v1/report/submit') {
            let report: Record<string, unknown>;
            try { report = object(JSON.parse(e.body)); } catch { throw new NetworkError(400, 'invalid report'); }
            const task = db.query('SELECT task_id,holder,status FROM task WHERE agent = ?').get(peer!.name) as
              { task_id: string; holder: string | null; status: string } | null;
            if (!task || task.holder !== peer!.name || task.task_id !== report['task_id'] || !['assigned','in_progress'].includes(task.status))
              throw new NetworkError(403, 'only a held subtask may be reported');
            const submitted = submitReport(db, peer!.name, report);
            if (!submitted.ok) throw new NetworkError(400, submitted.message ?? 'invalid report');
            remember(db, peer!, e, `report:${submitted.id}`);
          } else {
            if (!db.query('SELECT 1 FROM roster WHERE id = ?').get(e.recipient)) throw new NetworkError(403, 'destination no longer exists');
            const id = `external:${e.id}`;
            // Caller-selected event types never reach the internal command/event namespace.
            deliver(db, { id, agent: e.recipient, at: e.at, sender: e.sender, type: 'external_notice',
              body: `[external:${peer!.name} type:${e.type} id:${e.id}]\n${e.body}` });
            remember(db, peer!, e, id);
          }
          return { duplicate: false };
        }).immediate();
        signal(db);
        return done({ id: e.id, ...result });
      }
      throw new NetworkError(403, 'operation denied');
    } catch (e) {
      status = e instanceof NetworkError ? e.status : 500;
      return json({ error: e instanceof NetworkError ? e.message : 'internal error' }, status);
    } finally {
      journal(db, { actor: peer?.name ?? 'unauthenticated', action: 'network.request', target,
        detail: `${operation} status=${status}` });
    }
  };
}

export function serveNetwork(db: Database) {
  const configured = db.query('SELECT host,port FROM network_listener WHERE singleton = 1').get() as { host: string; port: number } | null;
  if (!configured) throw new NetworkError(403, 'network listener is disabled; configure an explicit IP first');
  const { host, port } = listenerAddress(configured.host, configured.port);
  return Bun.serve({ hostname: host, port, idleTimeout: 10, maxRequestBodySize: BODY_LIMIT, fetch: networkHandler(db) });
}
