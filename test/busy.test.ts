/**
 * busy 見立ての試験 — 旧 agent_is_busy_check の移植が旧の判定と揃うか。
 *
 * 画面は実機の写しに寄せた作り物。cursor の busy は本試験環境の実測
 * （sleep 300 実行中の pane）から採った。
 */
import { describe, expect, test } from 'bun:test';
import { isBusyText } from '../src/busy';

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
