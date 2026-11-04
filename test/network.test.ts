import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openStore, tx } from '../src/store';
import { roster, syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { deliver } from '../src/inbox';
import { plan } from '../src/nudge';
import { address, authenticate, changeKey, configureListener, issuePeer, listenerAddress, peerStatus } from '../src/external';
import { BODY_LIMIT, networkHandler, serveNetwork, type Envelope } from '../src/network';

let db: Database;
let key: string;
let handle: ReturnType<typeof networkHandler>;
let now: number;
beforeEach(() => {
  now = Date.parse('2026-01-01T00:00:00.000Z');
  db = openStore({ path: ':memory:' });
  syncRoster(db, [
    { id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null },
    { id: 'gunshi', role: 'commander', cli: null, model: null },
    { id: 'ashigaru1', role: 'worker', cli: null, model: null },
  ]);
  key = issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull',
    capabilities: ['inbox.read', 'inbox.write', 'report.submit'], destinations: ['gunshi','karo'] });
  handle = networkHandler(db, { now: () => now });
});
afterEach(() => db.close());
const request = (path: string, data?: unknown, token: string | null = key, method?: string) => handle(new Request(`http://localhost${path}`, {
  method: method ?? (data === undefined ? 'GET' : 'POST'),
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
}));
function send(agent: string, id: string) {
  tx(db, () => deliver(db, { id, agent, at: new Date().toISOString(), sender: 'karo', type: 'message', body: `for ${agent}` }));
}
function envelope(id = 'visitor/one', recipient = 'gunshi'): Envelope {
  return { id, origin: 'visitor', sender: 'visitor', recipient, type: 'message', body: 'hello', at: new Date(now).toISOString() };
}

test('keys require shogun, are hashed, rotate once and revoke immediately', async () => {
  expect(() => issuePeer(db, 'karo', { name: 'bad', kind: 'agent', direction: 'pull', capabilities: [], destinations: [] })).toThrow();
  expect(() => changeKey(db, 'ashigaru1', 'visitor', false)).toThrow();
  const hash = (db.query('SELECT key_hash FROM external_peer').get() as { key_hash: string }).key_hash;
  expect(hash).not.toBe(key);
  expect(hash).toHaveLength(64);
  expect(JSON.stringify(peerStatus(db))).not.toContain(key);
  expect(JSON.stringify(db.query('SELECT * FROM ledger').all())).not.toContain(key);
  const old = key;
  key = changeKey(db, 'shogun', 'visitor', false)!;
  expect((await request('/v1', undefined, old)).status).toBe(401);
  expect((await request('/v1')).status).toBe(200);
  changeKey(db, 'shogun', 'visitor', true);
  expect((await request('/v1')).status).toBe(401);
});

test('missing and invalid credentials fail; version and permissions are discoverable', async () => {
  expect((await request('/v1', undefined, null)).status).toBe(401);
  expect((await request('/v1', undefined, 'invalid-test-only')).status).toBe(401);
  const info = await (await request('/v1')).json();
  expect(info.version).toBe(1);
  expect(info.capabilities).toContain('report.submit');
  expect(info.destinations).toContain('gunshi');
  expect(info.pollSeconds).toBe(5);
  expect((await request('/v1/command/new', {})).status).toBe(403);
  expect((await request('/v1/guard/issue', {})).status).toBe(403);
  expect((await request('/v1/roster', {})).status).toBe(403);
  expect((await request('/v2')).status).toBe(403);
});

test('capabilities and destinations are independent allowlists', async () => {
  const restricted = issuePeer(db, 'shogun', { name: 'reader', kind: 'agent', direction: 'pull', capabilities: ['inbox.read'], destinations: ['gunshi'] });
  expect((await request('/v1/inbox/write', envelope(), restricted)).status).toBe(403);
  expect((await request('/v1/report/submit', envelope(), restricted)).status).toBe(403);
  expect((await request('/v1/inbox/write', envelope('visitor/forbidden', 'shogun'))).status).toBe(403);
  expect(db.query("SELECT 1 FROM inbox WHERE agent = 'shogun'").get()).toBeNull();
  expect((await request('/v1/inbox/write', envelope())).status).toBe(200);
});

