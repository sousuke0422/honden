/**
 * 振り分けの試験。
 *
 * shogun の get_recommended_model が持っていた 3 つの穴を塞げているかを見る。
 *
 *   1. モデル名を返すだけで、誰に振れるか分からない
 *   2. cli.agents に居ないモデルを返す
 *   3. 役を見ないので、足軽の仕事に上役が混じる
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster, roleOf } from '../src/roster';
import {
  recommend,
  providerOf,
  syncLimits,
  maxBloomOf,
  readLimitsFromSettings,
  NO_LIMIT,
} from '../src/routing';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FLEET: [string, string, string][] = [
  ['shogun', 'claude', 'claude-opus-5'],
  ['gunshi', 'claude', 'claude-sonnet-5'],
  ['ashigaru1', 'claude', 'claude-fable-5'],
  ['ashigaru2', 'codex', 'gpt-5.6-sol'],
  ['ashigaru3', 'cursor', 'composer-2.5'],
];

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(
      db,
      FLEET.map(([id, cli, model]) => ({ id, role: roleOf(id), cli, model })),
    );
    // 制限があるものだけを載せる。他は表に無い＝制限なし。
    syncLimits(db, [{ model: 'composer-2.5', maxBloom: 4, costGroup: 'cursor' }]);
  });
  return db;
};

describe('系統の割り出し', () => {
  test('名の並びで見る', () => {
    expect(providerOf('claude-opus-5')).toBe('anthropic');
    expect(providerOf('gpt-5.6-sol')).toBe('openai');
    expect(providerOf('deepseek-v4-flash')).toBe('deepseek');
    expect(providerOf('composer-2.5')).toBe('cursor');
    expect(providerOf('auto')).toBe('cursor');
  });

  // 名を列挙すると新しい版で抜ける。settings.yaml の exclude_models は
  // deepseek-v4-flash / v4-pro / mimo-v2.5-pro の 3 つを並べているだけなので、
  // deepseek-v5 が出れば素通りする。
  test('新しい版でも同じ系統として拾う', () => {
    expect(providerOf('deepseek-v5-ultra')).toBe('deepseek');
    expect(providerOf('claude-opus-9')).toBe('anthropic');
  });

  test('割り出せぬものは unknown', () => {
    expect(providerOf('謎のモデル')).toBe('unknown');
  });
});

describe('能力の制限', () => {
  test('表に無いモデルは制限なし（新しいモデルが即使える）', () => {
    const db = seeded();
    expect(maxBloomOf(db, 'claude-opus-9')).toBe(NO_LIMIT);
    expect(maxBloomOf(db, 'まだ無いモデル')).toBe(NO_LIMIT);
  });

  test('表にあるものは表のとおり', () => {
    const db = seeded();
    expect(maxBloomOf(db, 'composer-2.5')).toBe(4);
  });
});

describe('振り先を挙げる', () => {
  // 穴 1・2 の確認: モデル名ではなく、実際に居る agent が返る。
  test('agent が返る', () => {
    const r = recommend(seeded(), { bloom: 3, role: 'worker' });
    expect(r.ok).toBe(true);
    expect(r.candidates.every((c) => c.agent.startsWith('ashigaru'))).toBe(true);
    expect(r.candidates.map((c) => c.agent)).toContain('ashigaru3');
  });

  // 穴 3 の確認: 足軽の仕事に上役が混じらない。
  test('足軽の仕事に上役は混じらぬ', () => {
    const r = recommend(seeded(), { bloom: 6, role: 'worker' });
    expect(r.candidates.map((c) => c.agent)).not.toContain('shogun');
    expect(r.candidates.map((c) => c.agent)).not.toContain('gunshi');
  });

  test('足りぬ者は外れ、理由が出る', () => {
    const r = recommend(seeded(), { bloom: 5, role: 'worker' });
    // composer-2.5 は L4 までなので ashigaru3 は外れる
    expect(r.candidates.map((c) => c.agent)).not.toContain('ashigaru3');
    expect(r.candidates.map((c) => c.agent).sort()).toEqual(['ashigaru1', 'ashigaru2']);
  });

  // 一番強い者を常に選ぶと、軽い仕事で高い枠を焼く。
  test('足りる中で最も軽い順に並ぶ', () => {
    const r = recommend(seeded(), { bloom: 3, role: 'worker' });
    expect(r.candidates[0]?.agent).toBe('ashigaru3'); // maxBloom 4
    expect(r.candidates[0]?.maxBloom).toBe(4);
  });

  test('手が塞がっておる者は外れる', () => {
    const r = recommend(seeded(), { bloom: 3, role: 'worker', busy: ['ashigaru3'] });
    expect(r.candidates.map((c) => c.agent)).not.toContain('ashigaru3');
  });

  test('誰も居なければ理由を並べて断る', () => {
    const r = recommend(seeded(), {
      bloom: 6,
      role: 'worker',
      busy: ['ashigaru1', 'ashigaru2', 'ashigaru3'],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('別の仕事を握っておる');
    expect(r.message).toContain('仕事を分けて');
  });

  test('bloom が範囲の外なら断る', () => {
    expect(recommend(seeded(), { bloom: 7 }).ok).toBe(false);
    expect(recommend(seeded(), { bloom: 0 }).message).toContain('1 から 6');
  });

  test('名簿が空なら断る', () => {
    const db = openStore({ path: ':memory:' });
    const r = recommend(db, { bloom: 3 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('名簿が空');
  });
});

describe('切り替えれば振れる者', () => {
  // いま走っていないモデルを挙げること自体は問題ない。switch_cli.sh で
  // どの agent もどのモデルへ切り替えられる。fable が過剰／不足なときに
  // opus や sonnet へ寄せる筋もある。
  const weakFleet = () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      syncRoster(db, [
        { id: 'ashigaru1', role: 'worker', cli: 'cursor', model: 'composer-2.5' },
        { id: 'ashigaru2', role: 'worker', cli: 'cursor', model: 'composer-2.5' },
        { id: 'shogun', role: 'commander', cli: 'claude', model: 'claude-opus-5' },
      ]);
      syncLimits(db, [
        { model: 'composer-2.5', maxBloom: 4, costGroup: 'cursor' },
        { model: 'claude-opus-5', maxBloom: 6, costGroup: 'claude_max' },
        // 誰も走らせていないが、切り替え先としては挙げてよい
        { model: 'gpt-5.5', maxBloom: 6, costGroup: 'chatgpt_plus' },
      ]);
    });
    return db;
  };

  test('能力で外れた者は、切り替え案つきで出る', () => {
    const r = recommend(weakFleet(), { bloom: 6, role: 'worker' });
    expect(r.ok).toBe(false);
    expect(r.switchable.map((s) => s.agent).sort()).toEqual(['ashigaru1', 'ashigaru2']);
    expect(r.switchable[0]?.from).toBe('composer-2.5');
    expect(r.message).toContain('切り替えれば振れる者');
  });

  test('切り替え先を今載せておる者が居れば、その CLI も添える', () => {
    const r = recommend(weakFleet(), { bloom: 6, role: 'worker' });
    const s = r.switchable.find((x) => x.to === 'claude-opus-5');
    expect(s?.cli).toBe('claude');
    expect(r.message).toContain('switch_cli.sh');
  });

  // 手が塞がっている者を切り替えても解けない。
  test('手が塞がっておる者は切り替え案に出さぬ', () => {
    const r = recommend(weakFleet(), { bloom: 6, role: 'worker', busy: ['ashigaru1'] });
    expect(r.switchable.map((s) => s.agent)).toEqual(['ashigaru2']);
  });

  test('素性で外れた者も切り替え案に出さぬ', () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      syncRoster(db, [{ id: 'ashigaru1', role: 'worker', cli: 'opencode', model: 'deepseek-v5' }]);
      syncLimits(db, [{ model: 'claude-opus-5', maxBloom: 6, costGroup: 'claude_max' }]);
    });
    const r = recommend(db, { bloom: 6, role: 'worker', allowedProviders: ['anthropic'] });
    expect(r.switchable).toEqual([]);
    expect(r.message).toContain('系統が deepseek');
  });

  test('いまのまま振れる者が居れば、切り替えは要らぬ', () => {
    const r = recommend(seeded(), { bloom: 3, role: 'worker' });
    expect(r.ok).toBe(true);
    expect(r.switchable).toEqual([]);
  });
});

describe('素性で締める', () => {
  const chinese = () => {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      syncRoster(db, [
        { id: 'ashigaru1', role: 'worker', cli: 'opencode', model: 'deepseek-v5-ultra' },
        { id: 'ashigaru2', role: 'worker', cli: 'codex', model: 'gpt-5.6-sol' },
        { id: 'ashigaru3', role: 'worker', cli: 'x', model: '謎のモデル' },
      ]);
    });
    return db;
  };

  // 金融のように素性を問う場面。名の列挙では新しい版が抜けるので系統で見る。
  test('許した系統だけが残る', () => {
    const r = recommend(chinese(), { bloom: 5, role: 'worker', allowedProviders: ['openai', 'anthropic'] });
    expect(r.candidates.map((c) => c.agent)).toEqual(['ashigaru2']);
  });

  test('新しい版でも同じ系統として外れる', () => {
    const r = recommend(chinese(), { bloom: 5, allowedProviders: ['openai'] });
    expect(r.message ?? '').toBe('');
    expect(r.candidates.map((c) => c.model)).not.toContain('deepseek-v5-ultra');
  });

  // 素性は能力と既定の向きが逆。割り出せないものは通さない。
  test('系統を割り出せぬ者も外れる', () => {
    const r = recommend(chinese(), { bloom: 5, allowedProviders: ['openai'] });
    expect(r.candidates.map((c) => c.agent)).not.toContain('ashigaru3');
  });

  test('締めなければ全員残る', () => {
    const r = recommend(chinese(), { bloom: 5 });
    expect(r.candidates.length).toBe(3);
  });
});

describe('settings.yaml から制限を読む', () => {
  test('capability_tiers を読む', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-lim-'));
    const p = join(dir, 's.yaml');
    writeFileSync(
      p,
      'capability_tiers:\n  composer-2.5:\n    max_bloom: 4\n    cost_group: cursor\n  claude-opus-5:\n    max_bloom: 6\n    cost_group: claude_max\n',
      'utf8',
    );
    try {
      const l = readLimitsFromSettings(p);
      expect(l.find((x) => x.model === 'composer-2.5')?.maxBloom).toBe(4);
      expect(l.find((x) => x.model === 'claude-opus-5')?.costGroup).toBe('claude_max');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('capability_tiers が無ければ空（制限なしと同じ）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-lim2-'));
    const p = join(dir, 's.yaml');
    writeFileSync(p, 'language: ja\n', 'utf8');
    try {
      expect(readLimitsFromSettings(p)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
