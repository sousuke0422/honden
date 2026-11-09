import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store';
import { syncRoster } from '../src/roster';
import { issuePeer, externalAgent } from '../src/external';
import { createCmd, assignTask } from '../src/dispatch';
import { setSetting } from '../src/settings';
import { SETTINGS_PATH_KEY } from '../src/config';
import { routingGaps } from '../src/routing';
import { runRosterSync, runStatus } from '../src/main';

let db: Database;
let dir: string;
let path: string;
let settings: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honden-peer-dispatch-'));
  path = join(dir, 'store.db');
  settings = join(dir, 'settings.yaml');
  writeFileSync(settings, 'bloom_routing: warn\n');
  db = openStore({ path });
  syncRoster(db, [
    { id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null },
    { id: 'gunshi', role: 'commander', cli: null, model: null },
    { id: 'ashigaru1', role: 'worker', cli: 'codex', model: 'unlisted-test-model' },
  ]);
  issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull', capabilities: ['inbox.read', 'report.submit'], destinations: ['gunshi'] });
  setSetting(db, SETTINGS_PATH_KEY, settings, 'test');
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function command(bloom?: number) {
  const result = createCmd(db, 'shogun', { north_star: '模型の検めを相手に合わせる', purpose: '外の相手とpaneを分ける',
    command: '資料を調べよ', project: 'test', acceptance_criteria: ['出典を報告する'], ...(bloom === undefined ? {} : { bloom }) });
  expect(result.ok, result.message).toBe(true);
  return result.id!;
}
const unknownAcks = () => db.query("SELECT target FROM ledger WHERE action = 'task.assign.ack_unknown_model'").all();

for (const explicitAck of [false, true]) {
  test(`external assignment needs no model acknowledgement and records no bypass (flag=${explicitAck})`, () => {
    const id = command(4);
    const result = assignTask(db, 'karo', { agent: 'visitor', cmd_id: id, title: '資料を調べよ', ...(explicitAck ? { 'ack-unknown-model': true } : {}) });
    expect(result.ok, result.message).toBe(true);
    expect(unknownAcks()).toEqual([]);
    expect(db.query("SELECT holder FROM task WHERE agent = 'visitor'").get()).toEqual({ holder: 'visitor' });
    expect(db.query('SELECT count(*) n FROM model_limit').get()).toEqual({ n: 0 });
  });
}

test('a native worker with an unlisted model still needs acknowledgement', () => {
  const id = command(4);
  const denied = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: id, title: '資料を調べよ' });
  expect(denied.ok).toBe(false);
  expect(denied.message).toContain('--ack-unknown-model');
  expect(db.query("SELECT 1 FROM task WHERE agent = 'ashigaru1'").get()).toBeNull();
  expect(assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: id, title: '資料を調べよ', 'ack-unknown-model': true }).ok).toBe(true);
  expect(unknownAcks()).toEqual([{ target: 'ashigaru1' }]);
});

test('strict missing-bloom acknowledgement still applies to external peers', () => {
  writeFileSync(settings, 'bloom_routing: strict\n');
  const id = command();
  const denied = assignTask(db, 'karo', { agent: 'visitor', cmd_id: id, title: '資料を調べよ' });
  expect(denied.ok).toBe(false);
  expect(denied.message).toContain('--ack-no-bloom');
  expect(denied.message).not.toContain('--ack-unknown-model');
  expect(assignTask(db, 'karo', { agent: 'visitor', cmd_id: id, title: '資料を調べよ', 'ack-no-bloom': true }).ok).toBe(true);
  expect(unknownAcks()).toEqual([]);
  expect(db.query("SELECT target FROM ledger WHERE action = 'task.assign.ack_no_bloom'").all()).toEqual([{ target: 'visitor' }]);
});

test('an explicit bloom satisfies strict mode for an external peer without model flags', () => {
  writeFileSync(settings, 'bloom_routing: strict\n');
  const result = assignTask(db, 'karo', { agent: 'visitor', cmd_id: command(), title: '資料を調べよ', bloom: 6 });
  expect(result.ok, result.message).toBe(true);
  expect(unknownAcks()).toEqual([]);
  expect(db.query("SELECT 1 FROM ledger WHERE action = 'task.assign.ack_no_bloom'").get()).toBeNull();
});

test('status and roster sync report native model gaps without counting external peers', () => {
  const status = runStatus(path, false);
  expect(status.code).toBe(0);
  const gap = status.out!.split('\n').find((s) => s.includes('能力表に無い模型'))!;
  expect(gap).toContain('ashigaru1=unlisted-test-model');
  expect(gap).not.toContain('visitor');
  writeFileSync(settings, `cli:
  agents:
    shogun: { type: codex, model: known-test-model }
    karo: { type: codex, model: known-test-model }
    gunshi: { type: codex, model: known-test-model }
    ashigaru1: { type: codex, model: unlisted-test-model }
capability_tiers:
  known-test-model: { max_bloom: 6 }
`);
  const synced = runRosterSync(path, settings);
  expect(synced.code, synced.err).toBe(0);
  const syncedGap = synced.out!.split('\n').find((s) => s.includes('能力表に無い模型'))!;
  expect(syncedGap).toContain('ashigaru1=unlisted-test-model');
  expect(syncedGap).not.toContain('visitor');
  expect(routingGaps(db).some((s) => s.includes('visitor'))).toBe(false);
  expect(externalAgent(db, 'visitor')).toBe(true);
});
