import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLimitedText, limitedWaitMs, limitState } from '../src/busy';
import { openStore } from '../src/store';
import { holdForReview, stateOf } from '../src/nudge';

// 受信した報せに記された文字列。pane 全文の採取とは区別する。
const FABLE = 'reached your Fable limit';
const now = new Date(2026, 8, 23, 5, 0);

describe('時刻を持たない既知の通知行', () => {
  test('Fable を検知するが復帰時刻を作らない', () => {
    for (const flag of [FABLE, "You've reached your Fable limit", '● You’ve reached your Fable limit.']) {
      expect(limitState(flag, now)).toBe('undated');
      expect(isLimitedText(flag, now)).toBe(true);
      expect(limitedWaitMs(flag, now)).toBeNull();
    }
  });
  test('limit を含む説明、引用、テスト出力、利用可能枠の案内を拾わない', () => {
    for (const text of [
      'The limit is 100 requests.', 'Set the Fable limit to 10.',
      'The test says reached your Fable limit', 'PASS reached your Fable limit',
      '"reached your Fable limit"', 'reached your Fable limit is a test fixture',
      "You haven't reached your Fable limit", 'No limit reached here.',
      'You have 3 usage limit resets available. Run /usage to use one.',
      'Rate limited. Please wait.',
    ]) expect(limitState(text, now), text).toBeNull();
    expect(limitState(`${FABLE}\n${'ordinary output\n'.repeat(9)}`, now)).toBeNull();
  });
  test('既知の時刻付き通知と過去の通知を引き続き判別する', () => {
    expect(limitState("You've hit your session limit · resets 6:20pm (Asia/Tokyo)",
      new Date(2026, 8, 23, 15, 0))).toBe(202 * 60_000);
    const dated = "You've hit your usage limit. or try again at Sep 21st, 2026 12:03 AM.";
    expect(limitState(dated, new Date(2026, 8, 20, 21, 0))).toBe(185 * 60_000);
    expect(limitState(dated, new Date(2026, 8, 22, 9, 0))).toBeNull();
  });
});

