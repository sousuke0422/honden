/**
 * 構造の層の試験——**紋様の錨が破れておった六つ**を釘で留める。
 *
 * 紋様の `(?:^|[;&|]\s*)` は命令位置の近似にすぎなんだ。実測（2026-08-30）で
 * 絶対域の D001 が六つの形で素通りしておった。構造なら近似が要らぬ——
 * 単純命令ひとつが一つの単位であり、その先頭が命令位置そのものである。
 *
 * ここが緑である限り、その六つは戻らぬ。
 */
import { describe, expect, test } from 'bun:test';
import { judge, judgeStructured, splitOtp } from '../src/guard';
import { realRunner } from '../src/parse';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const run = realRunner(ROOT);
const deny = (cmd: string) => judgeStructured(cmd, run).permission === 'deny';

describe('紋様が取りこぼしておった形', () => {
  // 一つずつ、**紋様では通り、構造では止まる**ことを対で示す。
  // 片方だけでは「元から止まっておった」のか「構造が効いた」のか判じられぬ。
  const escapes: [string, string][] = [
    ['改行で継ぐ', 'ls\nrm -rf /'],
    ['if … then の中', 'if true; then rm -rf /; fi'],
    ['命令置換の中', 'x=$(rm -rf /)'],
    ['for … do の中', 'for f in a; do rm -rf /; done'],
    ['波括弧の中', '{ rm -rf /; }'],
    ['while … do の中', 'while true; do rm -rf /; done'],
  ];

  for (const [name, cmd] of escapes) {
    test(`${name}: 紋様は通し、構造は止める`, () => {
      expect(judge(cmd).permission, '紋様が既に止めておるなら、この試験は検出器でない').toBe('allow');
      expect(deny(cmd), `構造で止まらねばならぬ: ${cmd}`).toBe(true);
    });
  }
});

describe('通すべきものは通る（誤検知を出さぬ）', () => {
  const fine = [
    'echo rm -rf /',              // 命ではなく echo の引数
    'grep -rn "rm -rf /" docs/',  // 引用された字面
    'ls -la',
    'git status',
    'rm -rf .tmp/work',           // 明示の道
    'rm -rf node_modules',
  ];
  for (const cmd of fine) {
    test(`通す: ${cmd}`, () => expect(deny(cmd)).toBe(false));
  }
});

describe('解けぬ命は拒む（知らぬ形を通さぬ）', () => {
  test('壊れた入力', () => {
    const v = judgeStructured('some !! invalid <<< ((( garbage', run);
    expect(v.permission).toBe('deny');
    expect(v.rule).toBe('D000');
  });

  test('解き手が居らねば拒む（道具の不在を素通しにせぬ）', () => {
    const v = judgeStructured('ls', () => ({ ok: false, stdout: '' }));
    expect(v.permission).toBe('deny');
    expect(v.rule).toBe('D000');
  });

  test('D000 は直訴できる（解ける形に書き直せば済む話ゆえ）', () => {
    expect(judgeStructured('ls', () => ({ ok: false, stdout: '' })).appealable).not.toBe(false);
  });
});

describe('整形が構文を壊さぬこと', () => {
  // **これを見落として一巡した。** normalize は紋様のために改行を空白へ潰す。
  // 潰した文字列を parser へ食わせると `ls⏎rm -rf /` が `ls rm -rf /`
  // （ただの ls）に化け、根を消す命が消えて見えた。
  test('splitOtp は生の姿も返す', () => {
    const s = splitOtp('ls\nrm -rf /');
    expect(s.cmd).toBe('ls rm -rf /');   // 紋様用は潰れておってよい
    expect(s.raw).toBe('ls\nrm -rf /');  // 構文用は生のまま
  });

  test('札を剥いだ後も生の姿が保たれる', () => {
    const s = splitOtp('HONDEN_OTP=abc123 ls\nrm -rf /');
    expect(s.otp).toBe('abc123');
    expect(s.raw).toContain('\n');
    expect(s.raw).not.toContain('HONDEN_OTP');
  });

  test('生を解かせておる（潰した方を解けば、この形は通ってしまう）', () => {
    const s = splitOtp('ls\nrm -rf /');
    expect(judgeStructured(s.cmd, run, s.raw).permission).toBe('deny');
    // 陽性対照: 潰した方だけを解けば通る——これが一巡した理由である
    expect(judgeStructured(s.cmd, run, s.cmd).permission).toBe('allow');
  });
});

describe('heredoc は貰い手で分ける', () => {
  test('python への heredoc は命ではない（将軍が二度弾かれた形）', () => {
    expect(deny("python3 <<'EOF'\nrm -rf /\nEOF\n")).toBe(false);
  });

  test('bash への heredoc は命である', () => {
    expect(deny("bash <<'EOF'\nrm -rf /\nEOF\n")).toBe(true);
  });
});