test('only own messages are exposed and only read IDs may be acknowledged', async () => {
  send('visitor', 'mine');
  send('shogun', 'secret');
  const info = await (await request('/v1')).json();
  expect((await request('/v1/inbox/ack', { ids: [`${info.instance}/mine`] })).status).toBe(403);
  expect((await (await request('/v1/inbox/unread')).json()).unread).toBe(1);
  const read = await (await request('/v1/inbox/read?agent=shogun')).json();
  expect(read.messages).toHaveLength(1);
  expect(read.messages[0].recipient).toBe('visitor');
  expect(read.messages[0].body).toBe('for visitor');
  expect(read.messages[0].id).toBe(`${info.instance}/mine`);
  expect((await request('/v1/inbox/ack', { ids: [`${info.instance}/secret`] })).status).toBe(403);
  send('visitor', 'unseen');
  expect((await request('/v1/inbox/ack', { ids: [`${info.instance}/unseen`] })).status).toBe(403);
  expect((await request('/v1/inbox/ack', { all: true })).status).toBe(409);
  expect((await request('/v1/inbox/ack', { ids: [read.messages[0].id] })).status).toBe(200);
  expect((db.query("SELECT read FROM inbox WHERE id = 'secret'").get() as { read: number }).read).toBe(0);
  expect((await (await request('/v1/inbox/unread')).json()).unread).toBe(1);
});

test('ack-all retains unread messages beyond the bounded read page', async () => {
  for (let i = 0; i < 103; i++) send('visitor', `page${i}`);
  expect((await (await request('/v1/inbox/read')).json()).messages).toHaveLength(100);
  expect((await request('/v1/inbox/ack', { all: true })).status).toBe(200);
  expect((await (await request('/v1/inbox/unread')).json()).unread).toBe(3);
});

test('inbound envelopes preserve provenance, deduplicate, and never become internal commands', async () => {
  const e = { ...envelope(), type: 'cmd_new' };
  expect((await request('/v1/inbox/write', e)).status).toBe(200);
  expect((await (await request('/v1/inbox/write', e)).json()).duplicate).toBe(true);
  expect((await request('/v1/inbox/write', { ...e, body: 'changed' })).status).toBe(409);
  const rows = db.query("SELECT msg_type,body FROM inbox WHERE agent = 'gunshi'").all() as { msg_type: string; body: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.msg_type).toBe('external_notice');
  expect(rows[0]!.body).toContain('[external:visitor');
  expect((await request('/v1/inbox/write', { ...envelope('other/stolen'), origin: 'other' })).status).toBe(403);
  expect((await request('/v1/inbox/write', { ...envelope('visitor/spoof'), sender: 'shogun' })).status).toBe(403);
});

