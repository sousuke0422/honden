import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { syncRoster } from '../src/roster';
import { issuePeer, changeKey, peerStatus, configureListener } from '../src/external';
import { deliver } from '../src/inbox';
import { configureWebhook, WebhookSender, webhookUrl } from '../src/webhook';
import { serveNetwork } from '../src/network';
import { plan } from '../src/nudge';

let db: Database, dir: string, key: string, now: number;
const senders: WebhookSender[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honden-webhook-'));
  db = openStore({ path: join(dir, 'test.db') });
  syncRoster(db, [{ id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null }]);
  issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull', capabilities: ['inbox.read'], destinations: [] });
  now = Date.parse('2026-01-01T00:00:00Z');
  key = configureWebhook(db, 'shogun', 'visitor', 'https://example.test/private-path?token=hidden')!;
});
afterEach(() => { for (const s of senders.splice(0)) s.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
function mail(id: string) {
  deliver(db, { id, agent: 'visitor', at: new Date(now).toISOString(), sender: 'karo', type: 'message', body: 'PRIVATE MESSAGE BODY' });
}
function worker(fetcher: (input: any, init?: RequestInit) => Promise<Response>, timeoutMs?: number) {
  const s = new WebhookSender(db, { now: () => now, fetch: fetcher as typeof fetch, timeoutMs });
  senders.push(s); return s;
}
const state = () => db.query('SELECT * FROM webhook_state').get() as any;
function valid(init: RequestInit) {
  const headers = new Headers(init.headers), raw = String(init.body);
  const payload = JSON.parse(raw);
  const expected = 'sha256=' + createHmac('sha256', key).update(`${headers.get('X-Honden-Timestamp')}.${raw}`).digest('hex');
  // Compare booleans so assertion diagnostics cannot reveal a key or signature.
  expect(headers.get('X-Honden-Signature') === expected).toBe(true);
  expect(headers.get('X-Honden-Timestamp')).toBe(payload.at);
  expect(Object.keys(payload).sort()).toEqual(['at', 'id', 'peer', 'unread']);
  expect(payload.peer).toBe('visitor');
  expect(raw.includes('PRIVATE')).toBe(false);
  expect(payload.id).toMatch(/^[a-f0-9-]{36}$/);
  return payload;
}

test('only shogun configures, rotates and disables; credentials and other schemes rejected', () => {
  for (const actor of ['karo', 'visitor', undefined]) for (const url of [null, 'https://example.test'])
    expect(() => configureWebhook(db, actor, 'visitor', url)).toThrow('only shogun');
  for (const url of ['file:///tmp/a', 'ftp://example.test', 'https://u:p@example.test', 'https://@example.test', 'bad'])
    expect(() => webhookUrl(url)).toThrow();
  expect(webhookUrl('http://example.test').protocol).toBe('http:');
  const files = readdirSync(join(dir, 'webhook-keys'));
  expect(statSync(join(dir, 'webhook-keys')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'webhook-keys', files[0]!)).mode & 0o777).toBe(0o600);
  const row = db.query('SELECT webhook_key_hash FROM external_peer').get() as any;
  expect(row.webhook_key_hash === createHash('sha256').update(key).digest('hex')).toBe(true);
  const next = configureWebhook(db, 'shogun', 'visitor', 'https://example.test/new')!;
  expect(next === key).toBe(false);
  expect(readdirSync(join(dir, 'webhook-keys')).includes(files[0]!)).toBe(false);
  configureWebhook(db, 'shogun', 'visitor', null);
  expect(readdirSync(join(dir, 'webhook-keys'))).toEqual([]);
});

test('signed count-only notifications coalesce bursts for thirty seconds and redact ledger/status', async () => {
  const counts: number[] = [];
  const s = worker(async (_, init) => { counts.push(valid(init!).unread); expect(init!.redirect).toBe('manual'); return new Response(null); });
  mail('one'); mail('two'); mail('three'); await s.tick();
  expect(counts).toEqual([3]);
  now += 1000; mail('four'); await s.tick();
  now += 1000; mail('five'); await s.tick();
  expect(counts).toEqual([3]);
  now += 28000; await s.tick(); expect(counts).toEqual([3, 5]);
  await s.tick(); expect(counts).toHaveLength(2);
  const audit = JSON.stringify(db.query('SELECT * FROM ledger').all());
  for (const secret of [key, 'private-path', 'hidden', 'PRIVATE MESSAGE BODY']) expect(audit.includes(secret)).toBe(false);
  expect(audit).toContain('host=example.test'); expect(audit).toContain('webhook.coalesce');
  const status = JSON.stringify(peerStatus(db)); expect(status.includes(key)).toBe(false);
  expect(status).toContain('success'); expect(status).toContain('configured');
});

test('network and 5xx failures retry at 30/60/120s, give up after four attempts and await new growth', async () => {
  let calls = 0;
  const s = worker(async () => { if (++calls === 1) throw new Error('private network error'); return new Response(null, { status: 503 }); });
  mail('one'); await s.tick();
  for (const delay of [30000, 60000, 120000]) { now += delay - 1; await s.tick(); const before = calls; now++; await s.tick(); expect(calls).toBe(before + 1); }
  expect(calls).toBe(4); expect(state().last_result).toBe('gave_up');
  now += 600000; await s.tick(); expect(calls).toBe(4);
  mail('two'); await s.tick(); expect(calls).toBe(5);
  expect(JSON.stringify(db.query('SELECT * FROM ledger').all()).includes('private network error')).toBe(false);
});

test('4xx and redirects stop immediately; disable/revoke prevent sends', async () => {
  for (const status of [400, 302]) {
    configureWebhook(db, 'shogun', 'visitor', 'https://example.test');
    let calls = 0;
    const redirected: { url: string; signed: boolean }[] = [];
    const receiveRedirect = (url: string, init?: RequestInit) => {
      redirected.push({ url, signed: new Headers(init?.headers).has('X-Honden-Signature') });
      return new Response(null, { status: 204 });
    };
    const s = worker(async (_, init) => {
      calls++;
      const response = new Response(null, { status,
        headers: status === 302 ? { Location: 'https://redirect-target.example/notify' } : undefined });
      // Match fetch's default follow behavior, preserving custom signing headers at the next receiver.
      const location = response.headers.get('Location');
      return location && init?.redirect !== 'manual' ? receiveRedirect(location, init) : response;
    });
    mail('status-' + status); await s.tick(); now += 60000; await s.tick();
    expect(redirected).toEqual([]);
    expect(calls).toBe(1); s.stop();
  }
  let calls = 0; const s = worker(async () => { calls++; return new Response(null); });
  configureWebhook(db, 'shogun', 'visitor', null); mail('disabled'); await s.tick(); expect(calls).toBe(0);
  configureWebhook(db, 'shogun', 'visitor', 'https://example.test'); changeKey(db, 'shogun', 'visitor', true);
  await s.tick(); expect(calls).toBe(0);
});

test('slow requests do not block delivery; timeout retries and stop aborts in-flight work', async () => {
  let aborted = 0;
  const s = worker(async (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); })), 15);
  mail('one'); const pending = s.tick(); mail('two'); await s.tick();
  expect((db.query('SELECT count(*) n FROM inbox').get() as any).n).toBe(2);
  await pending; expect(aborted).toBe(1); expect(state().last_result).toBe('retry');
  now += 30000; const stopped = s.tick(); s.stop(); await stopped; expect(aborted).toBe(2);
});

