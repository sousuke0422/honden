/**
 * 顔ぶれの書き戻し。
 *
 * 測るのは三つ——**注釈が残る**、**意図どおりに変わる**、**壊れるなら書かぬ**。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, current, suggestModels, LAUNCHABLE_CLIS } from '../src/rosteredit';

const SRC = `# 頭の注釈
cli:
  default: claude   # 既定
  agents:
    shogun:
      type: claude
      model: claude-opus-5   # 将軍は最上位
    karo:
      type: cursor
      model: auto
    ashigaru1:
      type: claude
      model: claude-fable-5
    ashigaru2:
      type: codex
      model: gpt-5.6-sol
    # gunshi MUST stay last
    gunshi:
      type: claude
      model: claude-sonnet-5

bloom_routing: manual

capability_tiers:
  composer-2.5:
    max_bloom: 4
    cost_group: cursor
  gpt-5.6-luna:
    max_bloom: 4
    cost_group: codex
`;

describe('読む', () => {
  test('行から読んだ顔ぶれは YAML 解きと同じ', () => {
    const doc = Bun.YAML.parse(SRC) as { cli: { agents: Record<string, { type: string; model: string }> } };
    for (const c of current(SRC)) {
      expect(c.cli).toBe(doc.cli.agents[c.id]!.type);
      expect(c.model).toBe(doc.cli.agents[c.id]!.model);
    }
    expect(current(SRC).map((c) => c.id)).toEqual(['shogun', 'karo', 'ashigaru1', 'ashigaru2', 'gunshi']);
  });
});

describe('差し替える', () => {
  test('CLI と模型を変える。**注釈はすべて残る**', () => {
    const r = apply(SRC, { changes: [{ id: 'karo', cli: 'claude', model: 'claude-sonnet-5' }] });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toContain('# 頭の注釈');
    expect(r.text).toContain('default: claude   # 既定');
    expect(r.text).toContain('model: claude-opus-5   # 将軍は最上位');
    expect(r.text).toContain('# gunshi MUST stay last');
    const k = current(r.text).find((c) => c.id === 'karo')!;
    expect(k).toEqual({ id: 'karo', cli: 'claude', model: 'claude-sonnet-5' });
    expect(r.summary).toEqual(['  karo       cursor auto  →  claude claude-sonnet-5']);
  });

  test('値の後ろの注釈は差し替えても残る', () => {
    const r = apply(SRC, { changes: [{ id: 'shogun', model: 'claude-fable-5' }] });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toContain('model: claude-fable-5   # 将軍は最上位');
  });

  test('触らぬ者は一字も変わらぬ', () => {
    const r = apply(SRC, { changes: [{ id: 'karo', cli: 'claude' }] });
    if (!r.ok) throw new Error(r.message);
    const a = SRC.split('\n'), b = r.text.split('\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((x) => x !== null);
    expect(diff).toEqual([8]); // karo の type の行だけ（0 起点）
  });

  test('同じ値なら何もせぬ（要約も空）', () => {
    const r = apply(SRC, { changes: [{ id: 'karo', cli: 'cursor', model: 'auto' }] });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe(SRC);
    expect(r.summary).toEqual([]);
  });

  test('**起こせぬ CLI は拒む**（上流 #156 の欠陥）', () => {
    const r = apply(SRC, { changes: [{ id: 'karo', cli: 'kimi' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('起こせる CLI に無い');
  });

  test('居らぬ者は拒む', () => {
    expect(apply(SRC, { changes: [{ id: 'ashigaru9', cli: 'claude' }] }).ok).toBe(false);
  });
});

describe('頭数', () => {
  test('増やすと軍師の手前に入る。軍師の注釈もその場に残る', () => {
    const r = apply(SRC, {
      workers: 3,
      changes: [{ id: 'ashigaru3', cli: 'codex', model: 'gpt-5.6-luna' }],
    });
    if (!r.ok) throw new Error(r.message);
    expect(current(r.text).map((c) => c.id)).toEqual(['shogun', 'karo', 'ashigaru1', 'ashigaru2', 'ashigaru3', 'gunshi']);
    const i3 = r.text.indexOf('ashigaru3:');
    const ic = r.text.indexOf('# gunshi MUST stay last');
    const ig = r.text.indexOf('gunshi:');
    expect(i3).toBeLessThan(ic);
    expect(ic).toBeLessThan(ig);
  });

  test('増やす分に模型が無ければ拒む（CLI だけ差して黙る事故）', () => {
    const r = apply(SRC, { workers: 3, changes: [{ id: 'ashigaru3', cli: 'codex' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('model も要る');
  });

  test('減らすと後ろから消える。他は残る', () => {
    const r = apply(SRC, { workers: 1, changes: [] });
    if (!r.ok) throw new Error(r.message);
    expect(current(r.text).map((c) => c.id)).toEqual(['shogun', 'karo', 'ashigaru1', 'gunshi']);
    expect(r.text).toContain('# gunshi MUST stay last');
    expect(r.text).not.toContain('gpt-5.6-sol');
  });

  test('範囲の外は拒む', () => {
    expect(apply(SRC, { workers: 0, changes: [] }).ok).toBe(false);
    expect(apply(SRC, { workers: 8, changes: [] }).ok).toBe(false);
  });
});

describe('書く前に読み返す', () => {
  test('cli.agents が無い形は拒む', () => {
    const r = apply('foo: 1\n', { changes: [{ id: 'karo', cli: 'claude' }] });
    expect(r.ok).toBe(false);
  });
});

describe('模型の勧め', () => {
  const doc = Bun.YAML.parse(SRC);
  test('同じ CLI の者の模型と、cost_group の合う段から拾う', () => {
    expect(suggestModels(doc, 'codex', current(SRC)).sort()).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
    expect(suggestModels(doc, 'cursor', current(SRC)).sort()).toEqual(['auto', 'composer-2.5']);
  });
  test('知らぬ CLI には当てずっぽうを出さぬ', () => {
    expect(suggestModels(doc, 'opencode', current(SRC))).toEqual([]);
  });
});

describe('一覧は出陣と揃っている', () => {
  test('**LAUNCHABLE_CLIS と scripts/shutsujin.sh の cli_of は同じ集合**', () => {
    // 上流 #156 は一覧が実態と合わず差し戻された。同じ穴を掘らぬ
    const sh = readFileSync(join(import.meta.dir, '..', 'scripts', 'shutsujin.sh'), 'utf8');
    const i = sh.indexOf('cli_of()');
    expect(i).toBeGreaterThan(0);
    const body = sh.slice(i, sh.indexOf('\n}', i));
    const labels = [...body.matchAll(/^\s+([a-z]+)\)\s+echo/gm)].map((m) => m[1]!).sort();
    expect(labels).toEqual([...LAUNCHABLE_CLIS].sort());
  });
});
