/**
 * 投入前の検めの試験。
 *
 * この層が守るのは**書き写す時の誤り**である。書式のずれではない——
 * 後から走らせるスキルが、己の指摘を己で構造へ移す形ゆえ、
 * 落とし・言い換え・作り足しが起きる。人の目では十件のうち一件消えても
 * 気づけぬゆえ、機械が数える。
 */
import { describe, expect, test } from 'bun:test';
import {
  SEVERITIES, BADGE_TO_SEVERITY, COLLAPSED_BADGE, SHA_RE,
  parseTally, tallyOf, checkFinding, check, render,
} from '../src/review';

const SHA = 'a'.repeat(40);
const ok1 = { severity: 'high', title: '認証が無い', body: '説明' };
const payload = (o: Record<string, unknown> = {}) => ({ head_sha: SHA, findings: [ok1], ...o });

describe('重大度 — 投入先の約定', () => {
  test('四段階。**critical は無い**', () => {
    expect([...SEVERITIES]).toEqual(['high', 'medium', 'low', 'nit']);
    expect((SEVERITIES as readonly string[]).includes('critical')).toBe(false);
  });

  test('印の対応。**💥 と 🚨 が high へ潰れる**', () => {
    expect(BADGE_TO_SEVERITY['💥']).toBe('high');
    expect(BADGE_TO_SEVERITY['🚨']).toBe('high');
    expect(BADGE_TO_SEVERITY['🔴']).toBe('medium');
    expect(BADGE_TO_SEVERITY['🟡']).toBe('low');
    expect(BADGE_TO_SEVERITY['🔵']).toBe('nit');
  });

  test('🟡 は low であって medium ではない（マージを止める側へ寄せぬ）', () => {
    // task では medium がマージを止める。🟡 はレビュー自身が「改善推奨」と
    // 言うておる物ゆえ、上へ寄せると**表の中に隠れた方針変更**になる
    expect(BADGE_TO_SEVERITY['🟡']).toBe('low');
  });
});

describe('parseTally — 申告を解く', () => {
  test('読める', () => {
    const r = parseTally('high=2,medium=3');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tally).toEqual({ high: 2, medium: 3 });
  });

  test('空白と末尾の読点を許す', () => {
    const r = parseTally(' high=1 , nit=0 ,');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tally).toEqual({ high: 1, nit: 0 });
  });

  test('**知らぬ名は捨てず、落第にする**（捨てれば突き合わせが素通りになる）', () => {
    const r = parseTally('critical=1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('critical');
  });

  test('形が違えば落第', () => {
    expect(parseTally('high').ok).toBe(false);
    expect(parseTally('high=x').ok).toBe(false);
    expect(parseTally('').ok).toBe(false);
  });
});

describe('head_sha — 短縮を通さぬ', () => {
  test('40 桁の小文字 16 進なら通る', () => {
    expect(SHA_RE.test(SHA)).toBe(true);
    expect(check(payload()).ok).toBe(true);
  });

  test('**短縮は弾く**（そのラウンドが永久に通らなくなるゆえ）', () => {
    const r = check(payload({ head_sha: 'a'.repeat(7) }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.where === 'head_sha')).toBe(true);
    // 取り方まで告げる。honden の定めと同じ結論である
    expect(r.problems.find((p) => p.where === 'head_sha')!.what).toContain('rev-parse');
  });

  test('大文字も 64 桁も弾く（いまの投入先は 40 桁のみ）', () => {
    expect(check(payload({ head_sha: 'A'.repeat(40) })).ok).toBe(false);
    expect(check(payload({ head_sha: 'a'.repeat(64) })).ok).toBe(false);
  });

  test('欠けておれば要ると言う', () => {
    expect(check({ findings: [ok1] }).ok).toBe(false);
  });
});

