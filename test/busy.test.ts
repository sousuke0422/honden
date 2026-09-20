/**
 * busy 見立ての試験 — 旧 agent_is_busy_check の移植が旧の判定と揃うか。
 *
 * 画面は実機の写しに寄せた作り物。cursor の busy は本試験環境の実測
 * （sleep 300 実行中の pane）から採った。
 */
import { describe, expect, test } from 'bun:test';
import { isBusyText, isLimitedText, isWorking , limitedWaitMs } from '../src/busy';

/**
 * 実測の pane 文面（試料）。
 *
 * CLI の刷る字が変われば検査は古びるゆえ、**いつ・どの CLI から採ったか**を
 * 傍に残す。枠切れの旗と、枠切れでない紛らわしい文面の両方を置く——
 * 後者が無いと、偽陽性を弾く検査が「元から立たぬ文」で通ってしまう。
 */
// codex（殿採取 2026-09-10）— 真に切れた時。**復帰時刻が併記される**
const CODEX_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit\n" +
  'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:55 AM.';
// claude（殿採取 2026-09-05）— 真に切れた時
const CLAUDE_LIMIT = "You've hit your session limit · resets 6:20pm (Asia/Tokyo)";
// claude（殿採取 2026-09-10）— **枠切れではない。** 手で使える無料のリセットが
// 3 回残っておるという案内である（殿の教示）。復帰時刻を併記せぬのが見分けの印
const CLAUDE_RESETS_AVAILABLE = 'You have 3 usage limit resets available. Run /usage to use one.';
import { openStore, journal } from '../src/store';

describe('cursor', () => {
  test('処理中は ctrl+c to stop が出る → busy', () => {
    const capture = [
      '  ⠰⠰ Running  214 tokens',
      '  → Add a follow-up                       ctrl+c to stop',
      '  Composer 2.5 · 19.4%                    Run Everything',
      '  /mnt/c/Users/example/work/honden · main',
    ].join('\n');
    expect(isBusyText(capture, 'cursor')).toBe(true);
  });

  test('待機中は Add a follow-up のみ → idle', () => {
    const capture = [
      '  待機します。',
      '  → Add a follow-up',
      '  Composer 2.5 · 10.5%                    Run Everything',
      '  /mnt/c/Users/example/work/honden · main',
    ].join('\n');
    expect(isBusyText(capture, 'cursor')).toBe(false);
  });
});

describe('claude（既定の見立て）', () => {
  test('状態帯の esc to interrupt → busy', () => {
    const capture = ['❯ 何か打っておる', '', 'Cogitating… (esc to interrupt)'].join('\n');
    expect(isBusyText(capture, 'claude')).toBe(true);
  });

  test('素のプロンプトのみ → idle', () => {
    const capture = ['前の出力が残っておる', '', '❯ '].join('\n');
    expect(isBusyText(capture, 'claude')).toBe(false);
  });

  test('scroll-back の古い esc to は拾わぬ（最終行だけを見る・旧 T-BUSY-008）', () => {
    const capture = [
      'Working on task • esc to interrupt', // 昔の帯が上に残っておる
      '結果を出した',
      '❯ ',
      '? for shortcuts',
    ].join('\n');
    expect(isBusyText(capture, 'claude')).toBe(false);
  });

  test('spinner の言葉が末尾に居れば busy', () => {
    const capture = ['Thinking...', '', ''].join('\n');
    expect(isBusyText(capture, 'claude')).toBe(true);
  });
});

describe('codex', () => {
  test('? for shortcuts の待ち画面 → idle', () => {
    const capture = ['出力が済んだ', '', '  ? for shortcuts   97% context left'].join('\n');
    expect(isBusyText(capture, 'codex')).toBe(false);
  });
});

describe('opencode', () => {
  test('busy の帯（■⬝ の並び）→ busy', () => {
    const capture = ['何か', '■■■⬝⬝⬝⬝⬝  working', 'status'].join('\n');
    expect(isBusyText(capture, 'opencode')).toBe(true);
  });

  test('空白画面（描画前）→ idle 扱いで回復を塞がぬ', () => {
    expect(isBusyText('   \n  \n', 'opencode')).toBe(false);
  });
});

