/** Mail views use authenticated provenance, never a claimed sender name, for ownership. */
import type { Database } from 'bun:sqlite';
import { NetworkError } from './external';

export const PREVIEW_CHARS = 200;
export const THREAD_DEPTH = 64;
export const THREAD_NODES = 1000;
export type MailActor = { kind: 'network' | 'native'; id: string; local: string };
type Row = { id: string; agent: string; sender: string; msg_type: string; body: string; created_at: string;
  read: number; read_at: string | null; in_reply_to: string | null; written_by: string | null;
  seq: number; peer: string | null; payload: string | null };
const select = 'SELECT i.*, i.rowid AS seq, e.peer, e.payload FROM inbox i LEFT JOIN network_envelope e ON e.inbox_id = i.id';
const visibility = (a: MailActor) => a.kind === 'network' ? '(i.agent = ? OR e.peer = ?)' : '(i.agent = ? OR i.written_by = ?)';
function internalId(db: Database, a: MailActor, ref: string): string {
  if (ref.length > 512) return '';
  if (a.local && ref.startsWith(a.local + '/')) return ref.slice(a.local.length + 1);
  const receipt = db.query('SELECT inbox_id FROM network_envelope WHERE id = ?').get(ref) as { inbox_id: string } | null;
  return receipt?.inbox_id ?? ref;
}
function visible(db: Database, a: MailActor, id: string): Row | null {
  return db.query(`${select} WHERE i.id = ? AND ${visibility(a)}`).get(id, a.id, a.id) as Row | null;
}
export function replyTarget(db: Database, a: MailActor, ref: string): string {
  const row = visible(db, a, internalId(db, a, ref));
  if (!row) throw new NetworkError(403, 'reply target unavailable');
  return row.id;
}
const wire = (a: MailActor, id: string) => `${a.local}/${id}`;
function envelope(row: Row) {
  // A received local notice has its local fields. Sent API mail retains the original envelope text/type.
  if (row.payload) return JSON.parse(row.payload) as { origin: string; sender: string; recipient: string; type: string; body: string; at: string };
  return { origin: null, sender: row.sender, recipient: row.agent, type: row.msg_type, body: row.body, at: row.created_at };
}
function listItem(db: Database, a: MailActor, row: Row) {
  const e = envelope(row);
  const parent = row.in_reply_to && visible(db, a, row.in_reply_to);
  return { id: wire(a, row.id), direction: a.kind === 'network' ? (row.peer === a.id ? 'sent' : 'received') : (row.agent === a.id ? 'received' : 'sent'),
    sender: e.sender, recipient: e.recipient, type: e.type, at: e.at,
    preview: [...(e.body.split(/\r\n|[\r\n\u2028\u2029]/u)[0] ?? '')].slice(0, PREVIEW_CHARS).join(''),
    read: row.read === 1, readAt: row.read_at,
    inReplyTo: parent ? wire(a, parent.id) : null };
}
export function mailMessage(db: Database, a: MailActor, ref: string) {
  const row = visible(db, a, internalId(db, a, ref));
  if (!row) throw new NetworkError(404, 'message unavailable');
  const e = envelope(row);
  return { ...listItem(db, a, row), origin: a.local, body: e.body };
}
function page(params: URLSearchParams) {
  const raw = params.get('limit');
  const limit = raw === null ? 20 : Number(raw);
  if (params.getAll('limit').length > 1 || (raw !== null && !/^[1-9]\d*$/.test(raw)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new NetworkError(400, 'limit must be an integer from 1 to 100');
  return limit;
}
export function sentMail(db: Database, a: MailActor, params: URLSearchParams) {
  const limit = page(params), since = params.get('since'), withPeer = params.get('with');
  if (params.getAll('since').length > 1 || params.getAll('with').length > 1 ||
      (withPeer !== null && !/^[a-z][a-z0-9_-]{0,62}$/.test(withPeer)) ||
      (since !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(Date.parse(since)))))
    throw new NetworkError(400, 'invalid sent parameters');
  const rows = db.query(`${select} WHERE e.peer = ?
    AND (? IS NULL OR i.agent = ?) AND (? IS NULL OR julianday(i.created_at) > julianday(?))
    ORDER BY julianday(i.created_at) DESC, i.rowid DESC LIMIT ?`).all(a.id, withPeer, withPeer, since, since, limit) as Row[];
  return { messages: rows.map(row => listItem(db, a, row)) };
}
export function mailList(db: Database, a: MailActor, params: URLSearchParams) {
  const limit = page(params), withPeer = params.get('with');
  if (params.getAll('with').length > 1 || (withPeer !== null && !/^[a-z][a-z0-9_-]{0,62}$/.test(withPeer))) throw new NetworkError(400, 'invalid with');
  const outgoing = a.kind === 'network' ? 'e.peer = ?' : 'i.written_by = ?';
  const rows = db.query(`${select} WHERE ${visibility(a)} AND (? IS NULL OR (CASE WHEN ${outgoing} THEN i.agent ELSE i.sender END) = ?)
    ORDER BY julianday(i.created_at) DESC, i.rowid DESC LIMIT ?`).all(a.id, a.id, withPeer, a.id, withPeer, limit) as Row[];
  return { messages: rows.map(row => listItem(db, a, row)) };
}
export function mailThread(db: Database, a: MailActor, ref: string, params: URLSearchParams) {
  const limit = page(params);
  const start = visible(db, a, internalId(db, a, ref));
  if (!start) throw new NetworkError(404, 'message unavailable');
  let root = start.id;
  const ancestors = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (ancestors.has(root)) throw new NetworkError(409, 'thread cycle detected');
    if (depth >= THREAD_DEPTH) throw new NetworkError(413, 'thread depth limit exceeded');
    ancestors.add(root);
    const meta = db.query('SELECT in_reply_to FROM inbox WHERE id = ?').get(root) as { in_reply_to: string | null } | null;
    if (!meta?.in_reply_to || !db.query('SELECT 1 FROM inbox WHERE id = ?').get(meta.in_reply_to)) break;
    root = meta.in_reply_to;
  }
  const seen = new Set<string>();
  const queue = [{ id: root, depth: 0 }], rows: Row[] = [];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (seen.has(node.id)) throw new NetworkError(409, 'thread cycle detected');
    seen.add(node.id);
    const row = visible(db, a, node.id);
    if (row) rows.push(row);
    const children = db.query('SELECT id FROM inbox WHERE in_reply_to = ? ORDER BY rowid LIMIT ?')
      .all(node.id, THREAD_NODES - queue.length + 1) as { id: string }[];
    for (const child of children) {
      if (node.depth + 1 >= THREAD_DEPTH || queue.length >= THREAD_NODES) { truncated = true; break; }
      queue.push({ id: child.id, depth: node.depth + 1 });
    }
  }
  rows.sort((x,y) => (Date.parse(x.created_at) || 0) - (Date.parse(y.created_at) || 0) || x.seq - y.seq);
  return { messages: rows.slice(0, limit).map(row => listItem(db, a, row)), truncated: truncated || rows.length > limit };
}
