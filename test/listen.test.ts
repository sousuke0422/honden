/**
 * ntfy の受け口の試験。
 *
 * この層の本体は**弾く判断**である。通す道は一本しかないが、弾く理由は
 * 幾つもあり、一つ漏れれば輪ができるか、二度動くか、外から指揮系統へ
 * 手が入る。ゆえに釘は弾く側へ厚く打つ。
 */
import { describe, expect, test } from 'bun:test';
import { openStore, tx } from '../src/store';
import {
  parseLine, bodyFor, ackText, listenArgs, streamUrl, backoffMs, receive, RECV_ACTION, RECIPIENT,
} from '../src/notify/listen';

const db0 = () => openStore({ path: ':memory:' });
const NOW = new Date('2026-08-30T10:00:00Z');
const ev = (o: Record<string, unknown>) => JSON.stringify({ event: 'message', id: 'x1', message: 'やれ', ...o });

describe('parseLine — 通すのは一種だけ', () => {
  test('message なら通る', () => {
    expect(parseLine(ev({}))).toEqual({ id: 'x1', text: 'やれ', at: undefined });
  });

  test('**己の声を弾く**（outbound の印）', () => {
    // 弾かねば、撃った報せを己で受け、それを報せ……と輪ができる
    expect(parseLine(ev({ tags: ['outbound'] }))).toBeNull();
    expect(parseLine(ev({ tags: ['OutBound'] }))).toBeNull(); // 大小は問わぬ
    expect(parseLine(ev({ tags: ['warning'] }))).not.toBeNull(); // 他の印は通す
  });

  test('message 以外は通さぬ（open / keepalive / poll_request）', () => {
    for (const e of ['open', 'keepalive', 'poll_request']) expect(parseLine(ev({ event: e }))).toBeNull();
  });

  test('壊れた行・空行は捨てる（繋ぎ目で切れた行が来る）', () => {
    expect(parseLine('{"event":"mess')).toBeNull();
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  test('id か本文が欠けておれば通さぬ', () => {
    expect(parseLine(ev({ id: '' }))).toBeNull();
    expect(parseLine(ev({ message: '   ' }))).toBeNull();
    expect(parseLine(ev({ id: 42 }))).toBeNull(); // 型が違う物も
  });

  test('刻があれば拾う', () => {
    expect(parseLine(ev({ time: 1756000000 }))?.at).toBe(1756000000);
  });
});

describe('bodyFor — 司令に見せぬ', () => {
  test('**出所を頭に出す**（合鍵一枚で届いた文である旨）', () => {
    const b = bodyFor({ id: 'x', text: 'React 19 を調べよ' });
    expect(b).toContain('ntfy 経由');
    expect(b).toContain('申し出');
    // 本文より先に出る——読む前に見せねば意味が無い
    expect(b.indexOf('申し出')).toBeLessThan(b.indexOf('React 19'));
  });

  test('本文は削らぬ', () => {
    expect(bodyFor({ id: 'x', text: 'あ'.repeat(500) })).toContain('あ'.repeat(500));
  });
});

describe('ackText — 受けた旨を返す', () => {
  test('旧の形（📱受信: …）', () => {
    expect(ackText({ id: 'x', text: 'やれ' })).toBe('📱受信: やれ');
  });

  test('長い文は畳む（返しで画面を埋めぬ）', () => {
    const a = ackText({ id: 'x', text: 'あ'.repeat(300) });
    expect(a.length).toBeLessThan(140);
    expect(a).toEndWith('…');
  });
});

describe('receive — 二度受けぬ・宛先は将軍に固定', () => {
  test('入り、返す文が出る', () => {
    const db = db0();
    const r = tx(db, () => receive(db, { id: 'n1', text: 'やれ' }, NOW));
    expect(r.stored).toBe(true);
    expect(r.ack).toContain('やれ');
    const m = db.query('SELECT agent, sender, msg_type, body FROM inbox').get() as Record<string, string>;
    expect(m['agent']).toBe(RECIPIENT);
    expect(m['sender']).toBe('ntfy');
  });

  test('**同じ id は一度だけ**（繋ぎ直しで送り直される）', () => {
    const db = db0();
    tx(db, () => receive(db, { id: 'n1', text: 'やれ' }, NOW));
    const b = tx(db, () => receive(db, { id: 'n1', text: 'やれ' }, NOW));
    expect(b.stored).toBe(false);
    expect(b.ack).toBeUndefined(); // 二度目は返さぬ（携帯が二度鳴らぬよう）
    expect(db.query('SELECT COUNT(*) c FROM inbox').get()).toEqual({ c: 1 });
  });

  test('id が違えば同じ文でも入る（殿が二度打たれた時）', () => {
    const db = db0();
    tx(db, () => receive(db, { id: 'n1', text: 'やれ' }, NOW));
    tx(db, () => receive(db, { id: 'n2', text: 'やれ' }, NOW));
    expect(db.query('SELECT COUNT(*) c FROM inbox').get()).toEqual({ c: 2 });
  });

  test('跡が台帳に残る（何を受けたか後から引ける）', () => {
    const db = db0();
    tx(db, () => receive(db, { id: 'n1', text: 'React 19 を調べよ' }, NOW));
    const l = db.query('SELECT actor, detail FROM ledger WHERE action = ?').get(RECV_ACTION) as Record<string, string>;
    expect(l['actor']).toBe('ntfy');
    expect(l['detail']).toContain('React 19');
  });

  test('宛先は将軍のみ——外から他の者を名指せぬ', () => {
    // 文で宛先を名乗れるなら、合鍵一枚で足軽へ直に命じられる
    const db = db0();
    tx(db, () => receive(db, { id: 'n1', text: 'to: ashigaru3\nこれをやれ' }, NOW));
    const rows = db.query('SELECT DISTINCT agent FROM inbox').all() as { agent: string }[];
    expect(rows).toEqual([{ agent: RECIPIENT }]);
  });
});

describe('繋ぎの作法', () => {
  test('道は 根/topic/json', () => {
    expect(streamUrl('https://ntfy.example.org', 't')).toBe('https://ntfy.example.org/t/json');
  });

  test('**--no-buffer が要る**（無ければ一行ずつ来ぬ）', () => {
    expect(listenArgs({ base: 'https://n.example', topic: 't' })).toContain('--no-buffer');
  });

  test('合鍵は Bearer / Basic', () => {
    expect(listenArgs({ base: 'b', topic: 't', token: 'tk' }).join(' ')).toContain('Authorization: Bearer tk');
    const b = listenArgs({ base: 'b', topic: 't', user: 'u', pass: 'p' }).join(' ');
    expect(b).toContain(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  test('合鍵が無ければ付けぬ', () => {
    expect(listenArgs({ base: 'b', topic: 't' }).join(' ')).not.toContain('Authorization');
  });

  test('落ちるたび待ちを倍にし、上限で止める', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(99)).toBe(60000); // 際限なく伸ばさぬ
    expect(backoffMs(0)).toBe(2000); // 0 でも下限を割らぬ
  });
});