describe('枠切れの見立て（isLimitedText）— 印は復帰時刻の併記である', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 10, h, m, 0, 0);

  test('復帰時刻が併記され、それが未来なら立つ', () => {
    // 文面ごとに「いま」を添える。刻で判ずる以上、時計を渡さねば日を跨いで揺れる
    const cases: [string, Date][] = [
      ["❯\nYou've reached your usage limit. Your limit resets at 8am", at(6, 0)],
      [CLAUDE_LIMIT, at(15, 0)],
      [CODEX_LIMIT, at(3, 0)],
      ['5-hour limit reached ∙ resets 2pm', at(12, 0)],
      ["You've hit your usage limit. Try again at 14:00.", at(12, 0)],
    ];
    for (const [s, now] of cases) expect(isLimitedText(`something\n${s}`, now), s).toBe(true);
  });

  test('復帰時刻を併記せぬ文面は、limit の字を含んでも立たぬ（殿の決め 2026-09-10）', () => {
    for (const s of [
      CLAUDE_RESETS_AVAILABLE, // 枠は「有る」という案内である
      'Rate limited. Please wait.',
      '利用制限に達しました。しばらくお待ちください',
      'You have hit your usage limit.',
    ]) {
      expect(isLimitedText(`something\n${s}`, at(12, 0)), s).toBe(false);
    }
  });

  test('尻の 8 行だけを見る——scroll-back の古い旗では立たぬ', () => {
    const old = 'usage limit reached\n' + Array.from({ length: 10 }, (_, i) => `行${i}`).join('\n') + '\n❯ ';
    expect(isLimitedText(old, at(12, 0))).toBe(false);
  });

  test('素の prompt・普通の仕事の文では立たぬ', () => {
    expect(isLimitedText('❯ ', at(12, 0))).toBe(false);
    expect(isLimitedText('テストを 3 本足した。limit という語は本文に無い', at(12, 0))).toBe(false);
    expect(isLimitedText('Working (12s · esc to interrupt)', at(12, 0))).toBe(false);
  });
});

describe('過ぎた案内は信じぬ（殿の決め 2026-09-10）', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 10, h, m, 0, 0);

  test('codex 実文: 5:55 AM を過ぎておれば枠切れではない', () => {
    // 陰性——刻は 1 時間前。枠は既に戻っておる
    expect(isLimitedText(CODEX_LIMIT, at(7, 0))).toBe(false);
    expect(limitedWaitMs(CODEX_LIMIT, at(7, 0))).toBeNull();
  });

  test('陽性対照: 同じ文面でも刻が未来なら枠切れと判ずる', () => {
    // これが立たねば、上の陰性は「元から立たぬ文」を見ておるだけになる
    expect(isLimitedText(CODEX_LIMIT, at(3, 0))).toBe(true);
    expect(limitedWaitMs(CODEX_LIMIT, at(3, 0))).toBe((2 * 60 + 55 + 2) * 60_000);
  });

  test('claude 実文でも同じ（6:20pm の前後）', () => {
    expect(isLimitedText(CLAUDE_LIMIT, at(18, 30))).toBe(false);
    expect(isLimitedText(CLAUDE_LIMIT, at(18, 10))).toBe(true);
  });
});

describe('働いておる印（isWorking）— 画面ではなく正本から見立てる', () => {
  const now = new Date('2026-09-06T01:17:00Z');
  const fresh = () => {
    const db = openStore({ path: ':memory:' });
    db.run("INSERT OR IGNORE INTO task(agent, task_id, updated_at, raw) VALUES ('ashigaru6', 'idle', '2026-09-06T00:00:00Z', '{}')");
    return db;
  };

  test('何も刻んでおらず lease も無い → 働いておらぬ', () => {
    const db = fresh();
    expect(isWorking(db, 'ashigaru6', now)).toBeNull();
  });

  test('直近 10 分に己の名で台帳へ刻んでおる → 働いておる（guard.deny の実例）', () => {
    const db = fresh();
    journal(db, { actor: 'ashigaru6', action: 'guard.deny', target: 'D005', at: new Date('2026-09-06T01:15:04Z') });
    expect(isWorking(db, 'ashigaru6', now)).toContain('guard.deny');
  });

  test('刻みが 10 分より古ければ数えぬ', () => {
    const db = fresh();
    journal(db, { actor: 'ashigaru6', action: 'claim.take', at: new Date('2026-09-06T01:03:27Z') });
    expect(isWorking(db, 'ashigaru6', now)).toBeNull();
  });

  test('他人の刻みや nudge 自身の刻みは数えぬ', () => {
    const db = fresh();
    journal(db, { actor: 'nudge', action: 'nudge.L2', target: 'ashigaru6', at: now });
    journal(db, { actor: 'karo', action: 'inbox.write', target: 'ashigaru6', at: now });
    expect(isWorking(db, 'ashigaru6', now)).toBeNull();
  });

  test('生きた lease を握っておる → 働いておる。切れておれば数えぬ', () => {
    const db = fresh();
    db.run("UPDATE task SET holder = 'ashigaru6', lease_until = '2026-09-06T01:33:27Z' WHERE agent = 'ashigaru6'");
    expect(isWorking(db, 'ashigaru6', now)).toContain('lease');
    db.run("UPDATE task SET lease_until = '2026-09-06T01:10:00Z' WHERE agent = 'ashigaru6'");
    expect(isWorking(db, 'ashigaru6', now)).toBeNull();
  });
});