// 非 dry-run の送信経路を通す。子の PATH で tmux 全体を置換し、
// 装飾や採取を含む全呼び出しが実在する pane に届かないようにする。
function scenario(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'unknown-limit-'));
  try {
    writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\nif [ "$1" = "capture-pane" ]; then\n  printf "%s\\n" "reached your Fable limit"\n  exit 0\nfi\nexit 1\n');
    chmodSync(join(dir, 'tmux'), 0o755);
    const source = `
      import { openStore } from './src/store';
      import { syncRoster } from './src/roster';
      import { deliver, ackAll } from './src/inbox';
      import { runNudge } from './src/main';
      import { limitState } from './src/busy';
      import { stateOf, revive } from './src/nudge';
      const path = process.env.HONDEN_DB;
      let db = openStore({ path });
      syncRoster(db, [
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'ashigaru9', role: 'worker', cli: 'codex', model: null },
      ]);
      const agent = 'ashigaru9';
      const old = new Date(Date.now() - 600000).toISOString();
      deliver(db, { id: 'm1', agent, at: old, type: 'task_assigned', sender: 'karo', body: 'test' });
      db.run('INSERT INTO nudge(agent, since) VALUES (?,?)', [agent, old]);
      const sent = [];
      let screen = ${JSON.stringify(FABLE)};
      let busy = false;
      let defaultLimit = false;
      const tick = (dry = false) => runNudge(path, dry, false, undefined, 'core',
        () => new Map([[agent, { id: '%2147483647', label: 'fake:agents.9' }]]),
        () => busy, defaultLimit ? undefined : () => limitState(screen, new Date()),
        async p => { sent.push(p.text); return { ok: true }; });
      const notices = () => db.query("SELECT agent, body FROM inbox WHERE sender = 'core' AND msg_type = 'cmd_update'").all();
      ${body}
    `;
    const child = Bun.spawnSync([process.execPath, '-e', source], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        HONDEN_DB: join(dir, 'test.db'), TRACE: join(dir, 'trace') },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.success).toBe(true);
    return JSON.parse(child.stdout.toString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('Fable は初回から保留し、画面消失とDB再接続後も送信0、通知1、消去0', () => {
  const result = scenario(`
    const first = await tick();
    screen = '›';
    for (let i = 0; i < 4; i++) {
      db.close(); db = openStore({ path });
      await tick();
    }
    console.log(JSON.stringify({ first: first.out, sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.first).toContain('undated-limit');
  expect(result.sent).toEqual([]);
  expect(result.state.hold_reason).toBe('undated-limit');
  expect(result.state.reset_count).toBe(0);
  expect(result.state.last_reset_at).toBeNull();
  expect(result.notices.length).toBe(1);
  expect(result.notices[0].agent).toBe('karo');
});

test('未知の文言でも無応答なら最初の文脈消去前に保留する', () => {
  const result = scenario(`
    screen = 'Service temporarily unavailable: unfamiliar wording';
    const first = await tick(); await tick();
    console.log(JSON.stringify({ first: first.out, sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.first).toContain('unresponsive');
  expect(result.sent).toEqual([]);
  expect(result.state.reset_count).toBe(0);
  expect(result.notices.length).toBe(1);
});

test('既定のpane読み手もFableを検知して送信を止める', () => {
  const result = scenario(`
    defaultLimit = true;
    const first = await tick();
    console.log(JSON.stringify({ first: first.out, sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.first).toContain('undated-limit');
  expect(result.sent).toEqual([]);
  expect(result.state.reset_count).toBe(0);
  expect(result.notices.length).toBe(1);
});

test('通常のL1、L2と働いている相手への合図を保つ', () => {
  const result = scenario(`
    screen = '›';
    db.run('UPDATE nudge SET since = ?', [new Date().toISOString()]);
    await tick();
    db.run('UPDATE nudge SET since = ?, last_at = NULL', [new Date(Date.now() - 150000).toISOString()]);
    await tick();
    db.run('UPDATE nudge SET since = ?, last_at = NULL', [old]);
    busy = true; await tick();
    console.log(JSON.stringify({ sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.sent.length).toBe(3);
  expect(result.sent.every((s: string) => s.startsWith('inbox_notice'))).toBe(true);
  expect(result.state.hold_reason).toBeNull();
  expect(result.notices).toEqual([]);
});

test('Fable はL1でもbusyでも保留し、時刻付き旗は既存の待ちを優先する', () => {
  const result = scenario(`
    // 現在時刻によらない未来の日付を持つ試料。
    screen = 'or try again at Sep 21st, 2099 12:03 AM.';
    const dated = await tick();
    const afterDated = stateOf(db, agent);
    screen = ${JSON.stringify(FABLE)};
    db.run('UPDATE nudge SET since = ?', [new Date().toISOString()]);
    busy = true; await tick();
    console.log(JSON.stringify({ dated: dated.out, afterDated, sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.dated).toContain('使用枠が尽きておる');
  expect(result.afterDated.hold_reason).toBeNull();
  expect(result.state.hold_reason).toBe('undated-limit');
  expect(result.sent).toEqual([]);
  expect(result.notices.length).toBe(1);
});

test('dry-run は保留も通知も書かない', () => {
  const result = scenario(`
    const first = await tick(true);
    console.log(JSON.stringify({ first: first.out, sent, state: stateOf(db, agent), notices: notices() }));
  `);
  expect(result.first).toContain('undated-limit');
  expect(result.state.hold_reason).toBeNull();
  expect(result.sent).toEqual([]);
  expect(result.notices).toEqual([]);
});

test('上役のreviveで通常の合図へ戻る', () => {
  const result = scenario(`
    await tick(); screen = '›';
    const revived = revive(db, { agent, by: 'karo', reason: '契約枠と画面を確認し、処理を再開できる状態になった' });
    await tick();
    console.log(JSON.stringify({ revived, sent, state: stateOf(db, agent) }));
  `);
  expect(result.revived.ok).toBe(true);
  expect(result.state.hold_reason).toBeNull();
  expect(result.sent.length).toBe(1);
  expect(result.sent[0]).toContain('inbox_notice');
});

test('未読0で保留を忘れ、新しい未読へ合図を出す', () => {
  const result = scenario(`
    await tick(); screen = '›';
    ackAll(db, agent);
    await tick();
    const cleared = stateOf(db, agent);
    deliver(db, { id: 'm2', agent, at: new Date().toISOString(), type: 'task_assigned', sender: 'karo', body: 'next' });
    await tick();
    console.log(JSON.stringify({ cleared, sent }));
  `);
  expect(result.cleared.hold_reason).toBeNull();
  expect(result.sent.length).toBe(1);
});

test('周の間に未読が片付いて入れ替わっても、前の保留を引き継がない', () => {
  const result = scenario(`
    await tick(); screen = '›';
    ackAll(db, agent);
    deliver(db, { id: 'm2', agent, at: new Date().toISOString(), type: 'task_assigned', sender: 'karo', body: 'next' });
    await tick();
    console.log(JSON.stringify({ sent, state: stateOf(db, agent) }));
  `);
  expect(result.state.hold_reason).toBeNull();
  expect(result.sent.length).toBe(1);
});

test('旧表の移行で行を保ち、通知失敗時は保留も巻き戻す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unknown-limit-migration-'));
  try {
    const path = join(dir, 'test.db');
    const old = new Database(path);
    old.run('CREATE TABLE nudge(agent TEXT PRIMARY KEY, since TEXT, last_at TEXT, last_level INTEGER, last_reset_at TEXT, reset_count INTEGER NOT NULL DEFAULT 0)');
    old.run("INSERT INTO nudge(agent, reset_count) VALUES ('ashigaru9', 2)");
    old.close();
    const db = openStore({ path });
    expect(stateOf(db, 'ashigaru9').reset_count).toBe(2);
    holdForReview(db, 'karo', 'unresponsive', now);
    const supervisor = db.query("SELECT agent FROM inbox WHERE body LIKE 'karo:%'").get() as { agent: string };
    expect(supervisor.agent).toBe('shogun');
    expect(stateOf(db, 'ashigaru9').hold_reason).toBeNull();
    db.run("CREATE TRIGGER fail_notice BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
    expect(() => holdForReview(db, 'ashigaru9', 'undated-limit', now)).toThrow('test rejection');
    expect(stateOf(db, 'ashigaru9').hold_reason).toBeNull();
    db.run('DROP TRIGGER fail_notice');
    holdForReview(db, 'ashigaru9', 'undated-limit', now);
    expect(stateOf(db, 'ashigaru9').hold_reason).toBe('undated-limit');
    expect(stateOf(db, 'ashigaru9').reset_count).toBe(2);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
