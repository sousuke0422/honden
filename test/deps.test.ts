/**
 * 司令の依存の試験。
 *
 *   1. 依存が解けておらぬ司令は振れぬ。needs が done になれば、何もせずとも振れる
 *   2. 覆す道は既存の --bypass だけ（新しい抜け道を作らぬ）
 *   3. 循環は入口で防ぐ（二つの輪も、三つ以上の輪も）
 *   4. 在らぬ司令・己自身には頼れぬ
 *   5. needs が取り消し・失敗で閉じれば印が立ち、家老へ一度だけ報せる
 */

import { expect, test, describe } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { amendCmd } from '../src/amend';
import { notifyBlocked, unresolved, depSummary } from '../src/deps';
import { runCmdList } from '../src/main';

const roster = (db: ReturnType<typeof openStore>) =>
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'claude-opus-5' },
      { id: 'karo', role: 'commander', cli: 'cursor', model: 'auto' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'claude-sonnet-5' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'claude-fable-5' },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: 'claude-fable-5' },
    ]);
  });

const memDb = () => {
  const db = openStore({ path: ':memory:' });
  roster(db);
  return db;
};
const fileDb = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'honden-deps-')), 'h.db');
  const db = openStore({ path });
  roster(db);
  return { db, path };
};

const cmd = (extra: Record<string, unknown> = {}) => ({
  north_star: '順を頭で持たぬ',
  purpose: '依存を正本に持たせる',
  acceptance_criteria: ['依存が解けるまで振れぬ'],
  command: '試験のための司令',
  project: 'honden',
  ...extra,
});
const newCmd = (db: ReturnType<typeof openStore>, extra: Record<string, unknown> = {}) => {
  const r = createCmd(db, 'shogun', cmd(extra));
  if (!r.ok) throw new Error(r.message);
  return r.id!;
};
const assign = (db: ReturnType<typeof openStore>, cmdId: string, agent = 'ashigaru1', extra: Record<string, unknown> = {}) =>
  assignTask(db, 'karo', { agent, cmd_id: cmdId, title: '仕事', ...extra });
const setStatus = (db: ReturnType<typeof openStore>, id: string, status: string) =>
  db.run('UPDATE cmd SET status = ? WHERE id = ?', [status, id]);
const amend = (db: ReturnType<typeof openStore>, cmdId: string, depends_on: unknown) =>
  amendCmd(db, 'shogun', { cmd_id: cmdId, depends_on, reason: '順を正本に持たせるため依存を足す' });

describe('依存が解けるまで振れぬ', () => {
  test('依存の無い司令は従来どおり振れる', () => {
    const db = memDb();
    const a = newCmd(db);
    expect(assign(db, a).ok).toBe(true);
  });

  test('needs が済んでおらねば拒む。文は「cmd_x が済んでおらぬ」', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    const r = assign(db, b);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`${a} が済んでおらぬ`);
    // 拒んだ時は何も書かぬ（貸与も報せも立たぬ）
    expect(db.query("SELECT holder FROM task WHERE agent = 'ashigaru1'").get()).toBeNull();
  });

  test('needs が done になれば、何もせずとも振れる（解けた印を書かぬ）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    expect(assign(db, b).ok).toBe(false);
    setStatus(db, a, 'done');
    expect(unresolved(db, b)).toEqual([]);
    expect(assign(db, b).ok).toBe(true);
    // 依存の行そのものは残る（状態を書き換えておらぬ証）
    expect(db.query('SELECT count(*) n FROM cmd_dep WHERE cmd_id = ?').get(b)).toEqual({ n: 1 });
  });

  test('二つ頼れば、二つとも済むまで振れぬ', () => {
    const db = memDb();
    const a = newCmd(db);
    const c = newCmd(db);
    const b = newCmd(db, { depends_on: [a, c] });
    setStatus(db, a, 'done');
    const r = assign(db, b);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`${c} が済んでおらぬ`);
    expect(r.message).not.toContain(`${a} が済んでおらぬ`);
  });

  test('覆せるのは既存の --bypass だけ（将軍・理由つき）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    const r = assignTask(db, 'shogun', {
      agent: 'ashigaru1',
      cmd_id: b,
      title: '仕事',
      bypass: 'true',
      reason: '先の司令は殿が手で済ませたゆえ順を飛ばす',
    });
    expect(r.ok).toBe(true);
    const row = db.query("SELECT detail FROM ledger WHERE action = 'task.assign.bypass'").get() as { detail: string };
    expect(row.detail).toContain(`未解の依存=${a}`);
    // 家老は迂回できぬ（新しい抜け道を作っておらぬ）
    const k = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: b, title: '仕事', bypass: 'true', reason: '家老が順を飛ばす' });
    expect(k.ok).toBe(false);
  });
});

