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
import { serve } from '../src/serve';
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

describe('serve', () => {
  test('/ は HTML・/api/dashboard は compose の出力そのもの', async () => {
    const db = seeded();
    const md = '# 📊 戦況報告\n試験の md';
    const s = serve({ port: 0, db: () => db, compose: () => md });
    try {
      const home = await (await fetch(`http://localhost:${s.port}/`)).text();
      expect(home).toContain('<!DOCTYPE html>');
      expect(home).toContain('marked'); // md の描画役が載っておる
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