describe('一件ずつの検め — 添字を必ず添える', () => {
  test('どの指摘のどの欄かが分かる', () => {
    const p = checkFinding({ severity: 'high', title: '', body: 'b' }, 3);
    expect(p[0]!.where).toBe('findings[3].title');
  });

  test('**critical はここで死ぬ**（投入先が受けぬ綴りを手前で止める）', () => {
    const p = checkFinding({ severity: 'critical', title: 't', body: 'b' }, 0);
    expect(p.some((x) => x.what.includes('critical'))).toBe(true);
  });

  test('題と本文は要る', () => {
    expect(checkFinding({ severity: 'high', title: 't' }, 0).some((p) => p.where.endsWith('body'))).toBe(true);
    expect(checkFinding({ severity: 'high', body: 'b' }, 0).some((p) => p.where.endsWith('title'))).toBe(true);
    expect(checkFinding({ severity: 'high', title: '   ', body: 'b' }, 0).length).toBeGreaterThan(0);
  });

  test('行は整数（小数・零・負を通さぬ）', () => {
    for (const line of [1.5, 0, -3, '10']) {
      expect(checkFinding({ severity: 'high', title: 't', body: 'b', line }, 0).length).toBeGreaterThan(0);
    }
    expect(checkFinding({ severity: 'high', title: 't', body: 'b', line: 12 }, 0)).toEqual([]);
  });

  test('物でない物を渡されても壊れぬ', () => {
    expect(checkFinding('文字列', 0).length).toBe(1);
    expect(checkFinding(null, 0).length).toBe(1);
  });
});

describe('💥 の印 — 潰した先を取り違えぬ', () => {
  test('💥 が付いておるのに high でなければ落第', () => {
    const r = check(payload({ findings: [{ severity: 'medium', title: '💥 認証が無い', body: 'b' }] }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.what.includes('Critical は high'))).toBe(true);
  });

  test('💥 で high なら通る', () => {
    expect(check(payload({ findings: [{ severity: 'high', title: `${COLLAPSED_BADGE} 認証が無い`, body: 'b' }] })).ok).toBe(true);
  });

  test('印が無ければ問わぬ（🚨 High も high ゆえ見分けは要らぬ）', () => {
    expect(check(payload({ findings: [{ severity: 'high', title: '認証が無い', body: 'b' }] })).ok).toBe(true);
  });
});

describe('件数の突き合わせ — 落とし・作り足しを捕らえる', () => {
  const three = [
    { severity: 'high', title: 'a', body: 'b' },
    { severity: 'medium', title: 'c', body: 'd' },
    { severity: 'medium', title: 'e', body: 'f' },
  ];

  test('数える', () => {
    expect(tallyOf(three as never)).toEqual({ high: 1, medium: 2 });
  });

  test('申告と合えば通る', () => {
    expect(check(payload({ findings: three }), { high: 1, medium: 2 }).ok).toBe(true);
  });

  test('**一件落とせば捕らえる**', () => {
    const r = check(payload({ findings: three.slice(0, 2) }), { high: 1, medium: 2 });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.where.includes('medium'))).toBe(true);
  });

  test('**無い物を足しても捕らえる**', () => {
    const r = check(payload({ findings: [...three, { severity: 'nit', title: 'x', body: 'y' }] }), {
      high: 1, medium: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.where.includes('nit'))).toBe(true);
  });

  test('申告を渡さねば、その検めは行わぬ', () => {
    // **「申告しておらぬ」と「申告が合うた」を混ぜぬ**
    expect(check(payload({ findings: three })).ok).toBe(true);
    expect(render(check(payload({ findings: three })))).toContain('申告は渡されておらぬ');
  });
});

describe('findings の形', () => {
  test('一覧でなければ落第', () => {
    expect(check({ head_sha: SHA, findings: {} }).ok).toBe(false);
    expect(check({ head_sha: SHA }).ok).toBe(false);
  });

  test('**指摘ゼロは正当**（空の一覧で通る）', () => {
    const r = check({ head_sha: SHA, findings: [] }, {});
    expect(r.ok).toBe(true);
  });
});

describe('render — 通った時も件数を出す', () => {
  test('黙って通さぬ（検めたことが見えねば、検めておらぬのと同じ）', () => {
    const out = render(check(payload(), { high: 1 }), { high: 1 });
    expect(out).toContain('通った');
    expect(out).toContain('high=1');
  });

  test('落ちた時は、どこが悪いかを並べる', () => {
    const out = render(check(payload({ head_sha: 'x' })));
    expect(out).toContain('投入せぬ');
    expect(out).toContain('head_sha');
  });
});
