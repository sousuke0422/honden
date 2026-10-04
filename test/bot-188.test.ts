/**
 * #33 の二本目のレビュー（REQUEST CHANGES）の二件。
 *
 *   一、task 宛ての review submit に --repo を渡すと、黙って無視されておった。
 *       task CLI の review submit に repo の口は無い。拒み、task CLI を起こさぬ。
 *   二、GitHub の review の本文へ移した指摘から file・line が消えておった。
 *       持っておる位置を添える。
 *
 * 実の GitHub と task へは撃たぬ——task CLI を起こす手は spy である。
 */
import { describe, expect, test } from 'bun:test';
import { reviewSubmitTask } from '../src/botmain';
import { parseReviewInput, renderGithubReview } from '../src/botreview';

const SHA = 'a'.repeat(40);
const input = (findings: unknown[]) => {
  const r = parseReviewInput(JSON.stringify({ head_sha: SHA, summary: '総括。', findings }));
  if (!r.ok) throw new Error(r.message);
  return r.input;
};

const harness = (flags: Record<string, string>) => {
  const runs: string[][] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const code = reviewSubmitTask({
    flags,
    pr: 7,
    input: input([{ severity: 'low', title: '指摘', body: '説明' }]),
    dryRun: false,
    actor: 'karo',
    gate: () => ({ ok: true, bin: ['task'], project: 'TASK' }),
    run: (argv) => {
      runs.push(argv);
      return 0;
    },
    out: (l) => out.push(l),
    err: (l) => errs.push(l),
    audit: () => {},
  });
  return { code, runs, out, errs };
};

describe('一、task 宛ての --repo を拒む', () => {
  test('--repo を渡すと EXIT_INVALID で、task CLI は一度も起こされぬ', () => {
    const { code, runs, out, errs } = harness({ to: 'task', repo: 'o/r', project: 'TASK' });
    expect(code).toBe(2);
    expect(runs).toEqual([]);
    expect(out).toEqual([]);
    // 拒みの文は二行とも err の口へ出る（console.error を差し替えずに見る）
    const text = errs.join('\n');
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('[入力]');
    expect(text).toContain('--project');
    expect(text).toContain('repo の口');
  });

  test('--repo 無しの task 宛ては今のまま通り、task CLI へ --project と --pr が渡る', () => {
    const { code, runs, errs } = harness({ to: 'task', project: 'TASK' });
    expect(code).toBe(0);
    expect(errs).toEqual([]);
    expect(runs).toEqual([['task', 'review', 'submit', '-', '--project', 'TASK', '--pr', '7']]);
  });
});

describe('二、本文へ移した指摘に位置を添える', () => {
  const bodyOf = (f: Record<string, unknown>) => renderGithubReview(input([f])).body;

  test('file だけの指摘は file を位置として添える', () => {
    const body = bodyOf({ severity: 'nit', title: '綴りの揺れ', body: '説明。→ 揃えよ', file: 'README.md' });
    expect(body).toContain('- 🔵 **綴りの揺れ**（`README.md`）\n  \n  説明。→ 揃えよ');
  });

  test('line だけの指摘は line を位置として添える', () => {
    const body = bodyOf({ severity: 'low', title: '行だけの指摘', body: '説明', line: 42 });
    expect(body).toContain('- 🟡 **行だけの指摘**（42 行）\n  \n  説明');
  });

  test('file も line も無い指摘は何も足さぬ（今の形のまま）', () => {
    const body = bodyOf({ severity: 'low', title: '場所の無い指摘', body: '説明' });
    expect(body).toContain('- 🟡 **場所の無い指摘**\n  \n  説明');
    expect(body).not.toContain('（');
  });

  test('inline の指摘の形は変えぬ（位置は path/line の欄が持つ）', () => {
    const r = renderGithubReview(input([{ severity: 'high', title: '認証が無い', body: '説明', file: 'src/a.ts', line: 3 }]));
    expect(r.comments).toEqual([{ path: 'src/a.ts', line: 3, body: '🚨 **認証が無い**\n\n説明' }]);
  });
});
