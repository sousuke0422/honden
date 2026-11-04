/** External identities live apart from the pane roster. Keys never enter the journal. */
import type { Database } from 'bun:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { journal, tx } from './store';

export const CAPABILITIES = ['inbox.read', 'inbox.write', 'report.submit'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Peer = { name: string; kind: 'agent' | 'honden'; direction: 'pull'; capabilities: Capability[]; destinations: string[] };
export class NetworkError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const NAME = /^[a-z][a-z0-9_-]{0,62}$/;

export function address(value: string): { name: string; peer: string | null } {
  const parts = value.split('@');
  if (parts.length > 2 || !parts.every((p) => NAME.test(p))) throw new NetworkError(400, 'invalid address');
  return { name: parts[0]!, peer: parts[1] ?? null };
}
export function peers(db: Database): Peer[] {
  return (db.query('SELECT name, kind, direction, capabilities, destinations FROM external_peer ORDER BY name').all() as
    { name: string; kind: Peer['kind']; direction: 'pull'; capabilities: string; destinations: string }[])
    .map((p) => ({ ...p, capabilities: JSON.parse(p.capabilities), destinations: JSON.parse(p.destinations) }));
}
export function externalAgent(db: Database, id: string): boolean {
  return !!db.query("SELECT 1 FROM external_peer WHERE name = ? AND kind = 'agent' AND key_hash IS NOT NULL").get(id);
}
export function externalWorkers(db: Database) {
  return peers(db).filter((p) => p.kind === 'agent' && externalAgent(db, p.name))
    .map((p) => ({ id: p.name, role: 'worker' as const, cli: null, model: null }));
}
function commander(actor: string | undefined) {
  if (actor !== 'shogun') throw new NetworkError(403, 'only shogun may manage external peers or the listener');
}
export function issuePeer(db: Database, actor: string | undefined, input: Peer): string {
  commander(actor);
  if (!NAME.test(input.name) || /^ashigaru\d+$/.test(input.name) || ['shogun','karo','gunshi'].includes(input.name) ||
      db.query('SELECT 1 FROM roster WHERE id = ?').get(input.name)) throw new NetworkError(400, 'invalid or reserved peer name');
  if (!['agent','honden'].includes(input.kind) || input.direction !== 'pull') throw new NetworkError(400, 'invalid kind or direction');
  if (!Array.isArray(input.capabilities) || input.capabilities.some((c) => !CAPABILITIES.includes(c)) ||
      !Array.isArray(input.destinations) || input.destinations.some((d) => typeof d !== 'string')) throw new NetworkError(400, 'invalid permissions');
  for (const d of input.destinations) {
    const a = address(d);
    if (a.peer || !db.query('SELECT 1 FROM roster WHERE id = ?').get(a.name)) throw new NetworkError(400, 'only local roster destinations are supported');
  }
  const key = randomBytes(32).toString('base64url');
  tx(db, () => {
    if (db.query('SELECT 1 FROM external_peer WHERE name = ?').get(input.name)) throw new NetworkError(409, 'peer already exists; rotate its key');
    db.prepare('INSERT INTO external_peer(name, kind, direction, key_hash, capabilities, destinations, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(input.name, input.kind, 'pull', hash(key), JSON.stringify([...new Set(input.capabilities)]), JSON.stringify([...new Set(input.destinations)]), new Date().toISOString());
    journal(db, { actor: actor!, action: 'network.peer.issue', target: input.name });
  });
  return key;
}
export function changeKey(db: Database, actor: string | undefined, name: string, revoke: boolean): string | null {
  commander(actor);
  const key = revoke ? null : randomBytes(32).toString('base64url');
  tx(db, () => {
    const r = db.prepare('UPDATE external_peer SET key_hash = ? WHERE name = ?').run(key ? hash(key) : null, name);
    if (!r.changes) throw new NetworkError(404, 'peer not found');
    journal(db, { actor: actor!, action: revoke ? 'network.peer.revoke' : 'network.peer.rotate', target: name });
  });
  return key;
}
export function authenticate(db: Database, auth: string | null): Peer {
  const key = auth?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const row = key ? db.query('SELECT name FROM external_peer WHERE key_hash = ?').get(hash(key)) as { name: string } | null : null;
  if (!row) throw new NetworkError(401, 'unauthorized');
  return peers(db).find((p) => p.name === row.name)!;
}
export function listenerAddress(host: string, port: number) {
  const normalized = isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname : host;
  if (!isIP(host) || host === '0.0.0.0' || normalized === '[::]' || normalized === '[::ffff:0:0]')
    throw new NetworkError(400, 'an explicit non-wildcard IP address is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new NetworkError(400, 'invalid port');
  return { host, port };
}
export function configureListener(db: Database, actor: string | undefined, host: string | null, port = 8789) {
  commander(actor);
  if (host !== null) listenerAddress(host, port);
  tx(db, () => {
    db.run('DELETE FROM network_listener');
    if (host !== null) db.prepare('INSERT INTO network_listener(singleton, host, port) VALUES (1,?,?)').run(host, port);
    journal(db, { actor: actor!, action: 'network.configure', target: host ?? 'disabled', detail: host ? `port=${port}` : undefined });
  });
}
export function instanceId(db: Database): string {
  db.prepare('INSERT OR IGNORE INTO network_instance(singleton,id) VALUES (1,?)').run(crypto.randomUUID());
  return (db.query('SELECT id FROM network_instance WHERE singleton = 1').get() as { id: string }).id;
}
export function peerStatus(db: Database) {
  return peers(db).map((p) => ({ ...p, enabled: externalAgent(db, p.name) || !!db.query('SELECT 1 FROM external_peer WHERE name = ? AND key_hash IS NOT NULL').get(p.name),
    unread: (db.query('SELECT count(*) n FROM inbox WHERE agent = ? AND read = 0').get(p.name) as { n: number }).n,
    last: db.query("SELECT at,action,detail FROM ledger WHERE actor = ? AND action LIKE 'network.%' ORDER BY id DESC LIMIT 1").get(p.name) }));
}
