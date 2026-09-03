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

import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { clockLine, parseFlags, pickInput, inboxWrite, inboxUnread, fromPositional, EXIT_OK, EXIT_INVALID } from '../src/cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, nearest, explain } from '../src/validate';
import { openStore, tx } from '../src/store';
import { syncRoster, roleOf } from '../src/roster';

// 名簿は DB に置くので、試験ごとに一時ファイルを作って仕込む。
// :memory: は openStore のたびに別の DB になるため、外から仕込めない。
const FULL = ['shogun', 'karo', 'gunshi', 'ashigaru1', 'ashigaru2', 'ashigaru3'];
let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honden-cli-'));
  db = join(dir, 'x.db');
  const h = openStore({ path: db });
  tx(h, () => syncRoster(h, FULL.map((id) => ({ id, role: roleOf(id), cli: null, model: null }))));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 名乗りは環境から来る値。試験では from と揃えて渡す
// (揃わない場合は「名乗りの検査」の節で確かめる)。
const run = (flags: Record<string, string>, stdin?: string, dry = false) =>
  inboxWrite(db, { flags, stdin }, dry, {
    insideFormation: true,
    selfId: flags['from'] ?? 'shogun',
  });

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
    run({ to: 'karou', from: 'shogun', type: 'cmd_new', body: 'x' });
    const h = openStore({ path: db });
    const after = (h.query('SELECT count(*) c FROM inbox').get() as { c: number }).c;
    expect(after).toBe(0);
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

describe('旧 inbox_write.sh と同じ並び', () => {
  test('4 つの並びを旗へ寄せる', () => {
    // bash scripts/inbox_write.sh karo "本文" cmd_new shogun と同じ形
    expect(fromPositional(['karo', '本文', 'cmd_new', 'shogun'])).toEqual({
      to: 'karo',
      body: '本文',
      type: 'cmd_new',
      from: 'shogun',
    });
  });

  test('数が合わなければ受けない', () => {
    expect(fromPositional(['karo', '本文', 'cmd_new'])).toBeUndefined();
    expect(fromPositional(['karo', '本文', 'cmd_new', 'shogun', '余分'])).toBeUndefined();
  });

  test('並びで渡しても同じ検査を通る', () => {
    const p = fromPositional(['karou', '本文', 'cmd_new', 'shogun'])!;
    const r = run(p);
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('近いのは karo');
  });

  test('宛先と差出人が入れ替わっていれば拾える', () => {
    // 旧版は 4 つとも空でないかしか見ていなかったので通ってしまった
    const p = fromPositional(['cmd_new', '本文', 'karo', 'shogun'])!;
    const r = run(p);
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('to');
  });
});

describe('自分宛', () => {
  // 旧 inbox_write.sh も持っていた guard。項ごとの検査では拾えない。
  test('to と from が同じなら弾く', () => {
    const r = run({ to: 'karo', from: 'karo', type: 'cmd_new', body: 'x' });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('自分宛');
    expect(r.err).toContain('書き込みは行っておらぬ');
  });

  test('違えば通る', () => {
    const r = run({ to: 'karo', from: 'shogun', type: 'cmd_new', body: 'x' }, undefined, true);
    expect(r.code).toBe(EXIT_OK);
  });
});

describe('名乗りの検査', () => {
  // .opencode/tools/mark-as-read.ts の assertCurrentAgent と同じ考え。
  // あちらは OPENCODE_AGENT_ID を読み、他人の inbox を触ろうとしたら拒む。
  // 名乗りを引数に任せると、名乗りが検査にならない。
  const as = (selfId: string | undefined, from: string) =>
    inboxWrite(
      db,
      { flags: { to: 'karo', from, type: 'cmd_new', body: 'x' } },
      true,
      { insideFormation: true, selfId },
    );

  test('環境と名乗りが一致すれば通る', () => {
    expect(as('gunshi', 'gunshi').code).toBe(EXIT_OK);
  });

  test('他人の名は名乗れぬ', () => {
    const r = as('ashigaru3', 'karo');
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('ashigaru3 が karo を名乗ることはできぬ');
    expect(r.err).toContain('書き込みは行っておらぬ');
  });

  // 「誰か分からない」を「たぶん本人だろう」で通すと、検査が消える。
  test('布陣の中に居て誰か分からぬときは書かせぬ', () => {
    const r = as(undefined, 'karo');
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('確かめられぬ');
    expect(r.err).toContain('HONDEN_AGENT_ID');
  });
});

