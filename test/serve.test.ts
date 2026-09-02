/**
 * 戦況配信の試験。旧 dashboard-viewer.py の後継が同じ約束を守るかを見る。
 *
 * 約束は三つ:
 * 一、/ が HTML を配り、/api/dashboard が CLI と同じ md を配る（画面と端末で
 *     違うものを見せぬ——正本一つ・組み一つ）。
 * 二、/api/version は正本が動けば変わる（台帳の伸びが合図。旧の mtime の代替）。
 * 三、port 0 でも生きた口を返す（試験が空き口を探さずに済む）。
 */
import { describe, expect, test } from 'bun:test';
import { serve, LOOPBACK, hostAllowed } from '../src/serve';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { journal } from '../src/store';

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
    ]);
  });
  return db;
};

describe('hostAllowed', () => {
  test('己の内に閉じておる時は、我が家の名だけ通す', () => {
    for (const h of ['127.0.0.1:8788', 'localhost:8788', '[::1]:8788', 'LOCALHOST:8788']) {
      expect(hostAllowed(h, LOOPBACK, 8788)).toBe(true);
    }
    for (const h of ['evil.example.com', 'evil.example.com:8788', '127.0.0.1:9999', '']) {
      expect(hostAllowed(h, LOOPBACK, 8788)).toBe(false);
    }
    expect(hostAllowed(null, LOOPBACK, 8788)).toBe(false);
  });

  test('外へ開くと決めた時は検めを緩める（範囲は広げた者が負う）', () => {
    expect(hostAllowed('何でも', '0.0.0.0', 8788)).toBe(true);
  });
});

describe('serve', () => {
  test('/ は HTML・/api/dashboard は compose の出力そのもの', async () => {
    const db = seeded();
    const md = '# 📊 戦況報告\n試験の md';
    const s = serve({ port: 0, db: () => db, compose: () => md });
    try {
      const home = await (await fetch(`http://localhost:${s.port}/`)).text();
      expect(home).toContain('<!DOCTYPE html>');
      expect(home).not.toContain('cdn.'); // 外へ繋がらぬ（描画器を借りぬ）
      expect(home).toContain("default-src 'none'"); // CSP で外向きを断つ
      const got = await (await fetch(`http://localhost:${s.port}/api/dashboard`)).text();
      expect(got).toBe(md); // 端末で見るものと寸分違わぬ
    } finally {
      s.stop();
    }
  });

  test('/api/version は正本が動くと変わる', async () => {
    const db = seeded();
    const s = serve({ port: 0, db: () => db, compose: () => '' });
    try {
      const v1 = await (await fetch(`http://localhost:${s.port}/api/version`)).text();
      tx(db, () => journal(db, { actor: 'shogun', action: 'probe', detail: '正本を動かす' }));
      const v2 = await (await fetch(`http://localhost:${s.port}/api/version`)).text();
      expect(v2).not.toBe(v1);
      // 陽性対照の裏: 動かさねば変わらぬ
      const v3 = await (await fetch(`http://localhost:${s.port}/api/version`)).text();
      expect(v3).toBe(v2);
    } finally {
      s.stop();
    }
  });

  test('既定は己の内のみ（旧 viewer と同じ 127.0.0.1）', () => {
    const db = seeded();
    const s = serve({ port: 0, db: () => db, compose: () => '' });
    try {
      expect(s.host).toBe(LOOPBACK); // Bun の既定 0.0.0.0 に落ちてはならぬ
    } finally {
      s.stop();
    }
  });

  test('広げるは明示のみ', () => {
    const db = seeded();
    const s = serve({ port: 0, host: '0.0.0.0', db: () => db, compose: () => '' });
    try {
      expect(s.host).toBe('0.0.0.0');
    } finally {
      s.stop();
    }
  });

  test('宛先が違えば返さぬ（DNS rebinding 除け）', async () => {
    const db = seeded();
    const s = serve({ port: 0, db: () => db, compose: () => '秘' });
    try {
      const bad = await fetch(`http://127.0.0.1:${s.port}/api/dashboard`, {
        headers: { Host: 'evil.example.com' },
      });
      expect(bad.status).toBe(403);
      expect(await bad.text()).not.toContain('秘');
      // 陽性対照: 正しい宛先なら返る
      const good = await fetch(`http://127.0.0.1:${s.port}/api/dashboard`);
      expect(good.status).toBe(200);
    } finally {
      s.stop();
    }
  });

  test('しくじっても内情を漏らさぬ', async () => {
    const db = seeded();
    const s = serve({
      port: 0,
      db: () => db,
      compose: () => {
        throw new Error('/mnt/c/秘密の道 で落ちた');
      },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/dashboard`);
      expect(r.status).toBe(500);
      const body = await r.text();
      expect(body).not.toContain('秘密の道');
      expect(body).not.toContain('serve.ts'); // stack も source も出さぬ
    } finally {
      s.stop();
    }
  });

  test('HTML の道は組んだ HTML を返す', async () => {
    const db = seeded();
    const s = serve({ port: 0, db: () => db, compose: () => '# 題\n- 一つ' });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/html`);
      expect(await r.text()).toBe('<h1>題</h1>\n<ul><li>一つ</li></ul>');
    } finally {
      s.stop();
    }
  });

  test('知らぬ道は 404', async () => {
    const db = seeded();
    const s = serve({ port: 0, db: () => db, compose: () => '' });
    try {
      const r = await fetch(`http://localhost:${s.port}/nazo`);
      expect(r.status).toBe(404);
    } finally {
      s.stop();
    }
  });

  test('compose が毎度呼ばれる（配信中の更新が映る）', async () => {
    const db = seeded();
    let n = 0;
    const s = serve({ port: 0, db: () => db, compose: () => `組み ${++n} 回目` });
    try {
      const a = await (await fetch(`http://localhost:${s.port}/api/dashboard`)).text();
      const b = await (await fetch(`http://localhost:${s.port}/api/dashboard`)).text();
      expect(a).not.toBe(b); // 写しを配っておらぬ——毎度組み直す
    } finally {
      s.stop();
    }
  });
});

test('**頁の script は CSP の hash で許されておる**（書き忘れると browser が黙って封じる）', async () => {
  // `default-src 'none'` のまま script-src が無く、頁が「読み込み中…」で
  // 止まった（殿が開いて発覚・2026-09-03）。curl は JS を走らせぬゆえ
  // 誰も釣れなんだ。ここでは meta の hash と script の実体を突き合わせる
  // ——どちらかだけ変えれば落ちる。
  const db = seeded();
  const s = serve({ port: 0, db: () => db, compose: () => 'x' });
  try {
    const home = await (await fetch(`http://localhost:${s.port}/`)).text();
    const meta = /script-src 'sha256-([A-Za-z0-9+/=]+)'/.exec(home);
    expect(meta).not.toBeNull();
    const body = /<script>([\s\S]*?)<\/script>/.exec(home);
    expect(body).not.toBeNull();
    const real = new Bun.CryptoHasher('sha256').update(body![1]!).digest('base64');
    expect(meta![1]).toBe(real);
  } finally {
    s.stop();
  }
});
