import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { syncRoster } from '../src/roster';
import { issuePeer, changeKey } from '../src/external';
import { ackFor, deliver, recent } from '../src/inbox';
import { ingestInbox } from '../src/ingest';
import { networkHandler } from '../src/network';

let db: Database, key: string, handler: ReturnType<typeof networkHandler>;
const now = Date.parse('2026-01-01T00:00:00.000Z');
beforeEach(() => {
  db = openStore({ path: ':memory:' });
  syncRoster(db, [{ id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null }]);
  key = issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull', capabilities: ['inbox.read'], destinations: [] });
  handler = networkHandler(db, { now: () => now });
});
afterEach(() => db.close());
function request(path: string, data?: unknown, token: string | null = key) {
  return handler(new Request('http://localhost' + path, { method: data === undefined ? 'GET' : 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
}
function send(id: string, offset = 0, agent = 'visitor', at = new Date(now + offset).toISOString()) {
  deliver(db, { id, agent, at, sender: 'karo', type: 'message', body: 'body-' + id });
}
const snapshot = () => db.query('SELECT * FROM inbox_read_snapshot ORDER BY agent').all();
const messages = () => db.query('SELECT * FROM inbox ORDER BY id').all();

test('recent returns read and unread envelopes newest first, with stable acknowledgement time', async () => {
  send('old'); send('middle', 1000); send('new', 2000);
  const info = await (await request('/v1')).json();
  expect(info.features).toContain('inbox.recent');
  await request('/v1/inbox/read');
  const before = Date.now();
  expect((await request('/v1/inbox/ack', { ids: [`${info.instance}/old`] })).status).toBe(200);
  const response = await request('/v1/inbox/recent'); expect(response.status).toBe(200);
  const rows = (await response.json()).messages;
  expect(rows.map((m: any) => m.id)).toEqual(['new','middle','old'].map(id => `${info.instance}/${id}`));
  expect(rows.map((m: any) => m.read)).toEqual([false,false,true]);
  expect(rows[0].readAt).toBeNull(); expect(rows[1].readAt).toBeNull();
  expect(Date.parse(rows[2].readAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(rows[2].readAt)).toBeLessThanOrEqual(Date.now());
  expect(rows[0]).toEqual({ id: `${info.instance}/new`, origin: info.instance, sender: 'karo', recipient: 'visitor',
    type: 'message', body: 'body-new', at: new Date(now + 2000).toISOString(), read: false, readAt: null });
  await request('/v1/inbox/ack', { ids: [`${info.instance}/old`] });
  expect((await (await request('/v1/inbox/recent')).json()).messages[2].readAt).toBe(rows[2].readAt);
});

test('recent enforces default 20, maximum 100, and exclusive since before limiting', async () => {
  for (let i = 0; i < 105; i++) send('m' + i, i * 1000);
  expect((await (await request('/v1/inbox/recent')).json()).messages).toHaveLength(20);
  const hundred = (await (await request('/v1/inbox/recent?limit=100')).json()).messages;
  expect(hundred).toHaveLength(100); expect(hundred[99].body).toBe('body-m5');
  const since = encodeURIComponent(new Date(now + 100000).toISOString());
  const rows = (await (await request('/v1/inbox/recent?since=' + since)).json()).messages;
  expect(rows.map((m: any) => m.body)).toEqual(['body-m104','body-m103','body-m102','body-m101']);
  expect((await (await request('/v1/inbox/recent?limit=2&since=' + since)).json()).messages.map((m: any) => m.body))
    .toEqual(['body-m104','body-m103']);
  expect((await (await request('/v1/inbox/recent?since=2027-01-01T00%3A00%3A00Z')).json()).messages).toEqual([]);
});

test('recent sorts instants across timezone offsets and breaks equal-time ties by arrival', async () => {
  send('offset', 0, 'visitor', '2026-01-01T09:00:00+09:00');
  send('tie-one', 0, 'visitor', '2026-01-01T00:00:01Z');
  send('tie-two', 0, 'visitor', '2026-01-01T00:00:01.000Z');
  const rows = (await (await request('/v1/inbox/recent?since=2026-01-01T09%3A00%3A00%2B09%3A00')).json()).messages;
  expect(rows.map((m: any) => m.body)).toEqual(['body-tie-two','body-tie-one']);
});

test('recent scopes both read and unread to the authenticated recipient, ignoring other-recipient parameters', async () => {
  const otherKey = issuePeer(db, 'shogun', { name: 'other', kind: 'agent', direction: 'pull', capabilities: ['inbox.read'], destinations: [] });
  send('mine'); send('other-private', 1000, 'other'); send('shogun-private', 2000, 'shogun');
  db.prepare("UPDATE inbox SET read = 1 WHERE id = 'other-private'").run();
  const rows = (await (await request('/v1/inbox/recent?agent=shogun&recipient=other')).json()).messages;
  expect(rows.map((m: any) => m.body)).toEqual(['body-mine']);
  const others = (await (await request('/v1/inbox/recent', undefined, otherKey)).json()).messages;
  expect(others.map((m: any) => m.body)).toEqual(['body-other-private']);
  expect(others[0].read).toBe(true); expect(others[0].readAt).toBeNull();
});

test('recent changes neither inbox state nor snapshots and does not authorize ack without read', async () => {
  send('one'); const before = messages();
  const rows = (await (await request('/v1/inbox/recent')).json()).messages;
  expect(messages()).toEqual(before); expect(snapshot()).toEqual([]);
  expect((await request('/v1/inbox/ack', { ids: [rows[0].id] })).status).toBe(403);
  expect((await request('/v1/inbox/ack', { all: true })).status).toBe(409);
  expect(messages()).toEqual(before); expect(snapshot()).toEqual([]);
  const ledger = db.query("SELECT actor,target,detail FROM ledger WHERE detail = 'GET /v1/inbox/recent status=200'").all();
  expect(ledger).toEqual([{ actor: 'visitor', target: 'visitor', detail: 'GET /v1/inbox/recent status=200' }]);
});

test('recent preserves an existing read snapshot and ack-all still refuses arrivals after that read', async () => {
  send('old'); const shown = (await (await request('/v1/inbox/read')).json()).messages;
  const saved = snapshot(); send('new', 1000); const before = messages();
  const rows = (await (await request('/v1/inbox/recent?limit=1')).json()).messages;
  expect(rows[0].body).toBe('body-new'); expect(snapshot()).toEqual(saved); expect(messages()).toEqual(before);
  expect((await request('/v1/inbox/ack', { all: true })).status).toBe(409);
  expect((await request('/v1/inbox/ack', { ids: [rows[0].id] })).status).toBe(403);
  expect((await request('/v1/inbox/ack', { ids: [shown[0].id] })).status).toBe(200);
  expect((await (await request('/v1/inbox/unread')).json()).unread).toBe(1);
});

test('recent does not replace the bounded read page used by a successful ack-all', async () => {
  for (let i = 0; i < 105; i++) send('page' + i, i * 1000);
  await request('/v1/inbox/read'); const saved = snapshot();
  await request('/v1/inbox/recent'); expect(snapshot()).toEqual(saved);
  expect((await request('/v1/inbox/ack', { all: true })).status).toBe(200);
  expect((await (await request('/v1/inbox/unread')).json()).unread).toBe(5);
  const rows = (await (await request('/v1/inbox/recent?limit=100')).json()).messages;
  expect(rows.filter((m: any) => m.read).every((m: any) => Number.isFinite(Date.parse(m.readAt)))).toBe(true);
});

test('recent requires authentication and inbox.read, including discovery and revocation', async () => {
  const writer = issuePeer(db, 'shogun', { name: 'writer', kind: 'agent', direction: 'pull', capabilities: ['inbox.write'], destinations: [] });
  expect((await request('/v1/inbox/recent', undefined, null)).status).toBe(401);
  expect((await request('/v1/inbox/recent', undefined, 'invalid-test-token')).status).toBe(401);
  expect((await request('/v1/inbox/recent', undefined, writer)).status).toBe(403);
  expect((await (await request('/v1', undefined, writer)).json()).features).toEqual([]);
  changeKey(db, 'shogun', 'visitor', true);
  expect((await request('/v1/inbox/recent')).status).toBe(401);
});

test('recent rejects invalid limits and timestamps without changing inbox or snapshots', async () => {
  send('one'); const before = messages();
  for (const query of ['limit=0','limit=-1','limit=101','limit=1.5','limit=1e2','limit=','limit=x','limit=1&limit=2',
    'since=bad','since=','since=2026-01-01','since=2026-13-01T00:00:00Z','since=2026-01-01T00:00:00Z&since=2027-01-01T00:00:00Z'])
    expect((await request('/v1/inbox/recent?' + query)).status).toBe(400);
  expect(messages()).toEqual(before); expect(snapshot()).toEqual([]);
});

test('legacy database migration preserves read flags and reports unknown historical read times as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'honden-recent-migration-')); const path = join(dir, 'db');
  let migrated: Database | undefined;
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE inbox (id TEXT PRIMARY KEY, agent TEXT NOT NULL, created_at TEXT NOT NULL, msg_type TEXT NOT NULL,
      sender TEXT NOT NULL, body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'native');
      INSERT INTO inbox VALUES ('old','karo','2026-01-01T00:00:00Z','message','shogun','old body',1,'native');`);
    old.close(); migrated = openStore({ path });
    expect(recent(migrated, 'karo').map(m => ({ read: m.read, readAt: m.readAt }))).toEqual([{ read: true, readAt: null }]);
  } finally { migrated?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('forced ack records time; reimport preserves it only while the imported read state stays the same', () => {
  const imported = (read: boolean) => ({ messages: [{ id: 'imported', timestamp: '2026-01-01T00:00:00Z', type: 'message', from: 'karo', body: 'import', read }] });
  ingestInbox(db, '/tmp/visitor.yaml', imported(false));
  expect(ackFor(db, { agent: 'visitor', by: 'shogun', reason: '相手の停止中に残った報せを試験として片付ける' }).ok).toBe(true);
  const at = recent(db, 'visitor')[0]!.readAt; expect(Number.isFinite(Date.parse(at!))).toBe(true);
  ingestInbox(db, '/tmp/visitor.yaml', imported(true)); expect(recent(db, 'visitor')[0]!.readAt).toBe(at);
  ingestInbox(db, '/tmp/visitor.yaml', imported(false)); expect(recent(db, 'visitor')[0]!.readAt).toBeNull();
});
