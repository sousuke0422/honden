/**
 * 報せの試験。
 *
 * 肝は三つ——**二度撃たぬ**・**全滅した時だけ刻まぬ**・**配下の書いた文が
 * 通知の作りを壊さぬ**。通知は殿の目に入る唯一の細道ゆえ、狼少年にすれば
 * 見張りが無いのと同じになる。
 */
import { describe, expect, test } from 'bun:test';
import { pending, dispatch, NOTIFY_ACTION, type Notice, type Sink } from '../src/notify';
import { esc, toastXml, script, encode, desktopSink } from '../src/notify/desktop';
import { openStore, tx, journal } from '../src/store';

const VIEWER = 'http://127.0.0.1:8788';

const seeded = (questions: string[]) => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    const ins = db.prepare(
      "INSERT INTO decision(raised_by, at, question, choices, status) VALUES ('karo', '2026-08-30', ?, '[]', 'open')",
    );
    for (const q of questions) ins.run(q);
  });
  return db;
};

const okSink = (name: string, log: Notice[]): Sink => ({
  name,
  send: (n) => {
    log.push(n);
    return { ok: true };
  },
});
const deadSink = (name: string): Sink => ({ name, send: () => ({ ok: false, detail: '届かぬ' }) });

describe('pending — 何を報せるか', () => {
  test('裁可待ちを報せに組む', () => {
    const db = seeded(['本番切り替え — 併走か一気か']);
    const n = pending(db, VIEWER);
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('本番切り替え');
    expect(n[0]!.url).toBe(VIEWER);
  });

  test('長い問いは畳む（一目で読めねば意味が無い）', () => {
    const db = seeded(['あ'.repeat(200)]);
    expect(pending(db, VIEWER)[0]!.body.length).toBeLessThan(100);
  });

  test('二行目以降は落とす（通知は一行しか読まれぬ）', () => {
    const db = seeded(['一行目\n二行目は出さぬ']);
    expect(pending(db, VIEWER)[0]!.body).not.toContain('二行目');
  });

  test('**二度撃たぬ**——撃った跡があれば出さぬ', () => {
    const db = seeded(['問い']);
    const first = pending(db, VIEWER);
    expect(first).toHaveLength(1);
    tx(db, () => journal(db, { actor: 'honden', action: NOTIFY_ACTION, target: first[0]!.key }));
    expect(pending(db, VIEWER)).toHaveLength(0);
  });

  test('裁可が済んだものは報せぬ', () => {
    const db = seeded(['済む問い']);
    db.run("UPDATE decision SET status = 'decided'");
    expect(pending(db, VIEWER)).toHaveLength(0);
  });
});

describe('dispatch — 撃つ', () => {
  test('届けば刻む', () => {
    const db = seeded(['問い']);
    const log: Notice[] = [];
    const r = dispatch(db, pending(db, VIEWER), [okSink('desktop', log)]);
    expect(r.sent).toBe(1);
    expect(log).toHaveLength(1);
    expect(pending(db, VIEWER)).toHaveLength(0); // 二度目は出ぬ
  });

  test('片方が落ちても、届いておれば刻む', () => {
    const db = seeded(['問い']);
    const log: Notice[] = [];
    const r = dispatch(db, pending(db, VIEWER), [deadSink('ntfy'), okSink('desktop', log)]);
    expect(r.sent).toBe(1);
    expect(r.failed[0]!.sink).toBe('ntfy');
    expect(pending(db, VIEWER)).toHaveLength(0);
  });

  test('**全滅した時は刻まぬ**（次の機会に撃ち直せるよう）', () => {
    const db = seeded(['問い']);
    const r = dispatch(db, pending(db, VIEWER), [deadSink('a'), deadSink('b')]);
    expect(r.sent).toBe(0);
    expect(pending(db, VIEWER)).toHaveLength(1); // まだ残る
  });
});