describe('枠切れの明ける刻を読む（limitedWaitMs）', () => {
  const at = (h: number, m: number) => new Date(2026, 8, 10, h, m, 0, 0);
  const MIN = 60_000;
  test('claude 実文: resets 6:20pm を 15:00 に読むと 1 時間 22 分', () => {
    const w = limitedWaitMs("You've hit your session limit · resets 6:20pm (Asia/Tokyo)", at(15, 0));
    expect(w).toBe((18 * 60 + 20 - 15 * 60) * MIN + 2 * MIN);
  });
  test('codex 実文: try again at 5:55 AM を 23:00 に読むと翌朝——ただし 6 時間で頭打ち', () => {
    const w = limitedWaitMs('or try again at 5:55 AM.', at(23, 0));
    expect(w).toBe(6 * 60 * MIN);
  });
  test('日跨ぎは「いまから最も近い解釈」を採る（深夜の 2am は明朝）', () => {
    const w = limitedWaitMs('resets 2am', at(22, 30));
    expect(w).toBe((3 * 60 + 30) * MIN + 2 * MIN);
  });
  test('刻の無い旗は枠切れと見ぬ——印は刻の併記である', () => {
    expect(limitedWaitMs('Rate limited. Please wait.', at(12, 0))).toBeNull();
    expect(limitedWaitMs(CLAUDE_RESETS_AVAILABLE, at(12, 0))).toBeNull();
  });
  test('読めぬ刻も枠切れと見ぬ（24 時を超える形）', () => {
    expect(limitedWaitMs('usage limit — resets at 25:99', at(12, 0))).toBeNull();
  });
  test('枠切れでなければ null', () => {
    expect(limitedWaitMs('❯ ', at(12, 0))).toBeNull();
    expect(limitedWaitMs('Working (3s · esc to interrupt)', at(12, 0))).toBeNull();
  });
  test('境目の刻: 12 時間ちょうど前なら過去と読む（もう明けておる）', () => {
    // 今日の 0:00 は 12 時間前、翌日の 0:00 は 12 時間後——同着なら過去を採る。
    // 半日前に明けると告げられた旗は、もう用を終えておる
    expect(limitedWaitMs('usage limit — resets at 0:00', at(12, 0))).toBeNull();
  });
  test('境目の刻: 12 時間を僅かに切れば未来と読む', () => {
    // 今日の 0:00 は 11 時間 59 分前、翌日の 0:00 は 12 時間 1 分後——近いのは過去の側
    expect(limitedWaitMs('usage limit — resets at 0:00', at(11, 59))).toBeNull();
    // 一方 12:01 なら今日の 0:00 は 12 時間 1 分前、翌日は 11 時間 59 分後——未来を採る
    expect(limitedWaitMs('usage limit — resets at 0:00', at(12, 1))).toBe(
      Math.min((11 * 60 + 59) * MIN + 2 * MIN, 6 * 60 * MIN),
    );
  });
  test('12 時の折り返し: 12:30pm と 12:05am', () => {
    expect(limitedWaitMs('usage limit — resets 12:30pm', at(12, 0))).toBe(30 * MIN + 2 * MIN);
    expect(limitedWaitMs('usage limit — try again at 12:05 AM', at(23, 50))).toBe(15 * MIN + 2 * MIN);
  });
});

describe('日付を添えた旗を読む（実物採取 2026-09-20・ashigaru3 の pane・codex）', () => {
  const MIN = 60_000;
  // 実物の字面そのまま。序数の接尾（st）・年・午前午後つき。
  const DATED = 'or try again at Sep 21st, 2026 12:03 AM.';
  // pane の写しの形（尻の数行に旗が居る）
  const PANE =
    'Y■ You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing)\n' +
    `  or visit https://chatgpt.com/codex/settings/usage to purchase more credits ${DATED}\n`;
  const on = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m, 0, 0);

  test('実物の pane の写しから刻が読める（直す前は null であった）', () => {
    // 2026-09-20 21:00 に読むと、明けは 09-21 00:03。待ちは 3 時間 3 分 + 2 分
    expect(limitedWaitMs(PANE, on(20, 21, 0))).toBe((3 * 60 + 3 + 2) * MIN);
  });
  test('日を跨ぐ長い待ちは 6 時間で頭打ち——切れても撃たず、次の周が写し直して待ち直す', () => {
    expect(limitedWaitMs(PANE, on(20, 12, 0))).toBe(6 * 60 * MIN);
  });
  test('日付が正である——「近い方」の推し量りに落ちぬ', () => {
    // 09-21 23:00 に読むと、旗の 09-21 00:03 は 23 時間前。日付を読めば過ぎた旗である。
    // 日付を無視して「近い方」を採れば翌 00:03（1 時間後）と誤読し、撃たずに待ち続ける
    expect(limitedWaitMs(PANE, on(21, 23, 0))).toBeNull();
  });
  test('過ぎた日付つきの旗は枠切れと見ぬ（scroll-back の残骸）', () => {
    expect(limitedWaitMs(PANE, on(22, 9, 0))).toBeNull();
  });
  test('暦に無い日付は枠切れと見ぬ', () => {
    expect(limitedWaitMs('usage limit — try again at Sep 32nd, 2026 1:00 AM.', on(20, 12, 0))).toBeNull();
  });
  test('枠が有る旨の案内は日付つきの筋でも枯渇と読まぬ', () => {
    expect(limitedWaitMs(CLAUDE_RESETS_AVAILABLE, on(20, 12, 0))).toBeNull();
  });
});