test('restart preserves cooldown and detects mail arriving while sender stopped', async () => {
  let calls = 0; const fetcher = async () => { calls++; return new Response(null); };
  const s = worker(fetcher); mail('one'); await s.tick(); s.stop();
  mail('two'); db.close(); db = openStore({ path: join(dir, 'test.db') });
  const restarted = worker(fetcher); now += 1000; await restarted.tick(); expect(calls).toBe(1);
  now += 29000; await restarted.tick(); expect(calls).toBe(2);
  // Equal count after acknowledgement plus arrival must still notify.
  db.prepare("UPDATE inbox SET read = 1 WHERE id = 'two'").run(); mail('three'); now += 30000;
  await restarted.tick(); expect(calls).toBe(3);
});

test('mail observed during an in-flight send remains pending for the next window', async () => {
  let finish!: (r: Response) => void; let calls = 0;
  const s = worker(async () => { calls++; return calls === 1 ? new Promise<Response>(r => finish = r) : new Response(null); });
  mail('one'); const pending = s.tick(); mail('two'); await s.tick(); finish(new Response(null)); await pending;
  expect(state().pending).toBe(1); now += 30000; await s.tick(); expect(calls).toBe(2);
});

test('real disposable HTTP receiver verifies signature and serve lifecycle starts/stops sender', async () => {
  let accepted = 0, resolve!: () => void;
  const received = new Promise<void>(r => resolve = r);
  const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const raw = await req.text();
    try { valid({ headers: req.headers, body: raw }); accepted++; resolve(); return new Response(null); }
    catch { return new Response(null, { status: 400 }); }
  } });
  key = configureWebhook(db, 'shogun', 'visitor', `http://127.0.0.1:${receiver.port}/notify`)!;
  configureListener(db, 'shogun', '127.0.0.1', 0);
  mail('one'); const server = serveNetwork(db, { now: () => now });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('receiver timed out')), 3000); })]); expect(accepted).toBe(1); }
  finally { clearTimeout(timer); server.stop(true); receiver.stop(true); }
});

