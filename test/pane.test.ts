/**
 * 本物の `panes()` の試験。
 *
 * `test/nudge.test.ts` は pane の一覧を**手で注入**する。速くて良いが、
 * **tmux の絞り込みが一度も試されぬ**——将軍へ合図が届かぬ穴（2026-08-29）は
 * その隙間に住んでおった。
 *
 * ここでは tmux を叩く手を注ぎ替え、`panes()` が何をどう引くかを検める。
 * 本物の tmux を使う分は tests/panes.bats が受け持つ（二陣構成の実測）。
 */
import { describe, expect, test } from 'bun:test';
import { panes, type TmuxRunner } from '../src/pane';

const row = (id: string, label: string, agent: string) => `${id}\t${label}\t${agent}`;

/** 陣ごとの返事を並べた贋の手。何をどう引いたかも控える。 */
function fake(rows: Record<string, string[]>): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = (args) => {
    calls.push(args);
    const i = args.indexOf('-t');
    const target = i >= 0 ? args[i + 1]! : '';
    const r = rows[target];
    return r === undefined ? null : r.join('\n');
  };
  return { run, calls };
}

const KARO = row('%1', 'multiagent:agents.0', 'karo');
const SHOGUN = row('%0', 'shogun:main.0', 'shogun');

describe('panes — 射程の切り方', () => {
  test('一つの陣を渡せば、その陣だけを引く', () => {
    const f = fake({ multiagent: [KARO] });
    expect([...panes('multiagent', f.run).keys()]).toEqual(['karo']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('-s');
  });

  test('読点で区切れば複数の陣を引き、混ぜて返す', () => {
    // **これが穴であった。** 将軍は別の陣に住むゆえ、働き手の陣だけでは落ちる。
    const f = fake({ multiagent: [KARO], shogun: [SHOGUN] });
    const m = panes('multiagent,shogun', f.run);
    expect([...m.keys()].sort()).toEqual(['karo', 'shogun']);
    expect(m.get('shogun')?.id).toBe('%0');
    expect(f.calls).toHaveLength(2);
  });

  test('陰性対照——片方だけなら将軍は落ちる', () => {
    const f = fake({ multiagent: [KARO], shogun: [SHOGUN] });
    expect(panes('multiagent', f.run).has('shogun')).toBe(false);
  });

  test('空白混じりの読点でも受ける', () => {
    const f = fake({ multiagent: [KARO], shogun: [SHOGUN] });
    expect(panes('multiagent, shogun', f.run).has('shogun')).toBe(true);
  });

  test('片方の陣が引けずとも、もう片方は返る', () => {
    const f = fake({ multiagent: [KARO] }); // 「居らぬ陣」は null
    expect([...panes('multiagent,居らぬ陣', f.run).keys()]).toEqual(['karo']);
  });

  test('@agent_id の無いペインは数に入らぬ', () => {
    const f = fake({ multiagent: [KARO, row('%9', 'multiagent:viewer.0', '')] });
    expect([...panes('multiagent', f.run).keys()]).toEqual(['karo']);
  });

  test('射程を渡さねば全ての陣を見る（-a）', () => {
    const f = fake({ '': [KARO] });
    panes('', f.run);
    expect(f.calls[0]).toContain('-a');
    expect(f.calls[0]).not.toContain('-s');
  });

  test('同じ名が二つの陣に居れば、後に引いた陣が勝つ（絞りが要る理由）', () => {
    const f = fake({
      honden: [row('%7', 'honden:agents.0', 'karo')],
      multiagent: [KARO],
    });
    expect(panes('honden,multiagent', f.run).get('karo')?.id).toBe('%1');
  });
});
