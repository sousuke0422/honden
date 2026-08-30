/**
 * ntfy の送り口の試験。
 *
 * 本物のサーバまでは測れぬ（殿が自前で建てられる由・まだ無い）。だが
 * **継ぎ目は測れる**——何を投げるか、合鍵をどう組むか、届かなんだ時に
 * 何と言うか。両端を留めておかねば、いざ建てた時に**動かぬ理由が分からぬ**。
 */
import { describe, expect, test } from 'bun:test';
import { config, request, curlArgs, ntfySink, topicWarning, encodeTitle, DEFAULT_BASE, WEAK } from '../src/notify/ntfy';
import type { Notice } from '../src/notify';

const N: Notice = {
  title: 'honden — 殿のご裁可をお待ちしております',
  body: '#12 本番切り替え',
  url: 'http://127.0.0.1:8788/',
  key: 'decision:12',
};
const C = { base: 'https://ntfy.example.org', topic: 'honden-abcdef123456' };

describe('config — 設定が無ければ名乗り出ぬ', () => {
  test('topic が無ければ null（送り口を作らぬ）', () => {
    expect(config({}, {})).toBeNull();
    expect(config({ notify: { ntfy: {} } }, {})).toBeNull();
    expect(config({ notify: { ntfy: { topic: '   ' } } }, {})).toBeNull();
  });

  test('**宛先を設定へ出す**（旧は ntfy.sh を直書きしており自前で使えなんだ）', () => {
    const c = config({ notify: { ntfy: { topic: 't', base: 'https://ntfy.example.org/' } } }, {})!;
    expect(c.base).toBe('https://ntfy.example.org'); // 末尾の / は落とす
  });

  test('宛先を省けば公開の ntfy.sh', () => {
    expect(config({ notify: { ntfy: { topic: 't' } } }, {})!.base).toBe(DEFAULT_BASE);
  });

  test('合鍵は環境から取る（公開する設定に書かせぬ）', () => {
    const c = config({ notify: { ntfy: { topic: 't' } } }, { NTFY_TOKEN: 'tk_abc' })!;
    expect(c.token).toBe('tk_abc');
    // 設定側に書いても拾わぬ——書く場所を一つに定める
    const d = config({ notify: { ntfy: { topic: 't', token: 'settings に書いた' } } }, {})!;
    expect(d.token).toBeUndefined();
  });
});

describe('topicWarning — topic は合鍵そのもの', () => {
  test('ありふれた名を戒める', () => {
    for (const t of [...WEAK]) expect(topicWarning(t)).toBeTruthy();
    expect(topicWarning('ALERTS')).toBeTruthy(); // 大小は問わぬ
  });

  test('短い名を戒める', () => {
    expect(topicWarning('short')).toContain('短い');
  });

  test('長く推測しにくい名なら黙る', () => {
    expect(topicWarning('honden-9f3a2b7c1d5e')).toBeUndefined();
  });
});

describe('request — 何を投げるか', () => {
  test('宛先は 根/topic、本文は body', () => {
    const { url, init } = request(C, N);
    expect(url).toBe('https://ntfy.example.org/honden-abcdef123456');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('#12 本番切り替え');
  });

  test('**見出しは付けず、本文の一行目へ畳む**（旧の並びに寄せる）', () => {
    const { init } = request(C, N);
    const h = init.headers as Record<string, string>;
    // 旧 ntfy.sh は見出しを送らず、端末では会話のように並んでおった。
    expect(h['Title']).toBeUndefined();
    expect(String(init.body)).toBe(`${N.title}\n${N.body}`);
  });

  test('印は outbound（受け手が自分の声を弾く印）', () => {
    const h = request(C, N).init.headers as Record<string, string>;
    expect(h['Tags']).toBe('outbound');
  });

  test('見出しを頭で送る要が出た時のため、正しい包み方を持つ', () => {
    // **percent 符号化では化ける**——公開の ntfy.sh へ撃って実測した:
    //   percent → '%E6%AE%BF%E3%81%B8' が生のまま出る
    //   RFC2047 → '殿へ' と正しく出る
    expect(encodeTitle('殿へ')).toBe(`=?UTF-8?B?${Buffer.from('殿へ').toString('base64')}?=`);
    expect(encodeTitle('plain ascii')).toBe('plain ascii'); // 包まずそのまま
  });

  test('押した先は Click で渡る', () => {
    const h = request(C, N).init.headers as Record<string, string>;
    expect(h['Click']).toBe('http://127.0.0.1:8788/');
  });

  test('行き先が無ければ Click を付けぬ', () => {
    const h = request(C, { title: 't', body: 'b', key: 'k' }).init.headers as Record<string, string>;
    expect(h['Click']).toBeUndefined();
  });

  test('token があれば Bearer、無く user/pass があれば Basic', () => {
    const a = request({ ...C, token: 'tk' }, N).init.headers as Record<string, string>;
    expect(a['Authorization']).toBe('Bearer tk');
    const b = request({ ...C, user: 'u', pass: 'p' }, N).init.headers as Record<string, string>;
    expect(b['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  test('token が勝つ（両方あれば迷わぬ）', () => {
    const h = request({ ...C, token: 'tk', user: 'u', pass: 'p' }, N).init.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer tk');
  });

  test('合鍵が無ければ Authorization を付けぬ（公開 topic の使い方）', () => {
    const h = request(C, N).init.headers as Record<string, string>;
    expect(h['Authorization']).toBeUndefined();
  });
});

describe('ntfySink — 届かねば落ちたと言う', () => {
  test('2xx なら通る', () => {
    expect(ntfySink(C, () => ({ ok: true, code: '200' })).send(N).ok).toBe(true);
  });

  test('**curl が 0 で終わっても 2xx でなければ落第**', () => {
    // curl は 404 でも終了コード 0 を返す。コードだけ見れば「届いた」と誤る。
    const r = ntfySink(C, () => ({ ok: true, code: '404' })).send(N);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('404');
  });

  test('curl 自体が落ちれば、その言い分を伝える', () => {
    const r = ntfySink(C, () => ({ ok: false, code: '', detail: 'curl: 名前が引けぬ' })).send(N);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('名前が引けぬ');
  });

  test('投げる命に宛先・見出し・本文が入る', () => {
    let got: string[] = [];
    ntfySink({ ...C, token: 'tk' }, (a) => {
      got = a;
      return { ok: true, code: '200' };
    }).send(N);
    expect(got[0]).toBe('curl');
    expect(got).toContain('https://ntfy.example.org/honden-abcdef123456');
    expect(got.join(' ')).toContain('Authorization: Bearer tk');
    expect(got.join(' ')).toContain('#12 本番切り替え');
  });

  test('curlArgs は目で追える形（何をどう投げるか）', () => {
    const a = curlArgs(C, N);
    expect(a).toContain('-X');
    expect(a).toContain('POST');
    expect(a).toContain('%{http_code}'); // 状態を読むゆえ
  });
});
