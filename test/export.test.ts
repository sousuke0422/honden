/**
 * 切り戻しの綱の試験。
 *
 * 要は **round-trip** である: 吐いた YAML を honden 自身の import が
 * 難なく読めれば、形の正しさは機械で証される。人が旧環境で読める形かは
 * 旧の欄名（worker_id / parent_cmd / workdir …）との突き合わせで見る。
 */
import { describe, expect, test } from 'bun:test';
import { exportAll } from '../src/export';
import { importTree } from '../src/import';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import { createCmd, assignTask } from '../src/dispatch';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const TRICKY = "難しい本文 C:\\Users\\x と ''' と $HOME";

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'codex', model: null },
    ]);
  });
  createCmd(db, 'shogun', {
    north_star: '北極星である',
    purpose: '目的である',
    acceptance_criteria: ['条件その一', '条件その二'],
    command: '本文である\n二行目もある',
    project: 'honden',
  });
  assignTask(db, 'karo', {
    agent: 'ashigaru1',
    cmd_id: 'cmd_1',
    title: TRICKY,
    workspace: '/tmp/w',
    branch: 'feat/x',
  });
  tx(db, () => {
    deliver(db, {
      id: 'm1',
      agent: 'karo',
      at: '2026-08-29T00:00:00Z',
      type: 'cmd_new',
      sender: 'shogun',
      body: '司令を書いた。実行せよ。',
    });
  });
  return db;
};

describe('形', () => {
  test('司令・受け渡し・任が旧の欄名で吐かれる', () => {
    const files = exportAll(seeded());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('queue/shogun_to_karo.yaml');
    expect(paths).toContain('queue/inbox/karo.yaml');
    expect(paths).toContain('queue/tasks/ashigaru1.yaml');

    const cmds = Bun.YAML.parse(files.find((f) => f.path === 'queue/shogun_to_karo.yaml')!.body) as any;
    expect(cmds.cmds[0].id).toBe('cmd_1');
    expect(cmds.cmds[0].acceptance_criteria).toEqual(['条件その一', '条件その二']);
    expect(cmds.cmds[0].command).toContain('二行目もある');

    const inbox = Bun.YAML.parse(files.find((f) => f.path === 'queue/inbox/karo.yaml')!.body) as any;
    expect(inbox.messages[0]).toMatchObject({ from: 'shogun', type: 'cmd_new', read: false });

    const task = Bun.YAML.parse(files.find((f) => f.path === 'queue/tasks/ashigaru1.yaml')!.body) as any;
    expect(task.worker_id).toBe('ashigaru1');
    expect(task.parent_cmd).toBe('cmd_1');
    expect(task.workdir).toBe('/tmp/w');
    expect(task.branch).toBe('feat/x');
  });

  test('厄介な字（Windows パス・三連引用・$HOME）が壊れず往復する', () => {
    const files = exportAll(seeded());
    const task = Bun.YAML.parse(files.find((f) => f.path === 'queue/tasks/ashigaru1.yaml')!.body) as any;
    // 旧 inbox_write.sh はこの手の字で壊れた。綱が同じ轍を踏んでは意味が無い。
    expect(task.title).toBe(TRICKY);
  });

  test('未読と既読が忠実に写る', () => {
    const db = seeded();
    tx(db, () => {
      db.prepare('UPDATE inbox SET read = 1 WHERE id = ?').run('m1');
      deliver(db, {
        id: 'm2',
        agent: 'karo',
        at: '2026-08-29T01:00:00Z',
        type: 'report_received',
        sender: 'ashigaru1',
        body: '済んだ',
      });
    });
    const inbox = Bun.YAML.parse(
      exportAll(db)
        .find((f) => f.path === 'queue/inbox/karo.yaml')!.body,
    ) as any;
    const byId = Object.fromEntries(inbox.messages.map((m: any) => [m.id, m.read]));
    expect(byId['m1']).toBe(true);
    expect(byId['m2']).toBe(false);
  });
});

describe('round-trip — 吐いた物を honden 自身が読めるか', () => {
  test('import が全枚を難なく取り込む', () => {
    const files = exportAll(seeded());
    const root = mkdtempSync(join(tmpdir(), 'honden-export-'));
    for (const f of files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.body);
    }
    const db2 = openStore({ path: ':memory:' });
    const r = importTree(db2, root, ['queue']);
    expect(r.issues).toEqual([]); // 難ありゼロ = 全枚が YAML として読めた
    expect(r.imported).toBe(files.length);
  });
});
