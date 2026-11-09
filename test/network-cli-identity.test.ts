import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { readOwnUnread } from '../src/inbox';
import { changeKey, issuePeer } from '../src/external';
import { runInboxRead, runInboxAck, runReportSubmit } from '../src/main';
import { inboxWrite } from '../src/cli';

const ROOT = join(import.meta.dir, '..');
let dir: string;
let path: string;
let db: Database;
let taskId: string;
let messageId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honden-peer-cli-'));
  path = join(dir, 'store.db');
  db = openStore({ path });
  syncRoster(db, [
    { id: 'shogun', role: 'commander', cli: null, model: null },
    { id: 'karo', role: 'commander', cli: null, model: null },
    { id: 'gunshi', role: 'commander', cli: null, model: null },
    { id: 'ashigaru1', role: 'worker', cli: null, model: null },
  ]);
  // Generate credentials only in memory; no literal bearer keys or real tmux sessions are used.
  issuePeer(db, 'shogun', { name: 'visitor', kind: 'agent', direction: 'pull',
    capabilities: ['inbox.read', 'inbox.write', 'report.submit'], destinations: ['gunshi'] });
  const c = createCmd(db, 'shogun', { north_star: '受け手を確かめる', purpose: '外の名乗りを検める', command: '資料を調べよ', acceptance_criteria: ['出典を報告する'], project: 'test' });
  expect(c.ok, c.message).toBe(true);
  const assigned = assignTask(db, 'karo', { agent: 'visitor', cmd_id: c.id!, title: '資料を調べよ' });
  expect(assigned.ok, assigned.message).toBe(true);
  taskId = assigned.id!;
  messageId = readOwnUnread(db, 'visitor')[0]!.id;
  // Hermetic standalone CLI: the tmux probe sees no panes, regardless of the host test runner.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'bin', 'tmux'), 0o755);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function state() {
  return {
    inbox: db.query('SELECT * FROM inbox ORDER BY id').all(),
    reads: db.query('SELECT * FROM inbox_read_snapshot ORDER BY agent').all(),
    reports: db.query('SELECT * FROM report ORDER BY id').all(),
    tasks: db.query('SELECT * FROM task ORDER BY agent').all(),
    ledger: db.query('SELECT * FROM ledger ORDER BY id').all(),
  };
}
function cli(args: string[], id: string | undefined = 'visitor') {
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, TMUX: '', TMUX_PANE: '' };
  if (id === undefined) delete env.HONDEN_AGENT_ID;
  else env.HONDEN_AGENT_ID = id;
  return Bun.spawnSync([process.execPath, join(ROOT, 'src/main.ts'), ...args, '--db', path], { cwd: ROOT, env });
}
for (const operation of ['read', 'read-other', 'ack', 'ack-all', 'report', 'write', 'unread', 'lease'] as const) {
  test(`standalone CLI rejects peer identity: ${operation}, with no state change`, () => {
    const args: Record<typeof operation, string[]> = {
      read: ['inbox', 'read'],
      'read-other': ['inbox', 'read', '--agent', 'gunshi'],
      ack: ['inbox', 'ack', messageId],
      'ack-all': ['inbox', 'ack', '--all'],
      report: ['report', 'submit', '--task_id', taskId, '--status', 'blocked', '--summary', '確認を待っている'],
      write: ['inbox', 'write', '--to', 'gunshi', '--from', 'visitor', '--type', 'report_received', '--body', '資料を送る'],
      unread: ['inbox', 'unread'],
      lease: ['lease', 'renew'],
    };
    const before = state();
    const result = cli(args[operation]);
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('鍵を持って網の口');
    expect(state()).toEqual(before);
  });
}

test('CLI entry functions also reject peer identities directly', () => {
  const before = state();
  for (const result of [
    runInboxRead(path, 'visitor', undefined, false),
    runInboxAck(path, 'visitor', [messageId], false),
    runReportSubmit(path, 'visitor', { flags: { task_id: taskId, status: 'blocked', summary: '確認を待つ' } }, false),
  ]) {
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('鍵を持って網の口');
  }
  expect(state()).toEqual(before);
});

test('inbox write cannot spoof a peer through its from field without an identity', () => {
  const before = state();
  const result = cli(['inbox', 'write', '--to', 'gunshi', '--from', 'visitor', '--type', 'report_received', '--body', '資料を送る'], undefined);
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain('鍵を持って網の口');
  expect(inboxWrite(path, { flags: { to: 'gunshi', from: 'visitor', type: 'report_received', body: '資料を送る' } }, false, { insideFormation: false }).code).not.toBe(0);
  expect(state()).toEqual(before);
});

test('revoked peers and honden peers remain unavailable as CLI identities', () => {
  changeKey(db, 'shogun', 'visitor', true);
  issuePeer(db, 'shogun', { name: 'remote', kind: 'honden', direction: 'pull', capabilities: ['inbox.read'], destinations: [] });
  const before = state();
  for (const id of ['visitor', 'remote']) {
    const result = cli(['inbox', 'read'], id);
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('鍵を持って網の口');
  }
  expect(state()).toEqual(before);
});

test('normal worker CLI entry points retain their read, ack and report behavior', () => {
  const c = createCmd(db, 'shogun', { north_star: '既存の動きを守る', purpose: '足軽の動きを検める', command: '資料を調べよ', acceptance_criteria: ['出典を報告する'], project: 'test' });
  const assigned = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: c.id!, title: '資料を調べよ' });
  expect(runInboxRead(path, 'ashigaru1', undefined, false).code).toBe(0);
  const messages = readOwnUnread(db, 'ashigaru1');
  expect(runInboxAck(path, 'ashigaru1', messages.map((m) => m.id), false).code).toBe(0);
  expect(runReportSubmit(path, 'ashigaru1', { flags: { task_id: assigned.id!, status: 'blocked', summary: '確認を待つ' } }, false).code).toBe(0);
});
