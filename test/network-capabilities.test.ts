import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { ack, ackAll, deliver, list, readOwnUnread, recordReadSnapshot } from '../src/inbox';
import { changeKey, issuePeer, type Capability, NetworkError } from '../src/external';
import { submitReport } from '../src/report';

let db: Database;
beforeEach(() => {
  db = openStore({ path: ':memory:' });
  syncRoster(db, [
    { id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null },
    { id: 'gunshi', role: 'commander', cli: null, model: null },
    { id: 'ashigaru1', role: 'worker', cli: null, model: null },
  ]);
});
afterEach(() => db.close());
function peer(name: string, capabilities: Capability[]) {
  issuePeer(db, 'shogun', { name, kind: 'agent', direction: 'pull', capabilities, destinations: ['gunshi'] });
}
function send(name: string) {
  tx(db, () => deliver(db, { id: `mail-${name}`, agent: name, at: '2026-01-01T00:00:00Z', type: 'message', sender: 'karo', body: '資料' }));
}
function state() {
  return ['inbox','inbox_read_snapshot','report','ledger','task'].map((table) => db.query(`SELECT * FROM ${table}`).all());
}
function forbidden(fn: () => unknown) {
  try { fn(); throw new Error('expected a permission rejection'); }
  catch (e) {
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).status).toBe(403);
    expect((e as Error).message).toContain('inbox.read');
  }
}

test('core report submission rejects a read-only peer even with its own assigned subtask', () => {
  peer('reader', ['inbox.read']);
  const c = createCmd(db, 'shogun', { north_star: '能力を芯で守る', purpose: '報告の許しを検める', command: '資料を調べよ', project: 'test', acceptance_criteria: ['出典を報告する'] });
  const assigned = assignTask(db, 'karo', { agent: 'reader', cmd_id: c.id!, title: '資料を調べよ' });
  expect(assigned.ok).toBe(true);
  const before = state();
  const result = submitReport(db, 'reader', { task_id: assigned.id!, status: 'done', summary: '資料を照合した', acceptance: { 1: '一次資料を取得し本文を照合した' } });
  expect(result.ok).toBe(false);
  expect(result.message).toContain('report.submit');
  expect(state()).toEqual(before);
});

test('core inbox reads reject a peer lacking read capability without recording a snapshot', () => {
  peer('writer', ['inbox.write']);
  send('writer');
  const before = state();
  forbidden(() => list(db, 'writer'));
  forbidden(() => list(db, 'writer', { all: true }));
  forbidden(() => readOwnUnread(db, 'writer'));
  forbidden(() => recordReadSnapshot(db, 'writer', [], 1));
  expect(state()).toEqual(before);
});

test('core explicit and all acknowledgements reject a peer lacking read capability', () => {
  peer('reader', ['inbox.read']);
  send('reader');
  readOwnUnread(db, 'reader');
  // A policy can be withdrawn after a read; a saved snapshot grants no continuing authority.
  db.prepare('UPDATE external_peer SET capabilities = ? WHERE name = ?').run(JSON.stringify(['inbox.write']), 'reader');
  const before = state();
  for (const result of [ack(db, 'reader', ['mail-reader']), ackAll(db, 'reader')]) {
    expect(result.ok).toBe(false);
    expect(result.message).toContain('inbox.read');
    expect(result.changed).toEqual([]);
  }
  expect(state()).toEqual(before);
});

test('revocation also denies direct core read, ack and report calls', () => {
  peer('visitor', ['inbox.read', 'report.submit']);
  send('visitor');
  readOwnUnread(db, 'visitor');
  changeKey(db, 'shogun', 'visitor', true);
  const before = state();
  forbidden(() => list(db, 'visitor'));
  forbidden(() => readOwnUnread(db, 'visitor'));
  expect(ack(db, 'visitor', ['mail-visitor']).ok).toBe(false);
  expect(ackAll(db, 'visitor').ok).toBe(false);
  expect(submitReport(db, 'visitor', { task_id: 'absent', status: 'blocked', summary: '確認を待つ' }).ok).toBe(false);
  expect(state()).toEqual(before);
});

test('permitted peer core reads and acknowledgements still work', () => {
  peer('reader', ['inbox.read']);
  send('reader');
  expect(list(db, 'reader')).toHaveLength(1);
  expect(readOwnUnread(db, 'reader')).toHaveLength(1);
  expect(ack(db, 'reader', ['mail-reader']).ok).toBe(true);
  expect(list(db, 'reader')).toHaveLength(0);
  expect(readOwnUnread(db, 'reader')).toEqual([]);
  expect(ackAll(db, 'reader').ok).toBe(true);
});