describe('布陣の外から送る', () => {
  const outside = (flags: Record<string, string>, dry = false) =>
    inboxWrite(db, { flags }, dry, { insideFormation: false });

  // skills/external-to-shogun が定める正しい使い方。
  // from を agent 名に縛ると、この正しい形を弾いてしまう。
  test('役職でない差出人名で送れる', () => {
    const r = outside(
      { to: 'karo', from: 'review_session', type: 'report_received', body: 'レビュー結果' },
      true,
    );
    expect(r.code).toBe(EXIT_OK);
  });

  test('布陣外から役職を騙れない', () => {
    const r = outside({ to: 'karo', from: 'gunshi', type: 'report_received', body: 'x' });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('名乗ることはできぬ');
    expect(r.err).toContain('review_session');
  });

  test('布陣内なら役職を名乗れる', () => {
    const r = inboxWrite(
      db,
      { flags: { to: 'karo', from: 'gunshi', type: 'report_received', body: 'x' } },
      true,
      { insideFormation: true, selfId: 'gunshi' },
    );
    expect(r.code).toBe(EXIT_OK);
  });

  test('布陣外から clear_command は撃てない', () => {
    const r = outside({ to: 'karo', from: 'review_session', type: 'clear_command', body: 'x' });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('セッションを消す');
  });

  test('差出人名に空白や記号は使えない', () => {
    const r = outside({ to: 'karo', from: 'review session', type: 'report_received', body: 'x' });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('差出人の名が使えぬ');
  });

  test('知らない type は弾き、選べるものを並べる', () => {
    const r = outside({ to: 'karo', from: 'review_session', type: '発明した種別', body: 'x' });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('report_received');
  });
});

describe('読み戻し', () => {
  // 「送ったつもり」を潰す。出すのは渡した値ではなく正本に入っている値。
  test('書き込んだ後、正本から読み戻して見せる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-cli-'));
    const path = join(dir, 'x.db');
    try {
      const h0 = openStore({ path });
      tx(h0, () => syncRoster(h0, FULL.map((id) => ({ id, role: roleOf(id), cli: null, model: null }))));
      const body = "C:\\Users\\aki と ''' と $HOME\n二行目";
      const r = inboxWrite(
        path,
        { flags: { to: 'karo', from: 'shogun', type: 'cmd_new', body } },
        false,
        { insideFormation: true, selfId: 'shogun' },
      );
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain('渡した本文と一致');
      expect(r.out).toContain('未読: はい');
      // 合図の形は nudgeText 一本。手で打つときも watcher が送るときも同じ文字列。
      expect(r.out).toContain('inbox_notice unread=1');

      // 正本の中身そのものを見る。表示だけを信じない。
      const db = openStore({ path });
      const row = db.query('SELECT body FROM inbox').get() as { body: string };
      expect(row.body).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未読数を数えて手動 nudge の形を示す', () => {
    const r = inboxUnread(db, 'karo');
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('inbox_notice unread=0');
  });

  test('知らぬ agent の未読は数えられぬ', () => {
    const r = inboxUnread(db, 'karou');
    expect(r.code).toBe(EXIT_INVALID);
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

describe('刻の一行', () => {
  test('形: 刻 YYYY-MM-DD（曜）HH:MM', () => {
    const s = clockLine(new Date('2026-09-03T13:05:00'));
    expect(s).toBe('  刻 2026-09-03（木）13:05');
  });
  test('一桁の月日と時分は零で埋める', () => {
    expect(clockLine(new Date('2026-01-05T04:07:00'))).toBe('  刻 2026-01-05（月）04:07');
  });
});
