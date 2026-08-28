/**
 * 手引きの試験。
 *
 * `--help` はどの副命令でも壊れていた（殿の申し出で判明・2026-08-28）。
 * 検めや役の門に弾かれ、`brief --help` は指示書を丸ごと吐き、
 * `status --help` は SQLite ごと落ちた。
 *
 * 手引きが無ければ読む者は探索で凌ぐ——実際に足軽が `rg --files` を漁った。
 * **凌げた時は誰も気づかぬ**ゆえ、静かに時を食う類の欠けである。
 */
import { describe, expect, test } from 'bun:test';
import { HELP, lookup, render } from '../src/help';

describe('鍵の引き方', () => {
  test('二語の副命令は二語で引く（`cmd new` が `cmd` に勝つ）', () => {
    expect(lookup(['cmd', 'new'])?.summary).toContain('司令を書く');
  });

  test('一語の副命令も引ける', () => {
    expect(lookup(['status'])?.summary).toContain('布陣');
  });

  test('後ろに余計な語があっても引ける', () => {
    expect(lookup(['cmd', 'show', 'cmd_2'])?.summary).toContain('覆い');
  });

  test('知らぬ副命令は null（黙って別の手引きを返さぬ）', () => {
    expect(lookup(['nonexistent'])).toBeNull();
    expect(lookup([])).toBeNull();
  });
});

describe('手引きの形', () => {
  test('要旨と使い方は必ず在る', () => {
    for (const [key, h] of Object.entries(HELP)) {
      expect(h.summary.length, `${key} の要旨`).toBeGreaterThan(0);
      expect(h.usage.length, `${key} の使い方`).toBeGreaterThan(0);
      // 使い方は `honden` で始まる——写して叩ける形にする
      expect(h.usage.startsWith('honden'), `${key} の使い方は honden で始まる`).toBe(true);
    }
  });

  test('出す形に要旨・使い方・旗・心得・例が入る', () => {
    const out = render('task assign', HELP['task assign']!);
    expect(out).toContain('task assign —');
    expect(out).toContain('honden task assign');
    expect(out).toContain('旗:');
    expect(out).toContain('--bypass');
    expect(out).toContain('例:');
  });

  test('旗も心得も無い副命令でも倒れぬ', () => {
    expect(() => render('x', { summary: 'あ', usage: 'honden x' })).not.toThrow();
  });
});

describe('網羅 — 危うい副命令ほど手引きが要る', () => {
  // 役が限られる・跡が残る・取り返しがつかぬものは、必ず心得を添える。
  const mustHaveNotes = [
    'cmd new', // 将軍のみ
    'task assign', // 家老のみ・迂回の跡
    'report qc', // 軍師のみ・己の分は検められぬ
    'guard grant', // 将軍のみ・一度きり
    'guard appeal', // 絶対域は通らぬ
    'inbox ack', // 己の分だけ
    'inbox write', // 種別・外から役職を名乗れぬ
  ];
  for (const key of mustHaveNotes) {
    test(`${key} には心得が要る`, () => {
      const h = HELP[key];
      expect(h, `${key} の手引き`).toBeDefined();
      expect(h!.notes?.length ?? 0, `${key} の心得`).toBeGreaterThan(0);
    });
  }

  test('本日建てた副命令も手引きを持つ（建てて手引きを忘れる形を防ぐ）', () => {
    for (const key of ['cmd list', 'status', 'brief', 'guard selftest', 'log', 'dashboard', 'backup', 'export']) {
      expect(HELP[key], key).toBeDefined();
    }
  });
});