test('external peers never become pane nudge targets', () => {
  mail('one'); expect(plan(db, new Date(now), { panes: new Map([['visitor', { id: '%fake-peer', label: 'test:visitor' }]]) }).some(p => p.agent === 'visitor')).toBe(false);
});


test('unsafe key permissions and tampering fail closed without leaking diagnostics', async () => {
  const file = join(dir, 'webhook-keys', readdirSync(join(dir, 'webhook-keys'))[0]!);
  chmodSync(file, 0o644);
  let calls = 0; const s = worker(async () => { calls++; return new Response(null); });
  mail('one'); await s.tick(); expect(calls).toBe(0); expect(state().last_result).toBe('gave_up');
  chmodSync(file, 0o600); writeFileSync(file, 'invalid-private-test-value');
  now += 30000; mail('two'); await s.tick(); expect(calls).toBe(0);
  const audit = JSON.stringify(db.query('SELECT * FROM ledger').all());
  expect(audit.includes(key)).toBe(false); expect(audit.includes('invalid-private-test-value')).toBe(false);
});


test('rotating configuration during a request prevents the old response overwriting new state', async () => {
  let finish!: (r: Response) => void;
  const old = worker(async () => new Promise<Response>(r => finish = r));
  mail('one'); const pending = old.tick();
  key = configureWebhook(db, 'shogun', 'visitor', 'https://example.test/replaced')!;
  finish(new Response(null)); await pending; old.stop();
  expect(state()).toBeNull();
  let calls = 0; const next = worker(async (_, init) => { valid(init!); calls++; return new Response(null); });
  await next.tick(); expect(calls).toBe(1); expect(state().last_result).toBe('success');
});


test('restart after an interrupted fourth attempt preserves the retry limit', async () => {
  let calls = 0; const s = worker(async () => { calls++; return new Response(null, { status: 503 }); });
  mail('one'); await s.tick(); s.stop();
  db.prepare('UPDATE webhook_state SET attempts = 4, pending = 1, next_at = ?').run(now);
  const restarted = worker(async () => { calls++; return new Response(null); });
  await restarted.tick(); expect(calls).toBe(1); expect(state().last_result).toBe('gave_up');
  now += 30000; mail('two'); await restarted.tick(); expect(calls).toBe(2);
});
