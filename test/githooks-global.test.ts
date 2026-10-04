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
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const HOOK = join(ROOT, '.githooks/global/prepare-commit-msg');
const SETUP = join(ROOT, 'scripts/setup_global_githooks.sh');
const TRAILER = 'Assisted-by: multi-agent-shogun-aki-tweak';
const SENTINEL =
  'Co-authored-by: multi-agent-shogun-aki-tweak <multi-agent-shogun-aki-tweak@users.noreply.github.com>';

// 実行権の試験は、tmpdir が実行権を効かせる fs の時だけ意味を持つ（DrvFs 等では chmod -x が効かず、
// 試験が偽に通る）。先に chmod -x が効くかを確かめ、効かねば skip と明示する（setup-githooks.test と同じ探り）。
const EXEC_WORKS = (() => {
  const d = mkdtempSync(join(tmpdir(), 'honden-execprobe-'));
  try {
    const f = join(d, 'probe');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o755);
    accessSync(f, constants.X_OK);
    chmodSync(f, 0o644);
    try {
      accessSync(f, constants.X_OK);
      return false; // 外したのに実行できる＝この fs は実行権を効かせぬ
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
const execTest = test.skipIf(!EXEC_WORKS);
if (!EXEC_WORKS) console.warn('githooks-global.test: この tmpdir は実行権を効かせぬ。実行権の試験は skip する。');

async function withHome(fn: (home: string) => void | Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'honden-ghooks-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * 隔離した環境。HOME だけでなく global の git config の在処も仮の HOME へ向け、
 * system の config も読ませぬ（XDG 等から本物の config へ落ちる道を断つ）。
 */
function isoEnv(home: string, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.HONDEN_GLOBAL_HOOKS_DIR;
  delete base.XDG_CONFIG_HOME;
  return {
    ...base,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...env,
  };
}

function runSetup(home: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SETUP, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: isoEnv(home, env),
  });
  return r;
}

/** 仮の HOME に偽の命を置き、PATH の頭に足す（date を止める・chmod を空振りさせる用）。 */
function fakeBin(home: string, scripts: Record<string, string>): Record<string, string> {
  const dir = join(home, 'fakebin');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/** dir の中身（名と内容）を写す。手付かずかを比べる用。 */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return '(無い)';
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, name.name);
      if (name.isDirectory()) {
        out.push(`${rel}${name.name}/`);
        walk(p, `${rel}${name.name}/`);
      } else {
        out.push(`${rel}${name.name}\n${readFileSync(p, 'utf8')}`);
      }
    }
  };
  walk(dir, '');
  return out.join('\n---\n');
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
    env: isoEnv(home),
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

  test('CRLF の本文でも旧 sentinel を Assisted-by へ置き換える', async () => {
    // LF の同じ本文は上の「旧 sentinel を Assisted-by へ置き換える」が通す（陽性対照）。
    await withHome(async (home) => {
      install(home);
      const file = join(home, 'msg');
      await writeFile(file, `fix: 試し\r\n\r\n${SENTINEL}\r\n`);
      runDeployedHook(home, file);
      const lines = (await readFile(file, 'utf8')).split('\n').map((l) => l.replace(/\r$/, ''));
      expect(lines.filter((l) => l.startsWith('Co-authored-by'))).toHaveLength(0);
      expect(lines.filter((l) => l === TRAILER)).toHaveLength(1);
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
        env: isoEnv(home),
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

  execTest('中身が同じでも実行権が落ちておれば not-exec と出し、据え直しで -x に戻す', async () => {
    await withHome(async (home) => {
      install(home);
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      chmodSync(dst, 0o644);

      const dry = runSetup(home, ['--dry-run']);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain(`${dst}: not-exec`);
      expect(() => accessSync(dst, constants.X_OK)).toThrow(); // --dry-run は直さぬ

      const fix = install(home);
      expect(fix.stdout).toContain('権を直した');
      accessSync(dst, constants.X_OK);
      // 中身は同じゆえ退避は作らぬ。
      expect(readdirSync(join(home, '.git-hooks')).filter((f) => f.includes('.bak.'))).toHaveLength(0);
    });
  });

  execTest('chmod の後も実行できねば、非ゼロで止まる', async () => {
    await withHome(async (home) => {
      install(home);
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      chmodSync(dst, 0o644);
      // chmod を空振りさせる。git は実行権の無い hook を黙って飛ばすゆえ、ここで止まらねばならぬ。
      const r = runSetup(home, [], { HONDEN_SETUP_ASSUME_YES: '1', ...fakeBin(home, { chmod: 'exit 0' }) });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('実行できぬ');
    });
  });

  test('引数が二つ以上なら何もせず exit 2（--uninstall --dry-run が書き換えぬ）', async () => {
    await withHome(async (home) => {
      install(home);
      const before = snapshot(join(home, '.git-hooks'));
      const r = runSetup(home, ['--uninstall', '--dry-run']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('引数は一つまで');
      expect(snapshot(join(home, '.git-hooks'))).toBe(before);
    });
  });

  test('同じ秒に二度退避しても潰さず、--uninstall で最初の元の物まで辿れる', async () => {
    await withHome(async (home) => {
      install(home);
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      const sameSecond = fakeBin(home, { date: 'echo 20260101000000' });

      const first = (await readFile(dst, 'utf8')) + '# 一度目に手で汚した\n';
      await writeFile(dst, first);
      expect(runSetup(home, [], { HONDEN_SETUP_ASSUME_YES: '1', ...sameSecond }).status).toBe(0);

      const second = (await readFile(dst, 'utf8')) + '# 二度目に手で汚した\n';
      await writeFile(dst, second);
      expect(runSetup(home, [], { HONDEN_SETUP_ASSUME_YES: '1', ...sameSecond }).status).toBe(0);

      const baks = readdirSync(join(home, '.git-hooks')).filter((f) => f.startsWith('prepare-commit-msg.bak.'));
      expect(baks.sort()).toEqual(['prepare-commit-msg.bak.20260101000000', 'prepare-commit-msg.bak.20260101000000.1']);

      // --uninstall は一層ずつ戻す。層が残っておれば、そう告げて次の名を示す。
      const un1 = runSetup(home, ['--uninstall']);
      expect(un1.status).toBe(0);
      expect(await readFile(dst, 'utf8')).toBe(second);
      expect(un1.stdout).toContain('まだ残っておる');
      expect(un1.stdout).toContain(`次は ${dst}.bak.20260101000000）`);

      const un2 = runSetup(home, ['--uninstall']);
      expect(un2.status).toBe(0);
      expect(await readFile(dst, 'utf8')).toBe(first);
      expect(un2.stdout).not.toContain('まだ残っておる');
    });
  });

  test('--uninstall は退避の連番を数で並べる（.10 は .2 より新しい）', async () => {
    await withHome(async (home) => {
      install(home);
      const dst = join(home, '.git-hooks/prepare-commit-msg');
      const t = '20260101000000';
      await writeFile(`${dst}.bak.20251231235959`, 'older second\n');
      await writeFile(`${dst}.bak.${t}`, 'seq 0\n');
      await writeFile(`${dst}.bak.${t}.2`, 'seq 2\n');
      await writeFile(`${dst}.bak.${t}.10`, 'seq 10\n');

      expect(runSetup(home, ['--uninstall']).status).toBe(0);
      expect(await readFile(dst, 'utf8')).toBe('seq 10\n');
      expect(runSetup(home, ['--uninstall']).status).toBe(0);
      expect(await readFile(dst, 'utf8')).toBe('seq 2\n');
    });
  });
});
