/**
 * honden-bot の review の口——写しの規則の試験。
 *
 * 眼目: 両対応と名乗って片方で黙って落ちる欄を作らぬこと。
 * どの欄がどう写り、どの欄が落ちるかは src/botreview.ts の表が正であり、
 * ここはその表を機械で固定する。
 */
import { describe, expect, test } from 'bun:test';
import {
  parseReviewInput,
  renderGithubReview,
  renderTaskRound,
  summarizeReviews,
  SEVERITY_MARK,
  FINDING_STATES,
} from '../src/botreview';

const SHA = 'a'.repeat(40);

const INPUT = JSON.stringify({
  head_sha: SHA,
  summary: '総括の文である。',
  findings: [
    { severity: 'high', title: '💥 認証が無い', body: '説明。→ 直せ', file: 'src/auth.ts', line: 42 },
    { severity: 'medium', title: '境界が緩い', body: '説明。→ 締めよ', file: 'src/edge.ts', line: 7 },
    { severity: 'low', title: '行の無い指摘', body: '説明。→ 場所は特定できぬ' },
    { severity: 'nit', title: '綴りの揺れ', body: '説明。→ 揃えよ', file: 'README.md' },
  ],
});

describe('入力の検め（読む所は一箇所）', () => {
  test('正しい JSON は通る', () => {
    const r = parseReviewInput(INPUT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.findings.length).toBe(4);
  });

  test('壊れた入力は段名 [入力] つきで止まる', () => {
    for (const [text, hint] of [
      ['not json', 'JSON として読めぬ'],
      ['[]', 'object'],
      [JSON.stringify({ head_sha: 'abc', summary: 'x', findings: [] }), 'head_sha'],
      [JSON.stringify({ head_sha: SHA, summary: '', findings: [] }), 'summary'],
      [JSON.stringify({ head_sha: SHA, summary: 'x' }), 'findings'],
      [JSON.stringify({ head_sha: SHA, summary: 'x', findings: [{ severity: 'critical', title: 't', body: 'b' }] }), 'severity'],
      [JSON.stringify({ head_sha: SHA, summary: 'x', findings: [{ severity: 'high', title: 't', body: 'b', line: 0 }] }), 'line'],
    ] as const) {
      const r = parseReviewInput(text);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.startsWith('[入力]')).toBe(true);
        expect(r.message).toContain(hint);
      }
    }
  });
});

describe('github への写し（欄ごとの規則）', () => {
  const input = (() => {
    const r = parseReviewInput(INPUT);
    if (!r.ok) throw new Error(r.message);
    return r.input;
  })();
  const p = renderGithubReview(input);

  test('head_sha は commit_id へ写る', () => {
    expect(p.commit_id).toBe(SHA);
  });

  test('file+line の揃う指摘だけが inline になり、欠ける指摘は body の列へ（中身は落とさぬ）', () => {
    expect(p.comments.map((c) => c.path)).toEqual(['src/auth.ts', 'src/edge.ts']);
    // line 無しの README.md と file 無しの指摘は body 側に居る
    expect(p.body).toContain('行の無い指摘');
    expect(p.body).toContain('綴りの揺れ');
  });

  test('severity は記号として本文へ写る（題に既に記号があれば添えぬ）', () => {
    // 題の 💥 を活かし、severity の記号を重ねて添えぬ
    expect(p.comments[0]!.body.startsWith('**💥')).toBe(true);
    expect(p.comments[0]!.body.includes(SEVERITY_MARK.high)).toBe(false);
    expect(p.comments[1]!.body.startsWith(SEVERITY_MARK.medium)).toBe(true);
    expect(p.body).toContain(SEVERITY_MARK.low);
    expect(p.body).toContain(SEVERITY_MARK.nit);
  });

  test('state と round は出さぬ（落ちる欄は隠さず落とす）', () => {
    const whole = JSON.stringify(p);
    expect(whole.includes('"state"')).toBe(false);
    expect(whole.includes('"round"')).toBe(false);
  });

  test('event は導出——high/medium が在れば REQUEST_CHANGES、無ければ COMMENT。APPROVE は出さぬ', () => {
    expect(p.event).toBe('REQUEST_CHANGES');
    const mild = parseReviewInput(
      JSON.stringify({ head_sha: SHA, summary: 'x', findings: [{ severity: 'nit', title: 't', body: 'b' }] }),
    );
    if (!mild.ok) throw new Error(mild.message);
    expect(renderGithubReview(mild.input).event).toBe('COMMENT');
    const clean = parseReviewInput(JSON.stringify({ head_sha: SHA, summary: 'x', findings: [] }));
    if (!clean.ok) throw new Error(clean.message);
    expect(renderGithubReview(clean.input).event).toBe('COMMENT');
  });
});

describe('task への写し（語彙が同じゆえそのまま）', () => {
  test('head_sha / summary / findings が欠けず往復する', () => {
    const r = parseReviewInput(INPUT);
    if (!r.ok) throw new Error(r.message);
    const round = JSON.parse(renderTaskRound(r.input)) as Record<string, unknown>;
    expect(round['head_sha']).toBe(SHA);
    expect(round['summary']).toBe('総括の文である。');
    expect((round['findings'] as unknown[]).length).toBe(4);
  });
});

describe('現在地の写し（読む側）', () => {
  test('履歴の数と行を分けて返す——現在値だけで過去を捨てぬ', () => {
    const s = summarizeReviews([
      { state: 'CHANGES_REQUESTED', user: 'a', submittedAt: '2026-09-01' },
      { state: 'APPROVED', user: 'b', submittedAt: '2026-09-02' },
      { state: 'APPROVED', user: 'c', submittedAt: '2026-09-03' },
    ]);
    expect(s.counts['CHANGES_REQUESTED']).toBe(1);
    expect(s.counts['APPROVED']).toBe(2);
    expect(s.lines.length).toBe(3);
  });
});

describe('finding の状態の語彙', () => {
  test('task の五状態と一致する（review resolve --help の実測に合わせる）', () => {
    expect([...FINDING_STATES].sort()).toEqual(['deferred', 'fixed', 'open', 'rejected', 'verified']);
  });
});
