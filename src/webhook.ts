/** Count-only notifications. Inbox writers never call this transport. */
import type { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, writeFileSync, unlinkSync, readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { databasePath, journal, tx } from './store';
import { NetworkError } from './external';

export const WEBHOOK_WINDOW_MS = 30_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_ATTEMPTS = 4;
export const WEBHOOK_POLL_MS = 1000;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

function keyDirectory(db: Database): string {
  const path = databasePath(db);
  if (!path || path === ':memory:') throw new NetworkError(400, 'webhooks require a persistent store');
  return join(dirname(resolve(path)), 'webhook-keys');
}
function keyPath(db: Database, file: string): string {
  if (!/^[a-f0-9-]{36}\.key$/.test(file)) throw new Error('invalid private key reference');
  return join(keyDirectory(db), file);
}
export function webhookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new NetworkError(400, 'invalid webhook URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(value))
    throw new NetworkError(400, 'webhook URL must use http/https without credentials');
  return url;
}
function removeKey(db: Database, file: string | null) {
  if (file) { try { unlinkSync(keyPath(db, file)); } catch { /* Never leak filesystem errors or secret paths. */ } }
}

/** Setting the URL also rotates the signing key. Only this return value reveals it. */
export function configureWebhook(db: Database, actor: string | undefined, name: string, value: string | null): string | null {
  if (actor !== 'shogun') throw new NetworkError(403, 'only shogun may manage webhook destinations and keys');
  const old = db.query('SELECT webhook_key_file FROM external_peer WHERE name = ?').get(name) as { webhook_key_file: string | null } | null;
  if (!old) throw new NetworkError(404, 'peer not found');
  const url = value === null ? null : webhookUrl(value);
  const key = url ? randomBytes(32).toString('base64url') : null;
  const file = key ? `${randomUUID()}.key` : null;
  if (key && file) {
    try {
      const dir = keyDirectory(db);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700) throw new Error('private directory required');
      writeFileSync(keyPath(db, file), key, { flag: 'wx', mode: 0o600 });
    } catch { throw new NetworkError(400, 'could not create a private webhook key'); }
  }
  try {
    tx(db, () => {
      db.prepare('UPDATE external_peer SET webhook_url = ?, webhook_key_file = ?, webhook_key_hash = ? WHERE name = ?')
        .run(url?.href ?? null, file, key ? digest(key) : null, name);
      db.prepare('DELETE FROM webhook_state WHERE peer = ?').run(name);
      journal(db, { actor, action: url ? 'webhook.configure' : 'webhook.disable', target: name,
        detail: url ? `host=${url.host}` : 'disabled' });
    });
  } catch (e) { removeKey(db, file); throw e; }
  removeKey(db, old.webhook_key_file);
  return key;
}

type Destination = { name: string; webhook_url: string; webhook_key_file: string; webhook_key_hash: string };
type State = { observed_unread: number; cursor: number; pending: number; attempts: number; last_attempt_at: number | null; last_result: string | null; next_at: number };
type Options = { now?: () => number; fetch?: typeof fetch; timeoutMs?: number };

function signingKey(db: Database, row: Destination): string {
  const fd = openSync(keyPath(db, row.webhook_key_file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) throw new Error('private key permissions required');
    const key = readFileSync(fd, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || digest(key) !== row.webhook_key_hash) throw new Error('private key mismatch');
    return key;
  } finally { closeSync(fd); }
}

