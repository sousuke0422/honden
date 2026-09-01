import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 公にする前の身体検査。
 *
 * honden は書いた者の手元（WSL2 の `/mnt/c/Users/<名>/work/honden`）で育った。
 * **育った場所の跡が、追跡している品に残りやすい。** 試験の材、書、hook の設定。
 * 一度は実際に載せた（2026-09-01・`.codex/hooks.json` の印が仕度に書き換えられ、
 * それをそのまま刻んだ）。
 *
 * 害は機能ではなく、利用者名と作業場の配置が公に出ることである。
 */
const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

// **HEAD ではなく手元を見る。** 咎めたいのは「これから刻む中身」であって、
// 既に刻んだものではない。HEAD を見ると、直した直後に緑にならぬ。
const body = (p: string) => {
  try {
    return readFileSync(p, 'latin1');
  } catch {
    return ''; // 追跡されておるが手元に無い（sparse checkout 等）
  }
};

describe('追跡している品に、育った場所の跡を残さぬ', () => {
  test('絶対の道で `/mnt/c/Users/<名>` を指す品は無い', () => {
    // `example` は例として置いたもの（大小を問わぬ）。実在の名だけを咎める。
    const bad: string[] = [];
    for (const f of tracked()) {
      const m = body(f).match(/\/mnt\/[a-z]\/Users\/(?!example\b)[A-Za-z0-9_.-]+/gi);
      if (m) bad.push(`${f}: ${[...new Set(m)].join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  test('codex の門の入口は、実体ではなく雛形を追う', () => {
    const t = tracked();
    // 実体を追えば、仕度が書き換えた道がそのまま commit に載る
    expect(t).not.toContain('.codex/hooks.json');
    expect(t).toContain('.codex/hooks.json.example');
    expect(body('.codex/hooks.json.example')).toContain('__HONDEN_ROOT__');
  });

  test('skill の隣に住む script は、盤上に在れば追跡されている', () => {
    // `.gitignore` は whitelist 式。SKILL.md は広い許しで拾えるが scripts/ は
    // 個別の許しが要り、書き忘れると**黙って漏れる**（honden-coder・2026-09-02）。
    // 盤上に在る物と追跡されている物を突き合わせる。
    const t = new Set(tracked());
    const missing: string[] = [];
    for (const d of readdirSync('skills', { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sd = join('skills', d.name, 'scripts');
      if (!existsSync(sd)) continue;
      for (const f of readdirSync(sd)) {
        const p = join(sd, f);
        if (!t.has(p)) missing.push(p);
      }
    }
    expect(missing).toEqual([]);
  });

  test('設定の正本は追わず、雛形だけを追う', () => {
    const t = tracked();
    expect(t).not.toContain('config/settings.yaml');
    expect(t).toContain('config/settings.yaml.example');
  });
});
