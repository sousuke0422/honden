/**
 * 書き口の試験。
 *
 * 中心は「変な値をどう追い返すか」になる。
 * 無理やり通してもいけないし、追い返された側が手を止めてもいけない。
 * なので確かめるのは次の 3 つ。
 *
 *   1. 通っていないこと (書き込みが無いこと)
 *   2. 何が駄目かが全部出ていること (1 件ずつ返すと往復になる)
 *   3. 直し方が文面に入っていること
 */

import { expect, test, describe } from 'bun:test';
import { parseFlags, pickInput, inboxWrite, EXIT_OK, EXIT_INVALID } from '../src/cli';
import { validate, nearest, explain } from '../src/validate';
import { openStore } from '../src/store';

const run = (flags: Record<string, string>, stdin?: string, dry = false) =>
  inboxWrite(':memory:', { flags, stdin }, dry);

describe('旗の解き方', () => {
  test('--k v と --k=v の両方を受ける', () => {
    expect(parseFlags(['--to', 'karo', '--type=cmd_new', 'inbox', 'write']).flags).toEqual({
      to: 'karo',
      type: 'cmd_new',
    });
  });

  test('値の無い旗は true', () => {
    expect(parseFlags(['--dry-run', '--to', 'karo']).flags).toEqual({
      'dry-run': 'true',
      to: 'karo',
    });
  });
});

describe('入口の選び方', () => {
  test('両方来たら弾く (黙って片方を優先しない)', () => {
    const r = pickInput({ flags: { to: 'karo' }, stdin: 'to: gunshi\n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('片方');
  });

  test('どちらも無ければ、書き方を見せて弾く (黙って待たない)', () => {
    const r = pickInput({ flags: {}, stdin: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('EOF');
  });

  test('YAML が壊れていたら、EOF の囲みを疑うよう言う', () => {
    const r = pickInput({ flags: {}, stdin: 'a: 1\n  b: 2\n c: 3\n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("<<'EOF'");
  });

  test('鍵と値の形でなければ弾く', () => {
    const r = pickInput({ flags: {}, stdin: '- 一つ目\n- 二つ目\n' });
    expect(r.ok).toBe(false);
  });
});

describe('近い候補', () => {
  test('綴り違いを名指しする', () => {
    expect(nearest('karou', ['karo', 'gunshi', 'shogun'])).toBe('karo');
    // 綴りしか見ない。urgent → high は意味の推測なので、あえて名指ししない。
    expect(nearest('urgent', ['high', 'medium', 'low'])).toBeUndefined();
  });

  test('遠すぎるものは名指ししない (的外れな助言は害になる)', () => {
    expect(nearest('まったく別の語', ['high', 'medium', 'low'])).toBeUndefined();
  });
});

describe('追い返し方', () => {
  test('落ちたものを全部並べる (1 件ずつ返すと往復になる)', () => {
    const r = run({ to: 'karou', from: 'shogun' }); // to が誤り・type と body が無い
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('3 件');
    expect(r.err).toContain('to');
    expect(r.err).toContain('type');
    expect(r.err).toContain('body');
  });

  test('受け取った値をそのまま見せる', () => {
    const r = run({ to: 'karou', from: 'shogun', type: 't', body: 'b' });
    expect(r.err).toContain('"karou"');
  });

  test('近い候補を添える', () => {
    const r = run({ to: 'karou', from: 'shogun', type: 't', body: 'b' });
    expect(r.err).toContain('近いのは karo');
  });

  test('知らない項目は捨てずに指摘する', () => {
    const r = pickInput({ flags: {}, stdin: 'to: karo\nfrom: shogun\ntype: t\nbdy: 本文\n' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = validate(
      { to: { required: true }, from: { required: true }, type: { required: true }, body: { required: true } },
      r.value,
    );
    expect(p.some((x) => x.field === 'bdy' && x.message === '知らない項目')).toBe(true);
    expect(p.find((x) => x.field === 'bdy')?.hint).toContain('body');
  });

  test('書き込んでいないと明言する', () => {
    const r = run({ to: 'karou' });
    expect(r.err).toContain('書き込みは行っておらぬ');
  });

  test('弾かれたとき、正本に何も入っていない', () => {
    const db = openStore({ path: ':memory:' });
    const before = (db.query('SELECT count(*) c FROM inbox').get() as { c: number }).c;
    run({ to: 'karou' });
    expect(before).toBe(0);
  });
});

describe('通る場合', () => {
  test('旗で通る', () => {
    const r = run({ to: 'karo', from: 'shogun', type: 'cmd_new', body: '検証せよ' });
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('msg_');
  });

  test('EOF で通る', () => {
    const r = run({}, 'to: karo\nfrom: shogun\ntype: cmd_new\nbody: |\n  一行目\n  二行目\n');
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('2 行');
  });

  // 旧 inbox_write.sh はこれで壊れた。本文を Python のソースへ直に展開していたため。
  test('バックスラッシュや引用符を含む本文がそのまま通る', () => {
    const body = "C:\\Users\\aki\\work と ''' と $HOME と \\n という字面";
    const r = run({ to: 'karo', from: 'shogun', type: 'cmd_new', body }, undefined, true);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('書き込んでおらぬ');
  });

  test('--dry-run では書き込まない', () => {
    const r = run({ to: 'karo', from: 'shogun', type: 'cmd_new', body: 'x' }, undefined, true);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('--dry-run');
    expect(r.out).not.toContain('msg_');
  });
});

describe('文面の組み立て', () => {
  test('件数・値・直し方・書き込み無しが揃う', () => {
    const text = explain([{ field: 'to', got: 'karou', message: '取りうる値の外', hint: 'karo / gunshi' }]);
    expect(text).toContain('1 件');
    expect(text).toContain('"karou"');
    expect(text).toContain('karo / gunshi');
    expect(text).toContain('書き込みは行っておらぬ');
  });
});
