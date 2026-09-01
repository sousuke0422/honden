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

/**
 * 陣ごとの返事を並べた贋の手。何をどう引いたかも控える。
 *
 * `list-sessions`（印を引く問い）と `list-panes` は別に返す。
 * 同じ口で返すと、pane の行を陣の名として読んでしまう。
 */
function fake(
  rows: Record<string, string[]>,
  sessions?: string[],
): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return sessions === undefined ? null : sessions.join('\n');
    const i = args.indexOf('-t');
    const target = i >= 0 ? args[i + 1]! : '';
    const r = rows[target];
    return r === undefined ? null : r.join('\n');
  };
  return { run, calls };
}

/** `#{session_name}\t#{@honden}` の一行。 */
const sess = (name: string, mark = '') => `${name}\t${mark}`;

/** その場だけ `HONDEN_ROOT` を立てる。 */
function withRoot<T>(v: string | undefined, f: () => T): T {
  const had = process.env.HONDEN_ROOT;
  if (v === undefined) delete process.env.HONDEN_ROOT;
  else process.env.HONDEN_ROOT = v;
  try {
    return f();
  } finally {
    if (had === undefined) delete process.env.HONDEN_ROOT;
    else process.env.HONDEN_ROOT = had;
  }
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

  test('射程が無く、印の付いた陣も無ければ全てを見る（-a）', () => {
    const f = fake({ '': [KARO] }, [sess('multiagent'), sess('shogun')]);
    withRoot(undefined, () => panes('', f.run));
    const panecall = f.calls.find((c) => c[0] === 'list-panes')!;
    expect(panecall).toContain('-a');
    expect(panecall).not.toContain('-s');
  });

  test('同じ名が二つの陣に居れば、後に引いた陣が勝つ（絞りが要る理由）', () => {
    const f = fake({
      honden: [row('%7', 'honden:agents.0', 'karo')],
      multiagent: [KARO],
    });
    expect(panes('honden,multiagent', f.run).get('karo')?.id).toBe('%1');
  });
});


/**
 * 並走（旧環境と honden を同時に動かす）で要る絞り。
 *
 * 実地で陣が八つ並び、`shogun` の名が三つの陣に重複していた（2026-09-01）。
 * `-a` は後勝ちゆえ、将軍宛の合図が古い試験の陣へ落ちる。
 *
 * 出陣は陣を立てた折に `@honden` へ置き場を書き込む。外側の shell は既に
 * この印で芯・耳・窓を接ぐか決めていた。**芯だけが見ていなかった。**
 */
describe('panes — 印（@honden）で我らの陣だけを見る', () => {
  const OTHER = row('%5', 'multiagent:agents.0', 'shogun'); // 旧環境の将軍

  test('印の付いた陣だけを引く（印無き陣は見ぬ）', () => {
    const f = fake(
      { honden: [SHOGUN], multiagent: [OTHER] },
      [sess('honden', '/w/honden'), sess('multiagent')],
    );
    const m = withRoot(undefined, () => panes('', f.run));
    expect(m.get('shogun')?.id).toBe('%0'); // 旧環境の %5 ではない
    const targets = f.calls.filter((c) => c[0] === 'list-panes').map((c) => c[c.indexOf('-t') + 1]);
    expect(targets).toEqual(['honden']);
  });

  test('**陰性対照** — 印が付いていれば旧環境の陣も見てしまう', () => {
    // 絞りが効いていることの証。印を付け替えれば結果が動く。
    const f = fake(
      { honden: [SHOGUN], multiagent: [OTHER] },
      [sess('honden', '/w/honden'), sess('multiagent', '/w/honden')],
    );
    expect(withRoot(undefined, () => panes('', f.run)).get('shogun')?.id).toBe('%5');
  });

  test('置き場が判っておれば、他所の honden の陣は外す', () => {
    // 一つの機で二つの honden を走らせる筋がある。
    const f = fake(
      { ours: [SHOGUN], theirs: [OTHER] },
      [sess('ours', '/w/honden'), sess('theirs', '/w/another')],
    );
    const m = withRoot('/w/honden', () => panes('', f.run));
    expect(m.get('shogun')?.id).toBe('%0');
  });

  test('明示の射程は印より強い（試験の布陣を絞る筋を壊さぬ）', () => {
    const f = fake({ multiagent: [OTHER] }, [sess('honden', '/w/honden')]);
    expect(withRoot(undefined, () => panes('multiagent', f.run)).get('shogun')?.id).toBe('%5');
  });

  test('tmux が居らねば -a へ戻す（引けぬと空は別物）', () => {
    const f = fake({ '': [KARO] }); // list-sessions は null
    withRoot(undefined, () => panes('', f.run));
    expect(f.calls.find((c) => c[0] === 'list-panes')).toContain('-a');
  });
});