describe('在らぬ司令・己自身には頼れぬ', () => {
  test('在らぬ司令は拒み、司令そのものも書かぬ', () => {
    const db = memDb();
    const r = createCmd(db, 'shogun', cmd({ depends_on: ['cmd_99'] }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('cmd_99');
    expect(db.query('SELECT count(*) n FROM cmd').get()).toEqual({ n: 0 });
  });

  test('己自身は拒む（新しく振られる番号を先に書いても）', () => {
    const db = memDb();
    const r = createCmd(db, 'shogun', cmd({ depends_on: ['cmd_1'] }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('己自身');
    expect(db.query('SELECT count(*) n FROM cmd').get()).toEqual({ n: 0 });
  });

  test('司令番号でない物は拒む', () => {
    const db = memDb();
    expect(createCmd(db, 'shogun', cmd({ depends_on: ['いつか'] })).ok).toBe(false);
  });
});

describe('循環は入口で防ぐ', () => {
  test('二つの輪（a → b → a）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    const r = amend(db, a, [b]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('輪');
    expect(db.query('SELECT count(*) n FROM cmd_dep WHERE cmd_id = ?').get(a)).toEqual({ n: 0 });
  });

  test('三つ以上の輪（a → c → b → a、四つも）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    const c = newCmd(db, { depends_on: [b] });
    const r3 = amend(db, a, [c]);
    expect(r3.ok).toBe(false);
    expect(r3.message).toContain(`${a} → ${c} → ${b} → ${a}`);
    const d = newCmd(db, { depends_on: [c] });
    expect(amend(db, a, [d]).ok).toBe(false);
    expect(db.query('SELECT count(*) n FROM cmd_dep WHERE cmd_id = ?').get(a)).toEqual({ n: 0 });
  });

  test('輪にならぬ足し方は通る（菱形）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    const c = newCmd(db, { depends_on: [a] });
    const d = newCmd(db, { depends_on: [b, c] });
    expect(unresolved(db, d).map((n) => n.needs)).toEqual([b, c]);
  });
});

describe('amend で足し引きし、跡を残す', () => {
  test('足しても外しても cmd_revision に残る', () => {
    const db = memDb();
    const a = newCmd(db);
    const c = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    expect(amend(db, b, [c]).ok).toBe(true);
    expect(unresolved(db, b).map((n) => n.needs)).toEqual([c]);
    // amend の報せの id は実の時計のミリ秒から作るゆえ、同じミリ秒に二度書き換えると
    // inbox の主キーが衝突する（依存とは別の、元から在る疵）。時計が進むのを待つ。
    const t0 = Date.now();
    while (Date.now() === t0) { /* 一ミリ秒待つ */ }
    expect(amend(db, b, []).ok).toBe(true);
    expect(unresolved(db, b)).toEqual([]);
    const revs = db.query("SELECT before, after FROM cmd_revision WHERE cmd_id = ? AND field = 'depends_on' ORDER BY id").all(b);
    expect(revs).toEqual([
      { before: a, after: c },
      { before: c, after: '' },
    ]);
  });
});

describe('needs が取り消されれば塞がりの印と、家老への一度の報せ', () => {
  test('cmd list に待ちの印、取り消しには別の印', () => {
    const { db, path } = fileDb();
    const a = newCmd(db);
    const c = newCmd(db);
    const b = newCmd(db, { depends_on: [a, c] });
    let out = runCmdList(path, false).out ?? '';
    const lineB = () => out.split('\n').find((l) => l.includes(`${b} `)) ?? '';
    expect(lineB()).toContain(`⛓ ${a}, ${c} 待ち`);
    setStatus(db, a, 'done');
    setStatus(db, c, 'cancelled');
    out = runCmdList(path, false).out ?? '';
    expect(lineB()).not.toContain('待ち');
    expect(lineB()).toContain(`⛔ ${c}（cancelled）で塞がり`);
  });

  test('家老へ一度だけ報せる（二度目は鳴らぬ）', () => {
    const db = memDb();
    const a = newCmd(db);
    const b = newCmd(db, { depends_on: [a] });
    expect(notifyBlocked(db)).toEqual([]);
    setStatus(db, a, 'failed');
    expect(notifyBlocked(db).map((x) => x.cmdId)).toEqual([b]);
    expect(notifyBlocked(db)).toEqual([]);
    const msgs = db.query("SELECT agent, msg_type FROM inbox WHERE msg_type = 'cmd_blocked'").all();
    expect(msgs).toEqual([{ agent: 'karo', msg_type: 'cmd_blocked' }]);
  });

  test('status の合計の一行', () => {
    const db = memDb();
    const a = newCmd(db);
    const c = newCmd(db);
    newCmd(db, { depends_on: [a] });
    newCmd(db, { depends_on: [c] });
    expect(depSummary(db)).toBe('依存待ちの司令 2 件');
    setStatus(db, c, 'cancelled');
    expect(depSummary(db)).toBe('依存待ちの司令 1 件 / 依存の取り消しで塞がった司令 1 件');
    setStatus(db, a, 'done');
    expect(depSummary(db)).toBe('依存の取り消しで塞がった司令 1 件');
  });
});

describe('移行は要らぬ——表が一つ生えるだけ', () => {
  test('依存を知らぬ頃の正本を開けば cmd_dep が生え、既存の司令は残る', () => {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const path = join(mkdtempSync(join(tmpdir(), 'honden-deps-mig-')), 'old.db');
    // まず今の形で建て、cmd_dep だけを落として「依存を知らぬ頃」の正本にする
    const first = openStore({ path });
    roster(first);
    const a = newCmd(first);
    first.close();
    const old = new Database(path);
    old.run('DROP TABLE cmd_dep');
    old.close();

    const db = openStore({ path });
    const t = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='cmd_dep'").get();
    expect(t).toEqual({ name: 'cmd_dep' });
    expect(db.query('SELECT id FROM cmd').all()).toEqual([{ id: a }]);
    // 既存の表の欄は一つも増えておらぬ（cmd に依存の欄を足しておらぬ）
    const cols = (db.query('PRAGMA table_info(cmd)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('depends_on');
    // 生えた表で、そのまま依存を書ける
    expect(newCmd(db, { depends_on: [a] })).toBe('cmd_2');
  });
});
