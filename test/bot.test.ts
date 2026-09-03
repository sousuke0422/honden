/**
 * bot cli の芯の試験。外へは出ぬ——fetch は全て注入の偽物。
 *
 * 重心は三つ:
 * 一、JWT が本当に検証可能な署名か（鍵ペアを作って verify で検める。
 *     「形が JWT らしい」だけの試験は署名の壊れを見逃す）。
 * 二、司令層 guard（足軽は落ち、布陣外＝殿の手は通る）。
 * 三、失敗の便りに秘密が混ざらぬこと（token 非漏洩は旧版からの第一原則）。
 */
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  guardBot, parseAppConfig, mintJwt, tokenFresh, mintInstallationToken,
  validRepo, dupMatch, filterLabels, createIssue, searchIssues, listLabels, trimKey, SEARCH_KEY_MAX,
  pemPermWarning, normalizeRepoUrl, resolveRepo,
} from '../src/bot';

describe('guardBot', () => {
  test('錨があれば司令層は commander・足軽は retainer（許状で通る余地）', () => {
    for (const id of ['shogun', 'karo', 'gunshi']) {
      const r = guardBot({ id, insideFormation: true, anchored: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rank).toBe('commander');
    }
    const a = guardBot({ id: 'ashigaru3', insideFormation: true, anchored: true });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.rank).toBe('retainer');
  });

  test('錨が無ければ誰であろうと落ちる（fail-closed）', () => {
    // TMUX_PANE を空にして「布陣外」を騙る筋（敵対レビュー critical）。
    expect(guardBot({ insideFormation: false }).ok).toBe(false);
    // 環境変数で将軍を騙っても、錨が無ければ通らぬ。
    const r = guardBot({ id: 'shogun', insideFormation: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('系譜');
    // 布陣内でも錨が取れねば同じ。
    expect(guardBot({ id: 'shogun', insideFormation: true }).ok).toBe(false);
  });

  test('錨はあるが @agent_id の無い pane は落ちる', () => {
    expect(guardBot({ insideFormation: true, anchored: true }).ok).toBe(false);
  });
});

describe('pemPermWarning', () => {
  test('600 なら黙る・緩ければ声を上げる', () => {
    expect(pemPermWarning(0o100600, '/k/app.pem')).toBeUndefined();
    const w = pemPermWarning(0o100644, '/k/app.pem');
    expect(w).toContain('644');
    expect(w).toContain('己以外にも読める');
  });

  test('777（DrvFs の常）では置き場そのものを正す', () => {
    const w = pemPermWarning(0o100777, '/mnt/c/x/app.pem')!;
    expect(w).toContain('DrvFs');
    expect(w).toContain('~/.shogun');
  });

  test('己だけ厳しい 400 も「緩い」とは言わぬが締めよとは言う', () => {
    const w = pemPermWarning(0o100400, '/k/app.pem')!;
    expect(w).not.toContain('己以外にも読める');
    expect(w).toContain('chmod 600');
  });
});

describe('parseAppConfig', () => {
  test('実物の形（大文字 KEY: 値）と dotenv と小文字 yaml を全て読む', () => {
    const c = parseAppConfig([
      '# コメントは飛ばす',
      'APP_ID: 12345',
      'CLIENT_ID: Iv23ligotcha',
      'INSTALLATION_ID=777',
      "quoted: 'v'",
      '',
    ].join('\n'));
    expect(c['app_id']).toBe('12345');
    expect(c['client_id']).toBe('Iv23ligotcha');
    expect(c['installation_id']).toBe('777');
    expect(c['quoted']).toBe('v');
  });
});

describe('mintJwt', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  test('署名が公開鍵で検証でき、claims が GitHub の決めに合う', () => {
    const now = 1_700_000_000;
    const jwt = mintJwt(pem, 'Iv23xyz', now);
    const [h, p, sig] = jwt.split('.');
    expect(h && p && sig).toBeTruthy();

    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);

    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(header).toEqual({ typ: 'JWT', alg: 'RS256' });
    expect(payload.iss).toBe('Iv23xyz');
    expect(payload.iat).toBe(now - 60); // 時計ずれの呑み代
    expect(payload.exp - payload.iat).toBe(600); // 上限 10 分きっかり
  });

  test('中身を変えると検証が落ちる（陽性対照）', () => {
    const jwt = mintJwt(pem, 'Iv23xyz', 1_700_000_000);
    const [h, , sig] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ iat: 0, exp: 9_999_999_999, iss: 'Iv23xyz' })).toString('base64url');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${forged}`);
    expect(v.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(false);
  });
});

describe('tokenFresh', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  test('期限 5 分手前で捨てる', () => {
    expect(tokenFresh({ token: 't', expires_at: '2026-08-29T12:06:00Z' }, now)).toBe(true);
    expect(tokenFresh({ token: 't', expires_at: '2026-08-29T12:04:00Z' }, now)).toBe(false);
    expect(tokenFresh({ token: 't', expires_at: '壊れた日付' }, now)).toBe(false);
  });
});

describe('validRepo', () => {
  test('OWNER/REPO のみ通す（URL へ埋めるゆえ狭く）', () => {
    expect(validRepo('sousuke0422/honden')).toBe(true);
    expect(validRepo('koyori-app/task')).toBe(true);
    expect(validRepo('a/b/c')).toBe(false);
    expect(validRepo('a/b?x=1')).toBe(false);
    expect(validRepo('../etc')).toBe(false);
  });
});

describe('dupMatch', () => {
  test('題の完全一致と、10 字超の鍵の包含だけを重複と見る', () => {
    const items = [{ title: '本番切り替えの手順を定める', url: 'u1' }];
    expect(dupMatch(items, '本番切り替えの手順を定める')).toBe('u1');
    expect(dupMatch(items, '本番切り替えの手順を定める（再）')).toBeUndefined(); // 一致せず包含もされぬ
    expect(dupMatch(items, '切り替えの手順を定める')).toBe('u1'); // 11 字の鍵は包含で当たる
    expect(dupMatch(items, '本番切り替えの手順')).toBeUndefined(); // 9 字は包含でも当てぬ（暴発防止の閾）
    expect(dupMatch([], '何でも')).toBeUndefined();
  });
});

describe('filterLabels', () => {
  test('既存のみ通す（殿命）。大文字小文字は同一視', () => {
    const { ok, missing } = filterLabels(['Bug', 'shogun-bot'], ['bug', 'enhancement']);
    expect(ok).toEqual(['Bug']);
    expect(missing).toEqual(['shogun-bot']);
  });
});

const fake = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe('API まわり（偽 fetch）', () => {
  test('mintInstallationToken は token を返し、失敗便りに秘密が混ざらぬ', async () => {
    const t = await mintInstallationToken(fake(201, { token: 'ghs_secret', expires_at: 'x' }), 'jwt.abc.def', '77');
    expect(t.token).toBe('ghs_secret');

    let msg = '';
    try {
      await mintInstallationToken(fake(401, { message: 'Bad credentials' }), 'jwt.abc.def', '77');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('401');
    expect(msg).not.toContain('jwt.abc'); // JWT を失敗表示へ混ぜぬ
  });

  test('createIssue はラベル空なら labels 欄ごと省く', async () => {
    let sent = '';
    const f = async (_u: string, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ html_url: 'u', number: 1 }), { status: 201 });
    };
    await createIssue(f, 'tok', 'o/r', '題', '本文', []);
    expect(JSON.parse(sent)).toEqual({ title: '題', body: '本文' });
    await createIssue(f, 'tok', 'o/r', '題', '本文', ['bug']);
    expect(JSON.parse(sent).labels).toEqual(['bug']);
  });

  test('searchIssues は is:issue を伴い、URL 符号化して探す', async () => {
    let url = '';
    const f = async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ items: [{ title: 't', html_url: 'h' }] }), { status: 200 });
    };
    const r = await searchIssues(f, 'tok', 'o/r', '鍵 と空白&記号');
    expect(r).toEqual([{ title: 't', url: 'h' }]);
    // is:issue を落とすと PR まで拾い、題の似た PR があるだけで起票が黙って飛ぶ。
    expect(url).toContain(encodeURIComponent('repo:o/r is:issue in:title 鍵 と空白&記号'));
  });

  test('長すぎる鍵は切る（検索文字列の上限で 422 に落ちぬよう）', async () => {
    const long = 'あ'.repeat(400);
    expect(trimKey(long).length).toBe(SEARCH_KEY_MAX);
    expect(trimKey('短い')).toBe('短い');
    let url = '';
    const f = async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    await searchIssues(f, 'tok', 'o/r', long);
    expect(url).toContain(encodeURIComponent('あ'.repeat(SEARCH_KEY_MAX)));
    expect(url).not.toContain(encodeURIComponent('あ'.repeat(SEARCH_KEY_MAX + 1)));
  });

  test('listLabels は頁を繰る（100 で黙って切れぬ）', async () => {
    const pages: string[][] = [
      Array.from({ length: 100 }, (_, i) => `l${i}`),
      ['最後のラベル'],
    ];
    let seen = 0;
    const f = async (u: string) => {
      const page = Number(new URL(u).searchParams.get('page'));
      seen = Math.max(seen, page);
      return new Response(JSON.stringify((pages[page - 1] ?? []).map((name) => ({ name }))), { status: 200 });
    };
    const names = await listLabels(f, 'tok', 'o/r');
    expect(names.length).toBe(101);
    expect(names).toContain('最後のラベル'); // 二頁目まで届いた
    expect(seen).toBe(2); // 一頁が満たねば止まる（無駄打ちせぬ）
  });
});

describe('repo の均し（normalizeRepoUrl）', () => {
  test('URL・ssh・素の形を OWNER/REPO へ', () => {
    for (const s of [
      'https://github.com/koyori-app/task',
      'https://github.com/koyori-app/task.git',
      'https://github.com/koyori-app/task/',
      'git@github.com:koyori-app/task.git',
      ' koyori-app/task ',
    ]) expect(normalizeRepoUrl(s)).toBe('koyori-app/task');
  });
  test('読めぬ形は null（黙って当てずっぽうにせぬ）', () => {
    for (const s of ['', 'https://gitlab.com/a/b', 'ftp://x', 'a b/c']) expect(normalizeRepoUrl(s)).toBeNull();
  });
});

describe('宛先の解決（resolveRepo）— 取り違えを拒む', () => {
  test('**手打ちと設定が食い違えば拒む**（設定が正）', () => {
    const r = resolveRepo({ flag: 'old-org/task', project: 'task', projectRepo: 'koyori-app/task' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('koyori-app/task');
  });
  test('一致すれば通る。設定だけなら設定から', () => {
    expect(resolveRepo({ flag: 'koyori-app/task', projectRepo: 'koyori-app/task' })).toMatchObject({ ok: true, repo: 'koyori-app/task' });
    expect(resolveRepo({ project: 'task', projectRepo: 'koyori-app/task' })).toMatchObject({ ok: true, repo: 'koyori-app/task' });
  });
  test('remote との食い違いは**警めに留める**（旧名の redirect が実在する）', () => {
    const r = resolveRepo({ flag: 'koyori-app/task', project: 'task', remoteRepo: 'TeamBlackCrystal/task' });
    expect(r).toMatchObject({ ok: true, repo: 'koyori-app/task' });
    if (r.ok) expect(r.warn).toContain('TeamBlackCrystal/task');
  });
  test('設定に無ければ remote から。どこにも無ければ拒む', () => {
    expect(resolveRepo({ project: 'p', remoteRepo: 'o/r' })).toMatchObject({ ok: true, repo: 'o/r' });
    expect(resolveRepo({ project: 'p' }).ok).toBe(false);
    expect(resolveRepo({}).ok).toBe(false);
  });
});