describe('卓上の送り口 — 配下の書いた文が作りを壊さぬ', () => {
  const attack: Notice = {
    title: '<toast><script>alert(1)</script>',
    body: '"><action content="消す" activationType="protocol" arguments="http://evil" />',
    url: 'http://127.0.0.1:8788',
    key: 'k',
  };

  test('XML の字が殺される（勝手なボタンを生やせぬ）', () => {
    const x = toastXml(attack);
    // 我らが組んだ二つ以外に action が生えてはならぬ
    expect(x.match(/<action /g) ?? []).toHaveLength(2);
    expect(x).not.toContain('<script>');
    expect(x).not.toContain('http://evil"');
    expect(x).toContain('&lt;script&gt;');
  });

  test('esc は五つの字を殺す', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&apos;');
  });

  test('url が無ければボタンは「後で」だけ', () => {
    const x = toastXml({ title: 't', body: 'b', key: 'k' });
    expect(x.match(/<action /g) ?? []).toHaveLength(1);
    expect(x).toContain('dismiss');
  });

  test('符号化は UTF-16LE の base64（ファイルにも BOM にも頼らぬ）', () => {
    // PowerShell 5.1 は BOM 無しの .ps1 を既定の符号系で読み、日本語が化ける
    // ——最初の試し撃ちで実際に化けた。この道ならその罠が無い。
    const b = encode('日本語');
    expect(Buffer.from(b, 'base64').toString('utf16le')).toBe('日本語');
  });

  test('組んだ命に通知の XML と借りた名が入る', () => {
    const s = script({ title: 'a', body: 'b', url: 'http://x', key: 'k' });
    expect(s).toContain('ToastNotificationManager');
    expect(s).toContain('WindowsPowerShell');
    expect(s).toContain('<toast');
  });

  test('**届かねば落ちたと言う**（黙って成功と言わぬ）', () => {
    const sink = desktopSink(() => ({ ok: false, detail: 'powershell.exe が無い' }));
    const r = sink.send({ title: 't', body: 'b', key: 'k' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('powershell.exe');
  });

  test('撃つ命は powershell へ符号化して渡る', () => {
    let got: string[] = [];
    const sink = desktopSink((args) => {
      got = args;
      return { ok: true };
    });
    sink.send({ title: '殿へ', body: '裁可を', url: 'http://x', key: 'k' });
    expect(got[0]).toBe('powershell.exe');
    expect(got).toContain('-EncodedCommand');
    const ps = Buffer.from(got.at(-1)!, 'base64').toString('utf16le');
    expect(ps).toContain('殿へ'); // 日本語が無傷で渡る
  });
});

/**
 * **素振りは撃たぬ。**
 *
 * `--dry-run` は差配の入口で旗から消され、変数へ移る（src/main.ts）。
 * 旗を見ておったゆえ、素振りが**実際に撃っておった**（実測 2026-08-30）。
 * 通知は一度撃てば「撃った」と刻まれ、撃ち直せぬ——素振りが撃つのは重い。
 *
 * ここは芯（dispatch）の側で「呼ばねば撃たぬ」ことを留める。差配の側の
 * 取り違えは tests/*.bats と実弾で見る。
 */
describe('素振りは撃たぬ', () => {
  test('dispatch を呼ばねば、報せは残ったまま', () => {
    const db = seeded(['素振りの検分']);
    expect(pending(db, VIEWER)).toHaveLength(1);
    // 素振り＝組むだけで撃たぬ。何度組んでも減らぬ。
    pending(db, VIEWER);
    pending(db, VIEWER);
    expect(pending(db, VIEWER)).toHaveLength(1);
  });

  test('撃って初めて減る（陽性対照）', () => {
    const db = seeded(['素振りの検分']);
    const log: Notice[] = [];
    dispatch(db, pending(db, VIEWER), [okSink('desktop', log)]);
    expect(pending(db, VIEWER)).toHaveLength(0);
  });
});
