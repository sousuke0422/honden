/**
 * 叩かれた壁の数え方の試験。
 *
 * 肝は**誤検知と注入を取り違えぬこと**。数だけでは同じに見える二つを、
 * 散らばり（担い手の数・命の形の数・直訴の帰結）で分ける。
 */
import { describe, expect, test } from 'bun:test';
import { shapeOf, ruleOf, tally, render, MIN_HITS, type LedgerRow } from '../src/denials';

const deny = (actor: string, rule: string, cmd: string): LedgerRow => ({
  actor,
  action: 'guard.deny',
  target: rule,
  detail: cmd,
  at: '2026-08-29T00:00:00Z',
});
const appeal = (actor: string, rule: string): LedgerRow => ({
  actor,
  action: 'guard.appeal',
  target: 'shogun',
  detail: `rule=${rule} cmd="x"`,
  at: '2026-08-29T00:00:00Z',
});
const grant = (rule: string): LedgerRow => ({
  actor: 'shogun',
  action: 'guard.grant',
  target: 'ashigaru1',
  detail: `rule=${rule} cmd_hash=abc reason="訳" ttl_ms=600000`,
  at: '2026-08-29T00:00:00Z',
});

describe('shapeOf — 命の粗い括り', () => {
  test('道や旗は形に採らぬ（引数違いで別物に見せぬ）', () => {
    expect(shapeOf('cat ~/.shogun/github-app/app.pem')).toBe('cat');
    expect(shapeOf('cat /etc/passwd')).toBe('cat');
    expect(shapeOf('rm -rf /')).toBe('rm');
  });

  test('副命令は形に採る（tmux send-keys と tmux kill-pane は別物）', () => {
    expect(shapeOf('tmux send-keys -t %9 x')).toBe('tmux send-keys');
    expect(shapeOf('tmux kill-pane -t %9')).toBe('tmux kill-pane');
    expect(shapeOf('git push --force')).toBe('git push');
  });

  test('引数が違うても同じ形に畳まれる（注入の繰り返しを見逃さぬため）', () => {
    expect(shapeOf('cat /a/app.pem')).toBe(shapeOf('cat /b/app.pem'));
  });

  test('空でも壊れぬ', () => {
    expect(shapeOf('   ')).toBe('(空)');
  });
});

describe('ruleOf — 直訴と手形から条を拾う', () => {
  test('detail の rule= を読む', () => {
    expect(ruleOf('rule=D015 cmd_hash=abc')).toBe('D015');
    expect(ruleOf('cmd_hash=abc rule=D014 ttl_ms=1')).toBe('D014');
  });
  test('無ければ undefined（条を控えぬ古い記録は数えぬ）', () => {
    expect(ruleOf('cmd_hash=abc reason="x"')).toBeUndefined();
    expect(ruleOf(null)).toBeUndefined();
  });
});

describe('tally — 見分け', () => {
  test('多くの者が様々な形で叩けば、条を疑う', () => {
    const t = tally([
      deny('ashigaru1', 'D014', 'tmux send-keys -t %1 x'),
      deny('ashigaru2', 'D014', 'tmux kill-pane -t %2'),
      deny('gunshi', 'D014', 'tmux paste-buffer -t %3'),
    ])[0]!;
    expect(t.verdict).toBe('rule');
    expect(t.actors).toHaveLength(3);
    expect(t.shapes).toHaveLength(3);
    expect(t.note).toContain('条を疑え');
  });

  test('一人が同じ形を繰り返せば、その者を見る', () => {
    const t = tally([
      deny('ashigaru3', 'D015', 'cat /a/app.pem'),
      deny('ashigaru3', 'D015', 'cat /b/app.pem'),
      deny('ashigaru3', 'D015', 'cat /c/app.pem'),
    ])[0]!;
    expect(t.verdict).toBe('actor');
    expect(t.actors).toEqual(['ashigaru3']);
    expect(t.shapes).toEqual(['cat']); // 引数違いは同じ形
    expect(t.note).toContain('その者を見よ');
  });

  test(`叩きが ${MIN_HITS} 未満なら疑いを述べぬ（門を萎えさせぬ）`, () => {
    const t = tally([deny('ashigaru1', 'D006', 'tmux kill-session -t x')])[0]!;
    expect(t.verdict).toBe('quiet');
    expect(t.hits).toBe(1);
  });

  test('直訴が通り続ける条は、叩きの数を待たず疑う（答えが常に諾の問い）', () => {
    const t = tally([
      deny('ashigaru1', 'D009', 'git add -f x'),
      appeal('ashigaru1', 'D009'),
      grant('D009'),
      appeal('ashigaru2', 'D009'),
      grant('D009'),
    ])[0]!;
    expect(t.verdict).toBe('rule');
    expect(t.grants).toBe(2);
    expect(t.appeals).toBe(2);
    expect(t.note).toContain('直訴が通り続け');
  });

  test('一人だが形が様々なら様子見（どちらとも決めつけぬ）', () => {
    const t = tally([
      deny('ashigaru1', 'D014', 'tmux send-keys -t %1 x'),
      deny('ashigaru1', 'D014', 'tmux kill-pane -t %2'),
      deny('ashigaru1', 'D014', 'tmux run-shell id'),
    ])[0]!;
    expect(t.verdict).toBe('watch');
  });

  test('疑わしい条が先に並ぶ', () => {
    const rows = [
      deny('a1', 'D006', 'tmux kill-session -t x'), // quiet（1 回）
      deny('a1', 'D014', 'tmux send-keys -t %1 x'),
      deny('a2', 'D014', 'tmux kill-pane -t %2'),
      deny('a3', 'D014', 'tmux run-shell id'),      // rule
    ];
    expect(tally(rows).map((t) => t.rule)).toEqual(['D014', 'D006']);
  });

  test('条を控えぬ手形は数に入らぬ（古い記録で誤らぬ）', () => {
    const old: LedgerRow = { actor: 'shogun', action: 'guard.grant', target: 'a1', detail: 'cmd_hash=abc', at: 'x' };
    const t = tally([deny('a1', 'D015', 'cat /a/app.pem'), old])[0]!;
    expect(t.grants).toBe(0);
  });
});

describe('render', () => {
  test('何も無い時は、無いことの意味まで言う', () => {
    const out = render([]).join('\n');
    expect(out).toContain('なし');
    // **ここが肝。** 門が外れておっても拒みは 0 になる。
    expect(out).toContain('門が生きておることの証ではない');
    expect(out).toContain('gate');
  });

  test('条ごとに一行、見立てつきで出る', () => {
    const out = render(tally([
      deny('a1', 'D014', 'tmux send-keys -t %1 x'),
      deny('a2', 'D014', 'tmux kill-pane -t %2'),
      deny('a3', 'D014', 'tmux run-shell id'),
    ])).join('\n');
    expect(out).toContain('D014');
    expect(out).toContain('条を疑え');
    expect(out).toContain('⚠ 条');
  });
});