for (const [offset, expected] of [[-301000, 400], [-300001, 400], [-300000, 200], [0, 200], [300000, 200], [300001, 400], [301000, 400]] as const) {
  test(`envelope clock window: ${offset}ms returns ${expected} and records the result`, async () => {
    const e = { ...envelope(), at: new Date(now + offset).toISOString() };
    const response = await request('/v1/inbox/write', e);
    expect(response.status).toBe(expected);
    if (expected === 400) {
      expect(await response.json()).toEqual({ error: 'timestamp must be within 5 minutes of receipt' });
      expect(db.query('SELECT count(*) n FROM network_envelope').get()).toEqual({ n: 0 });
      expect(db.query('SELECT count(*) n FROM inbox').get()).toEqual({ n: 0 });
    }
    expect(db.query("SELECT actor,detail FROM ledger WHERE action = 'network.request' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ actor: 'visitor', detail: `POST /v1/inbox/write status=${expected}` });
  });
}

test('envelope clock rejects malformed timestamps and stale report envelopes', async () => {
  for (const at of ['', 'not-a-date', '2026-99-99T00:00:00Z']) {
    expect((await request('/v1/inbox/write', { ...envelope(), at })).status).toBe(400);
  }
  const report = { ...envelope(), type: 'report.submit', at: new Date(now - 301000).toISOString(),
    body: JSON.stringify({ task_id: 'unassigned', status: 'done', summary: '照合した' }) };
  expect((await request('/v1/report/submit', report)).status).toBe(400);
  expect(db.query('SELECT count(*) n FROM report').get()).toEqual({ n: 0 });
});

test('envelope clock validation precedes duplicate checking without redelivering stale retries', async () => {
  const e = envelope();
  expect((await request('/v1/inbox/write', e)).status).toBe(200);
  expect((await (await request('/v1/inbox/write', e)).json()).duplicate).toBe(true);
  now += 301000;
  expect((await request('/v1/inbox/write', e)).status).toBe(400);
  expect(db.query('SELECT count(*) n FROM inbox').get()).toEqual({ n: 1 });
  expect(db.query('SELECT count(*) n FROM network_envelope').get()).toEqual({ n: 1 });
  expect(db.query("SELECT detail FROM ledger WHERE action = 'network.request' ORDER BY id DESC LIMIT 1").get())
    .toEqual({ detail: 'POST /v1/inbox/write status=400' });
});

test('honden addresses are parsed without enabling an outbound sender or delegated reads', async () => {
  expect(address('karo@other')).toEqual({ name: 'karo', peer: 'other' });
  expect(address('gunshi')).toEqual({ name: 'gunshi', peer: null });
  for (const invalid of ['a@@b','a@','@b','a@b@c','../bad']) expect(() => address(invalid)).toThrow();
  const remote = issuePeer(db, 'shogun', { name: 'other', kind: 'honden', direction: 'pull', capabilities: ['inbox.write','inbox.read'], destinations: ['gunshi'] });
  const e = { ...envelope('other/one'), origin: 'other', sender: 'karo@other' };
  expect((await request('/v1/inbox/write', e, remote)).status).toBe(200);
  expect((await request('/v1/inbox/write', { ...e, id: 'other/two', sender: 'karo' }, remote)).status).toBe(403);
  expect((await request('/v1/inbox/read', undefined, remote)).status).toBe(403);
  expect((await request('/v1/inbox/write', envelope('visitor/forward','karo@other'))).status).toBe(403);
});

test('external assignment uses the same held-task report validation and gunshi routing', async () => {
  const cmd = createCmd(db, 'shogun', { north_star: '査読を検める', purpose: '外の報告を確かめる', command: '資料を調べよ', acceptance_criteria: ['出典を報告する'], project: 'test' });
  expect(cmd.ok).toBe(true);
  const task = assignTask(db, 'karo', { agent: 'visitor', cmd_id: cmd.id!, title: '資料を調べよ' });
  expect(task.ok).toBe(true);
  expect(roster(db).some((p) => p.id === 'visitor')).toBe(false);
  expect(plan(db, new Date(), { panes: new Map() }).some((p) => p.agent === 'visitor')).toBe(false);
  const report = { task_id: task.id!, status: 'done', summary: '資料の照合を終えた', acceptance: { 1: '一次資料の本文を取得して照合した' } };
  const e = { ...envelope('visitor/report'), type: 'report.submit', body: JSON.stringify(report) };
  expect((await request('/v1/report/submit', { ...e, body: JSON.stringify({ ...report, task_id: 'someone-else' }) })).status).toBe(403);
  expect((await request('/v1/report/submit', { ...e, recipient: 'shogun' })).status).toBe(403);
  expect((await request('/v1/report/submit', e)).status).toBe(200);
  expect((await (await request('/v1/report/submit', e)).json()).duplicate).toBe(true);
  expect(db.query("SELECT sender FROM inbox WHERE agent = 'gunshi' AND msg_type = 'report_received'").get()).toEqual({ sender: 'visitor' });
  expect((db.query("SELECT body FROM inbox WHERE agent = 'gunshi' AND msg_type = 'report_received'").get() as { body: string }).body).toStartWith('[external:visitor]');
  expect(db.query('SELECT count(*) n FROM report').get()).toEqual({ n: 1 });
  expect(db.query("SELECT 1 FROM inbox WHERE agent = 'shogun'").get()).toBeNull();
});

test('listener defaults closed and rejects wildcard IP representations', () => {
  expect(() => serveNetwork(db)).toThrow('disabled');
  for (const host of ['0.0.0.0','::','0:0:0:0:0:0:0:0','::ffff:0.0.0.0','localhost',''])
    expect(() => configureListener(db, 'shogun', host)).toThrow();
  expect(() => configureListener(db, 'karo', '127.0.0.1')).toThrow();
  expect(listenerAddress('127.0.0.1', 0)).toEqual({ host: '127.0.0.1', port: 0 });
  expect(() => listenerAddress('127.0.0.1', -1)).toThrow();
});

test('real HTTP listener can be explicitly enabled, polled and disabled', async () => {
  configureListener(db, 'shogun', '127.0.0.1', 0);
  const server = serveNetwork(db, { now: () => now });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/inbox/unread`, { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unread: 0 });
  } finally { server.stop(true); }
  configureListener(db, 'shogun', null);
  expect(() => serveNetwork(db)).toThrow('disabled');
});

test('real HTTP client reads assignment, acknowledges, writes notice and submits its report', async () => {
  const cmd = createCmd(db, 'shogun', { north_star: '資料を調べる', purpose: '網越しの報告を検める', command: '資料を調べよ', acceptance_criteria: ['資料を照合する'], project: 'test' });
  const assigned = assignTask(db, 'karo', { agent: 'visitor', cmd_id: cmd.id!, title: '資料を調べよ' });
  expect(assigned.ok).toBe(true);
  configureListener(db, 'shogun', '127.0.0.1', 0);
  const server = serveNetwork(db, { now: () => now });
  try {
    const call = (path: string, data?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
      method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const read = await (await call('/inbox/read')).json();
    expect(read.messages[0].type).toBe('task_assigned');
    expect((await call('/inbox/ack', { ids: [read.messages[0].id] })).status).toBe(200);
    expect((await call('/inbox/write', envelope('visitor/http-message'))).status).toBe(200);
    expect((await call('/inbox/write', { ...envelope('visitor/http-large'), body: 'x'.repeat(BODY_LIMIT) })).status).toBe(413);
    const e = { ...envelope('visitor/http-report'), type: 'report.submit', body: JSON.stringify({ task_id: assigned.id, status: 'done', summary: '照合を完了した', acceptance: { 1: '取得した一次資料の内容を照合した' } }) };
    expect((await call('/report/submit', e)).status).toBe(200);
    expect((await (await call('/inbox/unread')).json()).unread).toBe(0);
    expect(db.query("SELECT count(*) n FROM inbox WHERE agent = 'gunshi'").get()).toEqual({ n: 2 });
  } finally { server.stop(true); }
});

test('oversized bodies, including streaming bodies without Content-Length, fail and are audited', async () => {
  expect((await request('/v1/inbox/write', { ...envelope(), body: 'x'.repeat(BODY_LIMIT) })).status).toBe(413);
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(BODY_LIMIT + 1)); c.close(); } });
  const response = await handle(new Request('http://localhost/v1/inbox/write', { method: 'POST', body: stream, headers: { authorization: `Bearer ${key}` } }));
  expect(response.status).toBe(413);
  expect(db.query('SELECT count(*) n FROM network_envelope').get()).toEqual({ n: 0 });
  const logs = JSON.stringify(db.query("SELECT actor,detail FROM ledger WHERE action = 'network.request'").all());
  expect(logs).toContain('status=413');
  expect(logs).not.toContain(key);
});

test('each incoming and outgoing operation, including authentication failure, reaches the ledger', async () => {
  await request('/v1', undefined, null);
  await request('/v1/inbox/read');
  await request('/v1/inbox/write', envelope());
  const log = db.query("SELECT actor,target,detail FROM ledger WHERE action = 'network.request' ORDER BY id").all() as { actor: string; target: string; detail: string }[];
  expect(log).toHaveLength(3);
  expect(log[0]!.actor).toBe('unauthenticated');
  expect(log[0]!.detail).toContain('status=401');
  expect(log[1]!.target).toBe('visitor');
  expect(log[2]!.target).toBe('gunshi');
  expect(peerStatus(db)[0]!.last).toBeTruthy();
  expect(authenticate(db, `Bearer ${key}`).name).toBe('visitor');
});
