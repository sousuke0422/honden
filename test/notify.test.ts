/**
 * 報せの試験。
 *
 * 肝は三つ——**二度撃たぬ**・**全滅した時だけ刻まぬ**・**配下の書いた文が
 * 通知の作りを壊さぬ**。通知は殿の目に入る唯一の細道ゆえ、狼少年にすれば
 * 見張りが無いのと同じになる。
 */
import { describe, expect, test } from 'bun:test';
import { pending, streakNotice, dispatch, NOTIFY_ACTION, type Notice, type Sink } from '../src/notify';
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

/**
 * **報せる出来事は旧の四種に揃える。**
 *
 * 一つでも欠ければ、殿は端末を見る習慣を失う——見ても半分しか載っておらぬなら、
 * 結局は戦況を開くことになる。旧環境の README「Phone Notifications」が
 * 報せておった四種（🚨 要対応・✅ 完了・❌ 失敗・🔥 連続）を留める。
 */
describe('報せる出来事——旧の四種', () => {
  const withCmd = () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      db.run(
        `INSERT INTO cmd(id, created_at, purpose, body, raw, status, completed_at)
         VALUES ('cmd_042', '2026-08-30', '通知の器を建てる', '本文', '{}', 'done', '2026-08-30T10:00:00Z')`,
      );
      db.run("INSERT INTO cmd_acceptance(cmd_id, idx, text) VALUES ('cmd_042', 0, '条件一')");
      db.run("INSERT INTO cmd_acceptance(cmd_id, idx, text) VALUES ('cmd_042', 1, '条件二')");
    });
    return db;
  };

  test('✅ 司令の完了を報せる（覆いの数つき）', () => {
    const db = withCmd();
    const n = pending(db, VIEWER).find((x) => x.key === 'cmd:done:cmd_042');
    expect(n).toBeTruthy();
    expect(n!.body).toContain('✅');
    expect(n!.body).toContain('cmd_042');
    expect(n!.body).toContain('2 件'); // 受け入れ条件の数
  });

  test('❌ 倒れた任を報せる（黙って倒れるのが最も悪い）', () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () =>
      db.run(
        "INSERT INTO task(agent, task_id, status, updated_at, raw) VALUES ('ashigaru3', 'subtask_042c', 'failed', 'x', '{}')",
      ),
    );
    const n = pending(db, VIEWER).find((x) => x.key === 'task:failed:subtask_042c');
    expect(n!.body).toContain('❌');
    expect(n!.body).toContain('ashigaru3');
  });

  test('❌ 品質の落第を報せる', () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () =>
      db.run(
        `INSERT INTO report(agent, task_id, created_at, verdict, raw) VALUES ('gunshi', 'subtask_9', '2026-08-30', 'REJECTED', '{}')`,
      ),
    );
    const n = pending(db, VIEWER).find((x) => x.key === 'report:rejected:subtask_9');
    expect(n!.body).toContain('やり直し');
  });

  test('🚨 裁可待ちが先に並ぶ（最も詰まる所ゆえ）', () => {
    const db = withCmd();
    tx(db, () =>
      db.run(
        "INSERT INTO decision(raised_by, at, question, choices, status) VALUES ('karo', 'x', '問い', '[]', 'open')",
      ),
    );
    expect(pending(db, VIEWER)[0]!.body).toContain('🚨');
  });

  test('完了も二度は撃たぬ', () => {
    const db = withCmd();
    const log: Notice[] = [];
    dispatch(db, pending(db, VIEWER), [okSink('desktop', log)]);
    expect(pending(db, VIEWER)).toHaveLength(0);
  });
});

describe('🔥 連続の報せ——日ごとに一度だけ', () => {
  const withStreak = (last: string | null, done: number) => {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      db.run('UPDATE saytask_streak SET current = 3, longest = 16, last_date = ? WHERE one = 1', [last]);
      const ins = db.prepare(
        "INSERT INTO saytask(id, title, status, created_at, raw) VALUES (?, 't', ?, '2026-08-30', '{}')",
      );
      for (let i = 0; i < 4; i++) ins.run(`VF-00${i + 1}`, i < done ? 'done' : 'todo');
    });
    return db;
  };

  test('今日果たしておれば報せる', () => {
    const n = streakNotice(withStreak('2026-08-30', 2), VIEWER, '2026-08-30');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('🔥 3 日連続');
    expect(n[0]!.body).toContain('最長 16');
    expect(n[0]!.body).toContain('2/4');
  });

  test('**今日まだ果たしておらねば黙る**（数でなく日で撃つ）', () => {
    expect(streakNotice(withStreak('2026-08-29', 2), VIEWER, '2026-08-30')).toHaveLength(0);
  });

  test('同じ日に二度は撃たぬ', () => {
    const db = withStreak('2026-08-30', 2);
    const log: Notice[] = [];
    dispatch(db, streakNotice(db, VIEWER, '2026-08-30'), [okSink('desktop', log)]);
    expect(streakNotice(db, VIEWER, '2026-08-30')).toHaveLength(0);
  });
});
