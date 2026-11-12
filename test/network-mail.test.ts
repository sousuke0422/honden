import { beforeEach, afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store';
import { syncRoster } from '../src/roster';
import { issuePeer, instanceId } from '../src/external';
import { ack, deliver, readOwnUnread } from '../src/inbox';
import { inboxWrite } from '../src/cli';
import { networkHandler } from '../src/network';
import { PREVIEW_CHARS, THREAD_DEPTH, THREAD_NODES } from '../src/mail';
let db: Database, dir: string, path: string, key: string, local: string, now: number, handler: ReturnType<typeof networkHandler>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honden-mail-')); path = join(dir, 'db'); db = openStore({ path });
  syncRoster(db, ['shogun','karo','gunshi'].map(id => ({ id, role: 'commander' as const, cli: null, model: null })));
  key = issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull', capabilities: ['inbox.read','inbox.write'], destinations: ['karo','gunshi'] });
  now = Date.now(); handler = networkHandler(db, { now: () => now }); local = instanceId(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const wire = (id: string) => local + '/' + id;
const url = (kind: string, id: string) => '/v1/inbox/' + kind + '/' + encodeURIComponent(id);
function request(route: string, data?: unknown, token: string | null = key) {
  return handler(new Request('http://localhost' + route, { method: data === undefined ? 'GET' : 'POST',
    headers: token === null ? {} : { authorization: 'Bearer ' + token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
}
function envelope(id: string, recipient = 'karo', inReplyTo?: string, offset = 0, body = 'first line\nSECOND PRIVATE LINE') {
  return { id: 'visitor/' + id, origin: 'visitor', sender: 'visitor', recipient, type: 'message', body,
    at: new Date(now + offset).toISOString(), ...(inReplyTo === undefined ? {} : { inReplyTo }) };
}
async function post(id: string, recipient = 'karo', parent?: string, offset = 0, body?: string) {
  const e = envelope(id, recipient, parent, offset, body); expect((await request('/v1/inbox/write', e)).status).toBe(200); return wire('external:' + e.id);
}
function native(id: string, agent = 'visitor', sender = 'karo', parent?: string, body = 'native reply', writtenBy?: string, offset = 0) {
  db.transaction(() => deliver(db, { id, agent, sender, type: 'cmd_update', body, at: new Date(now + offset).toISOString(), inReplyTo: parent, writtenBy })).immediate();
  return wire(id);
}
const snapshot = () => db.query('SELECT * FROM inbox_read_snapshot ORDER BY agent').all();
const rows = () => db.query('SELECT * FROM inbox ORDER BY id').all();

test('network reply links accept received and authenticated sent IDs, retaining plain-write idempotency', async () => {
  const incoming = native('incoming');
  const plain = envelope('plain');
  expect((await request('/v1/inbox/write', plain)).status).toBe(200);
  expect(JSON.parse((db.query('SELECT payload FROM network_envelope WHERE id = ?').get(plain.id) as any).payload)).toEqual(plain);
  expect((db.query('SELECT in_reply_to FROM inbox WHERE id = ?').get('external:' + plain.id) as any).in_reply_to).toBeNull();
  expect((await (await request('/v1/inbox/write', plain)).json()).duplicate).toBe(true);
  await post('reply', 'karo', incoming);
  expect((db.query("SELECT in_reply_to FROM inbox WHERE id = 'external:visitor/reply'").get() as any).in_reply_to).toBe('incoming');
  await post('follow', 'gunshi', 'visitor/reply');
  expect((db.query("SELECT in_reply_to FROM inbox WHERE id = 'external:visitor/follow'").get() as any).in_reply_to).toBe('external:visitor/reply');
  const changed = { ...plain, inReplyTo: 'visitor/reply' };
  expect((await request('/v1/inbox/write', changed)).status).toBe(409);
});

test('reply validation uniformly refuses missing, foreign, claimed-sender and self references', async () => {
  native('foreign', 'gunshi', 'visitor');
  const before = rows();
  const a = await request('/v1/inbox/write', envelope('a','karo',wire('foreign')));
  const b = await request('/v1/inbox/write', envelope('b','karo',wire('missing')));
  const self = await request('/v1/inbox/write', envelope('self','karo','visitor/self'));
  expect(a.status).toBe(403); expect(b.status).toBe(403); expect(self.status).toBe(403);
  expect(await a.text()).toBe(await b.text()); expect(rows()).toEqual(before);
});

test('native CLI records authenticated writer and links received and newly sent mail without trusting a sender label', async () => {
  await post('question');
  const write = (body: string, ref?: string, dry = false) => inboxWrite(path, { flags: { to: 'visitor', from: 'karo', type: 'cmd_update', body,
    ...(ref === undefined ? {} : { 'reply-to': ref }) }, stdin: '' }, dry, { insideFormation: true, selfId: 'karo' });
  expect(write('answer','external:visitor/question').code).toBe(0);
  const answer = db.query("SELECT * FROM inbox WHERE body = 'answer'").get() as any;
  expect(answer.written_by).toBe('karo'); expect(answer.in_reply_to).toBe('external:visitor/question');
  expect(write('followup',answer.id).code).toBe(0);
  native('spoofed-native', 'gunshi', 'karo');
  const hidden = write('denied','spoofed-native'), missing = write('denied','missing');
  expect(hidden.code).toBe(2); expect(hidden.err).toBe(missing.err);
  const before = rows(); expect(write('dry','external:visitor/question',true).code).toBe(0); expect(rows()).toEqual(before);
});

test('sent uses receipt peer provenance, returns originals newest first and recipient read state', async () => {
  const old = await post('old','karo',undefined,-2000), fresh = await post('new','gunshi',undefined,-1000);
  readOwnUnread(db,'karo'); expect(ack(db,'karo',['external:visitor/old']).ok).toBe(true);
  native('forged','karo','visitor',undefined,'FAKE SENDER PRIVATE', 'visitor');
  const evil = issuePeer(db,'shogun',{ name:'evil',kind:'agent',direction:'pull',capabilities:['inbox.write'],destinations:['karo'] });
  const other = { ...envelope('other'), id:'evil/other',origin:'evil',sender:'evil',body:'OTHER PEER PRIVATE' };
  expect((await request('/v1/inbox/write',{...other,sender:'visitor'},evil)).status).toBe(403);
  expect((await request('/v1/inbox/write',other,evil)).status).toBe(200);
  // Historical/corrupt claimed names still cannot replace the authenticated receipt owner.
  db.prepare("UPDATE inbox SET sender = 'visitor' WHERE id = 'external:evil/other'").run();
  const payload = { ...other,sender:'visitor' }; db.prepare('UPDATE network_envelope SET payload = ? WHERE id = ?').run(JSON.stringify(payload),other.id);
  const sent = (await (await request('/v1/inbox/sent')).json()).messages;
  expect(sent.map((m:any)=>m.id)).toEqual([fresh,old]); expect(sent.map((m:any)=>m.direction)).toEqual(['sent','sent']);
  expect(sent[1].read).toBe(true); expect(Number.isFinite(Date.parse(sent[1].readAt))).toBe(true);
  expect(sent[0].recipient).toBe('gunshi'); expect(sent[0].type).toBe('message'); expect(sent[0].preview).toBe('first line');
  for (const id of [wire('forged'),wire('external:evil/other')]) {
    expect((await request(url('messages',id))).status).toBe(404); expect((await request(url('thread',id))).status).toBe(404);
  }
  const all = JSON.stringify((await (await request('/v1/inbox/messages')).json()));
  expect(all.includes('PRIVATE')).toBe(false);
});

test('lists omit body, bound the first line by Unicode characters, and full detail is separately authorized', async () => {
  const text = '😀'.repeat(PREVIEW_CHARS + 5) + '\nHIDDEN SECOND LINE';
  const id = await post('long','karo',undefined,0,text);
  for (const route of ['/v1/inbox/sent','/v1/inbox/messages',url('thread',id)]) {
    const data = await (await request(route)).json(); const item = data.messages[0];
    expect('body' in item).toBe(false); expect([...item.preview]).toHaveLength(PREVIEW_CHARS);
    expect(JSON.stringify(data).includes('HIDDEN SECOND')).toBe(false);
  }
  const full = await (await request(url('messages',id))).json(); expect(full.body).toBe(text); expect(full.id).toBe(id); expect(full.origin).toBe(local);
  native('hidden','gunshi','karo');
  const a = await request(url('messages',wire('hidden'))), b = await request(url('messages',wire('absent')));
  expect(a.status).toBe(404); expect(b.status).toBe(404); expect(await a.text()).toBe(await b.text());
});

test('sent filters with and exclusive since before limiting; defaults to 20 and caps at 100', async () => {
  for (let i=0;i<25;i++) await post('p'+i,i%2?'gunshi':'karo',undefined,i*1000);
  expect((await (await request('/v1/inbox/sent')).json()).messages).toHaveLength(20);
  const since=encodeURIComponent(new Date(now+20000).toISOString());
  const sinceRows=(await (await request('/v1/inbox/sent?with=karo&since='+since)).json()).messages;
  expect(sinceRows.map((m:any)=>m.id)).toEqual([wire('external:visitor/p24'),wire('external:visitor/p22')]);
  const data=(await (await request('/v1/inbox/sent?with=karo&since='+since+'&limit=1')).json()).messages;
  expect(data.map((m:any)=>m.id)).toEqual([wire('external:visitor/p24')]);
  expect((await (await request('/v1/inbox/sent?with=unknown')).json()).messages).toEqual([]);
  native('reply-karo','visitor','karo'); native('reply-gunshi','visitor','gunshi');
  const conversation=(await (await request('/v1/inbox/messages?with=karo&limit=100')).json()).messages;
  expect(conversation.every((m:any)=>m.direction==='sent' ? m.recipient==='karo' : m.sender==='karo')).toBe(true);
  expect((await (await request('/v1/inbox/messages?with=visitor')).json()).messages).toEqual([]);
  for(const suffix of ['?limit=0','?limit=101','?limit=1.5','?since=bad','?with=','?with=karo&with=gunshi'])
    expect((await request('/v1/inbox/sent'+suffix)).status).toBe(400);
});

test('thread climbs to root, orders oldest first, omits invisible branches and redacts invisible parent IDs', async () => {
  const root=await post('root','karo',undefined,-60000);
  native('private-bridge','gunshi','karo','external:visitor/root','PRIVATE BRIDGE CONTENT','karo',-30000);
  const answer=native('answer','visitor','karo','private-bridge','visible answer','karo',0);
  await post('followup','karo',answer,60000);
  native('private-sibling','gunshi','shogun','external:visitor/root','PRIVATE SIBLING CONTENT',undefined,0);
  const data=await (await request(url('thread',answer))).json();
  expect(data.messages.map((m:any)=>m.id)).toEqual([root,answer,wire('external:visitor/followup')]);
  expect(data.messages.map((m:any)=>m.direction)).toEqual(['sent','received','sent']);
  expect(data.messages[1].inReplyTo).toBeNull(); expect(data.messages[2].inReplyTo).toBe(answer);
  expect(JSON.stringify(data).includes('PRIVATE')).toBe(false); expect(JSON.stringify(data).includes('private-bridge')).toBe(false);
  const limited=await (await request(url('thread',answer)+'?limit=1')).json(); expect(limited.messages[0].id).toBe(root); expect(limited.truncated).toBe(true);
});

test('thread detects self and ancestor cycles distinctly from depth overflow and always terminates', async () => {
  const id=native('self'); db.prepare("UPDATE inbox SET in_reply_to = id WHERE id = 'self'").run();
  expect((await request(url('thread',id))).status).toBe(409);
  native('a','visitor','karo','b'); native('b','visitor','karo','a');
  expect((await request(url('thread',wire('a')))).status).toBe(409);
  db.transaction(()=>{for(let i=0;i<=THREAD_DEPTH;i++)deliver(db,{id:'deep'+i,agent:'visitor',sender:'karo',type:'message',body:'depth',at:new Date(now).toISOString(),inReplyTo:i?'deep'+(i-1):undefined});}).immediate();
  expect((await request(url('thread',wire('deep'+THREAD_DEPTH)))).status).toBe(413);
});

test('thread bounds breadth and response size without exposing bodies', async () => {
  const root=native('wide');
  db.transaction(()=>{for(let i=0;i<THREAD_NODES+5;i++)deliver(db,{id:'child'+i,agent:'visitor',sender:'karo',type:'message',body:'child',at:new Date(now+1000).toISOString(),inReplyTo:'wide'});}).immediate();
  const data=await (await request(url('thread',root)+'?limit=100')).json(); expect(data.messages).toHaveLength(100); expect(data.truncated).toBe(true);
  expect(data.messages.every((m:any)=>!('body' in m))).toBe(true);
});

test('all mail reads preserve inbox flags and read snapshots, including the ack-all arrival boundary', async () => {
  const outgoing=await post('q'); const incoming=native('known','visitor','karo','external:visitor/q');
  await request('/v1/inbox/read'); const saved=snapshot(); native('new'); const before=rows();
  for(const route of ['/v1/inbox/messages','/v1/inbox/sent',url('messages',outgoing),url('messages',incoming),url('thread',incoming)])expect((await request(route)).status).toBe(200);
  expect(rows()).toEqual(before); expect(snapshot()).toEqual(saved);
  expect((await request('/v1/inbox/ack',{all:true})).status).toBe(409);
  const audit=JSON.stringify(db.query("SELECT detail FROM ledger WHERE action='network.request'").all());
  expect(audit.includes('first line')).toBe(false); expect(audit.includes('SECOND PRIVATE LINE')).toBe(false); expect(audit.includes(key)).toBe(false);
  expect(audit).toContain('GET /v1/inbox/messages/:id status=200');
});

test('mail reads need inbox.read, replies need inbox.write, and discovery advertises only permitted features', async () => {
  native('one');
  const writer=issuePeer(db,'shogun',{name:'writer',kind:'agent',direction:'pull',capabilities:['inbox.write'],destinations:['karo']});
  for(const route of ['/v1/inbox/messages','/v1/inbox/sent',url('messages',wire('one')),url('thread',wire('one'))]) {
    expect((await request(route,undefined,null)).status).toBe(401); expect((await request(route,undefined,writer)).status).toBe(403);
  }
  const info=await (await request('/v1')).json(); expect(info.features).toEqual(expect.arrayContaining(['inbox.messages','inbox.sent','inbox.thread','inbox.inReplyTo']));
  expect((await (await request('/v1',undefined,writer)).json()).features).toEqual(['inbox.inReplyTo']);
  const reader=issuePeer(db,'shogun',{name:'reader',kind:'agent',direction:'pull',capabilities:['inbox.read'],destinations:[]});
  expect((await request('/v1/inbox/write',{...envelope('x'),id:'reader/x',origin:'reader',sender:'reader',inReplyTo:wire('one')},reader)).status).toBe(403);
});
