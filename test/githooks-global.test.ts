/**
 * global 側 git hooks の試験。
 *
 * 対象は二つ。
 *   1. .githooks/global/prepare-commit-msg — Cursor の共著を落とし、
 *      旧 sentinel を置き換え、Assisted-by を一つだけ持たせる
 *   2. scripts/setup_global_githooks.sh — 配る・冪等・退避・戻す
 *
 * どの試験も HOME を仮の dir に差し替えて走る。殿の ~/.git-hooks には触れぬ。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const HOOK = join(ROOT, '.githooks/global/prepare-commit-msg');
const SETUP = join(ROOT, 'scripts/setup_global_githooks.sh');
const TRAILER = 'Assisted-by: multi-agent-shogun-aki-tweak';

async function withHome(fn: (home: string) => void | Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'honden-ghooks-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function runSetup(home: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SETUP, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });
  return r;
}

function install(home: string) {
  const r = runSetup(home, [], { HONDEN_SETUP_ASSUME_YES: '1' });
  expect(r.status).toBe(0);
  return r;
}

/** 配った先の hook を、その置き場のまま走らせる（lib の解決も含めて確かめる）。 */
function runDeployedHook(home: string, file: string) {
  const r = spawnSync('sh', [join(home, '.git-hooks/prepare-commit-msg'), file], {
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
}

describe('global prepare-commit-msg', () => {
  test('Cursor の共著を落とし、Assisted-by を足す', async () => {
    await withHome(async (home) => {
      install(home);
      const file = join(home, 'msg');
      await writeFile(file, 'feat: 試し\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n');
      runDeployedHook(home, file);
      const out = await readFile(file, 'utf8');
      expect(out).not.toContain('Cursor');
      expect(out.split('\n').filter((l) => l === TRAILER)).toHaveLength(1);
    });
  });

  test('旧 sentinel を Assisted-by へ置き換える', async () => {
    await withHome(async (home) => {
      install(home);
      const file = join(home, 'msg');
      await writeFile(
        file,
        'fix: 試し\n\nCo-authored-by: multi-agent-shogun-aki-tweak <multi-agent-shogun-aki-tweak@users.noreply.github.com>\n',
      );
      runDeployedHook(home, file);
      const out = await readFile(file, 'utf8');
      expect(out).not.toContain('Co-authored-by');
      expect(out.split('\n').filter((l) => l === TRAILER)).toHaveLength(1);
    });
  });

  test('重なった Assisted-by は一つに畳む', async () => {
    await withHome(async (home) => {
      install(home);
      const file = join(home, 'msg');
      await writeFile(file, `fix: 試し\n\n${TRAILER}\n${TRAILER}\n`);
      runDeployedHook(home, file);
      const out = await readFile(file, 'utf8');
      expect(out.split('\n').filter((l) => l === TRAILER)).toHaveLength(1);
    });
  });
});

describe('setup_global_githooks.sh', () => {
  test('--dry-run は一切作らぬ', async () => {
    await withHome(async (home) => {
      const r = runSetup(home, ['--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('new');
      expect(existsSync(join(home, '.git-hooks'))).toBe(false);
    });
  });

  test('配る・冪等・core.hooksPath', async () => {
    await withHome(async (home) => {
      const first = install(home);
      expect(first.stdout).toContain('配った（新規）');
      expect(existsSync(join(home, '.git-hooks/prepare-commit-msg'))).toBe(true);
      expect(existsSync(join(home, '.git-hooks/lib/strip-cursor-trailers.sh'))).toBe(true);

      const second = install(home);
      expect(second.stdout).toContain('既に入っておる');
      const baks = readdirSync(join(home, '.git-hooks')).filter((f) => f.includes('.bak.'));
      expect(baks).toHaveLength(0);

      const cfg = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      });
      expect(cfg.stdout.trim()).toBe(join(home, '.git-hooks'));
    });
  });

  test('古びた配り物は退避してから配り直し、--uninstall で退避から戻る', async () => {
    await withHome(async (home) => {
      install(home);
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      const dirtied = (await readFile(dst, 'utf8')) + '# 手で汚した\n';
      await writeFile(dst, dirtied);

      const redeploy = install(home);
      expect(redeploy.stdout).toContain('退避');
      const baks = readdirSync(join(home, '.git-hooks')).filter((f) => f.includes('.bak.'));
      expect(baks).toHaveLength(1);

      const r = runSetup(home, ['--uninstall']);
      expect(r.status).toBe(0);
      expect(await readFile(dst, 'utf8')).toBe(dirtied);
    });
  });

  test('新規に配った物は --uninstall で消え、無へ戻る', async () => {
    await withHome(async (home) => {
      install(home);
      const r = runSetup(home, ['--uninstall']);
      expect(r.status).toBe(0);
      expect(readdirSync(join(home, '.git-hooks'))).toHaveLength(0);
    });
  });

  test('見知らぬ中身は --uninstall で消さぬ', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, '.git-hooks'), { recursive: true });
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      await writeFile(dst, '#!/bin/sh\n# 殿が手で書いた別物\n');
      const r = runSetup(home, ['--uninstall']);
      expect(r.status).toBe(0);
      expect(existsSync(dst)).toBe(true);
      expect(r.stdout).toContain('消さず残す');
    });
  });
});