export class WebhookSender {
  private now: () => number;
  private fetcher: typeof fetch;
  private timeout: number;
  private stopped = false;
  private inFlight = new Map<string, AbortController>();
  constructor(private db: Database, opts: Options = {}) {
    this.now = opts.now ?? Date.now;
    this.fetcher = opts.fetch ?? fetch;
    this.timeout = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  }
  private log(peer: Destination, action: string, result: string) {
    journal(this.db, { actor: 'network', action: `webhook.${action}`, target: peer.name,
      detail: `host=${webhookUrl(peer.webhook_url).host} ${result}`, at: new Date(this.now()) });
  }
  private state(name: string): State {
    return this.db.query('SELECT * FROM webhook_state WHERE peer = ?').get(name) as State;
  }
  /** Poll only counts and row boundaries. No message body, sender or type is selected. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const peers = this.db.query(`SELECT name,webhook_url,webhook_key_file,webhook_key_hash FROM external_peer
      WHERE key_hash IS NOT NULL AND webhook_url IS NOT NULL AND webhook_key_file IS NOT NULL`).all() as Destination[];
    const jobs: Promise<void>[] = [];
    for (const peer of peers) {
      const now = this.now();
      this.db.prepare('INSERT OR IGNORE INTO webhook_state(peer) VALUES (?)').run(peer.name);
      const state = this.state(peer.name);
      const unread = this.db.query('SELECT count(*) n, COALESCE(MAX(rowid),0) boundary FROM inbox WHERE agent = ? AND read = 0').get(peer.name) as { n: number; boundary: number };
      const increased = unread.n > 0 && (unread.n > state.observed_unread || unread.boundary > state.cursor);
      if (increased) {
        const due = state.pending ? state.next_at : Math.max(now, (state.last_attempt_at ?? -WEBHOOK_WINDOW_MS) + WEBHOOK_WINDOW_MS);
        if (state.pending || due > now || unread.n - state.observed_unread > 1) this.log(peer, 'coalesce', 'pending');
        this.db.prepare('UPDATE webhook_state SET pending = 1, next_at = ?, attempts = ? WHERE peer = ?')
          .run(due, state.pending ? state.attempts : 0, peer.name);
      }
      this.db.prepare('UPDATE webhook_state SET observed_unread = ?, cursor = MAX(cursor,?) WHERE peer = ?').run(unread.n, unread.boundary, peer.name);
      if (!unread.n) this.db.prepare('UPDATE webhook_state SET pending = 0, attempts = 0 WHERE peer = ?').run(peer.name);
      const latest = this.state(peer.name);
      if (latest.pending && latest.next_at <= now && !this.inFlight.has(peer.name)) {
        // A process may have stopped after recording its final attempt, before receiving a response.
        if (latest.attempts >= WEBHOOK_MAX_ATTEMPTS) {
          this.db.prepare("UPDATE webhook_state SET pending = 0, last_result = 'gave_up' WHERE peer = ?").run(peer.name);
          this.log(peer, 'give_up', 'attempt_limit');
        } else jobs.push(this.send(peer, latest));
      }
    }
    await Promise.all(jobs);
  }
  private async send(peer: Destination, state: State): Promise<void> {
    const control = new AbortController();
    this.inFlight.set(peer.name, control);
    const now = this.now();
    const attempt = state.attempts + 1;
    this.db.prepare('UPDATE webhook_state SET last_attempt_at = ?, attempts = ?, next_at = ? WHERE peer = ?')
      .run(now, attempt, now + WEBHOOK_WINDOW_MS, peer.name);
    this.log(peer, 'send', `attempt=${attempt}`);
    const timer = setTimeout(() => control.abort(), this.timeout);
    let result = 'key_unavailable';
    let success = false;
    let retry = false;
    try {
      const key = signingKey(this.db, peer);
      const at = new Date(now).toISOString();
      const payload = JSON.stringify({ peer: peer.name, unread: state.observed_unread, at, id: randomUUID() });
      const signature = createHmac('sha256', key).update(`${at}.${payload}`).digest('hex');
      result = 'network_error';
      try {
        const response = await this.fetcher(peer.webhook_url, { method: 'POST', redirect: 'manual', signal: control.signal,
          headers: { 'Content-Type': 'application/json', 'X-Honden-Timestamp': at, 'X-Honden-Signature': `sha256=${signature}` }, body: payload });
        void response.body?.cancel().catch(() => {});
        success = response.status >= 200 && response.status < 300;
        retry = response.status >= 500;
        result = `http_${response.status}`;
      } catch { retry = true; result = control.signal.aborted ? 'timeout' : 'network_error'; }
    } catch { /* Only a redacted classification is recorded. */ }
    finally { clearTimeout(timer); this.inFlight.delete(peer.name); }
    if (this.stopped) return;
    const current = this.db.query('SELECT webhook_key_file,key_hash FROM external_peer WHERE name = ?').get(peer.name) as { webhook_key_file: string | null; key_hash: string | null } | null;
    if (current?.webhook_key_file !== peer.webhook_key_file || !current.key_hash) return;
    const latest = this.state(peer.name);
    const more = latest.cursor > state.cursor || latest.observed_unread > state.observed_unread;
    if (success) {
      this.db.prepare("UPDATE webhook_state SET pending = ?, attempts = 0, last_result = 'success' WHERE peer = ?").run(more ? 1 : 0, peer.name);
      this.log(peer, 'success', result);
    } else {
      const again = retry && attempt < WEBHOOK_MAX_ATTEMPTS;
      // Ending this notification must not discard mail observed while its request was in flight.
      this.db.prepare('UPDATE webhook_state SET pending = ?, attempts = ?, next_at = ?, last_result = ? WHERE peer = ?')
        .run(again || more ? 1 : 0, !again && more ? 0 : attempt,
          now + (again ? WEBHOOK_WINDOW_MS * 2 ** (attempt - 1) : WEBHOOK_WINDOW_MS),
          again ? 'retry' : 'gave_up', peer.name);
      this.log(peer, 'failure', `${result} attempt=${attempt}`);
      if (!again) this.log(peer, 'give_up', result);
    }
  }
  stop() { this.stopped = true; for (const control of this.inFlight.values()) control.abort(); }
}

export function startWebhookSender(db: Database, opts: Options = {}) {
  const sender = new WebhookSender(db, opts);
  const poll = () => { void sender.tick().catch(() => {
    journal(db, { actor: 'network', action: 'webhook.failure', detail: 'poll_error' });
  }); };
  const interval = setInterval(poll, WEBHOOK_POLL_MS);
  interval.unref();
  poll();
  return { stop() { clearInterval(interval); sender.stop(); } };
}
