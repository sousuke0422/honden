import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// scripts/apply_guard_patch.sh を、使い捨ての repo と bare の遠方で撃つ。本陣の repo と
// GitHub へは決して撃たぬ（origin は tmpdir の bare repo。HOME・global・system も差し替える）。
// tsc と bun test の段は HONDEN_APPLY_GUARD_VERIFY で差し替える（script の試験の口）。
//
// HONDEN_APPLY_GUARD_SCRIPT を置けば、別の版の script で同じ試験を撃てる（陽性対照の用）。
const ROOT = join(import.meta.dir, '..');
const SCRIPT = process.env.HONDEN_APPLY_GUARD_SCRIPT ?? join(ROOT, 'scripts/apply_guard_patch.sh');
const ASSISTED = 'Assisted-by: multi-agent-shogun-aki-tweak';
const BRANCH = 'feat/x';
const GUARD0 = 'export const gate = 1;\n';

type Box = {
  base: string;
  repo: string;
  remote: string;
  env: NodeJS.ProcessEnv;
  git: (...a: string[]) => string;
  remoteTip: () => string;
};

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
}

function sandbox(): Box {
  const base = mkdtempSync(join(tmpdir(), 'honden-apply-guard-'));
  const home = join(base, 'home');
  mkdirSync(home);
  writeFileSync(join(base, 'gitconfig'), '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  delete env.HONDEN_APPLY_GUARD_VERIFY;
  const remote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  const git = (...a: string[]) => {
    const r = run('git', a, repo, env);
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  expect(run('git', ['init', '-q', '--bare', remote], base, env).status).toBe(0);
  mkdirSync(join(repo, 'src'), { recursive: true });
  git('init', '-q', '-b', BRANCH);
  writeFileSync(join(repo, 'src/guard.ts'), GUARD0);
  writeFileSync(join(repo, 'src/other.ts'), 'export const other = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  const remoteTip = () => {
    const r = run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${BRANCH}`], base, env);
    return r.stdout.trim();
  };
  return { base, repo, remote, env, git, remoteTip };
}

/** 作業木の file を書き換えて patch に落とし、作業木は元へ戻す。 */
function makePatch(b: Box, name: string, edits: Record<string, string>): { path: string; sha: string } {
  for (const [rel, text] of Object.entries(edits)) writeFileSync(join(b.repo, rel), text);
  const diff = b.git('diff');
  b.git('checkout', '--', ...Object.keys(edits));
  const path = join(b.base, name);
  writeFileSync(path, diff + '\n');
  const sha = run('sha256sum', [path], b.base, b.env).stdout.split(' ')[0]!;
  return { path, sha };
}

let msgSeq = 0;
function message(b: Box, text: string): string {
  msgSeq += 1;
  const p = join(b.base, `msg-${msgSeq}.txt`);
  writeFileSync(p, text);
  return p;
}

/** 試験の段の差し替え。src/guard.ts に BAD が在れば落ちる。 */
function verifier(b: Box): string {
  const p = join(b.base, 'verify.sh');
  writeFileSync(p, '#!/bin/sh\nif grep -q BAD src/guard.ts; then echo "試験が落ちた（作り物）" >&2; exit 1; fi\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

function apply(b: Box, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return run('bash', [SCRIPT, ...args], b.base, { ...b.env, HONDEN_APPLY_GUARD_VERIFY: verifier(b), ...extraEnv });
}

function args(b: Box, over: Partial<Record<string, string>> = {}): string[] {
  const good = makePatch(b, 'fix.diff', { 'src/guard.ts': GUARD0 + 'export const fixed = true;\n' });
  const v: Record<string, string> = {
    worktree: b.repo,
    patch: good.path,
    sha256: good.sha,
    head: b.git('rev-parse', 'HEAD'),
    remote: b.remoteTip(),
    branch: BRANCH,
    'message-file': message(b, `fix(guard): 直す\n\n本文。\n\n${ASSISTED}\n`),
    ...over,
  };
  return Object.entries(v).flatMap(([k, x]) => [`--${k}`, x!]);
}

/** 何も変わっておらぬこと: 手元の先端・作業木・遠方の先端・guard.ts の中身。 */
function unchanged(b: Box, head: string, remote: string) {
  expect(b.git('rev-parse', 'HEAD')).toBe(head);
  expect(b.git('status', '--porcelain')).toBe('');
  expect(b.remoteTip()).toBe(remote);
  expect(readFileSync(join(b.repo, 'src/guard.ts'), 'utf8')).toBe(GUARD0);
}

describe('apply_guard_patch.sh — 当てて押す', () => {
  test('正しい引数で当たり、押され、遠方の先端が新しい commit になる', () => {
    const b = sandbox();
    const head0 = b.git('rev-parse', 'HEAD');
    const r = apply(b, args(b));
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    const pushed = lines[lines.length - 1]!;
    expect(pushed).toMatch(/^[0-9a-f]{40}$/);
    expect(b.remoteTip()).toBe(pushed);
    expect(b.git('rev-parse', 'HEAD')).toBe(pushed);
    expect(b.git('rev-parse', 'HEAD^')).toBe(head0);
    // patch が触った file だけが commit に入る
    expect(b.git('show', '--name-only', '--format=', 'HEAD')).toBe('src/guard.ts');
    expect(b.git('cat-file', '-p', 'HEAD')).toContain(ASSISTED);
    // 触る file を先に示す
    expect(r.stdout).toContain('patch が触る file:');
    expect(r.stdout).toContain('    src/guard.ts');
    // 差し替えの口を使うた時は、その旨を必ず出す
    expect(r.stderr).toContain('HONDEN_APPLY_GUARD_VERIFY が置かれておる');
  });
});

describe('apply_guard_patch.sh — 検めで止まり、何も変えぬ', () => {
  const cases: [string, (b: Box) => string[], string][] = [
    ['sha256 違い', (b) => args(b, { sha256: 'f'.repeat(64) }), 'sha256 が合わぬ'],
    ['手元の先端違い', (b) => args(b, { head: '0'.repeat(40) }), '手元の先端が合わぬ'],
    ['遠方の先端違い', (b) => args(b, { remote: '0'.repeat(40) }), '遠方の先端が合わぬ'],
  ];
  for (const [name, mk, said] of cases) {
    test(name, () => {
      const b = sandbox();
      const head0 = b.git('rev-parse', 'HEAD');
      const remote0 = b.remoteTip();
      const r = apply(b, mk(b));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(said);
      unchanged(b, head0, remote0);
    });
  }

  test('作業木の汚れ', () => {
    const b = sandbox();
    const head0 = b.git('rev-parse', 'HEAD');
    const remote0 = b.remoteTip();
    const a = args(b);
    writeFileSync(join(b.repo, 'src/other.ts'), 'export const other = 2;\n');
    const r = apply(b, a);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('作業木が清くない');
    expect(b.git('rev-parse', 'HEAD')).toBe(head0);
    expect(b.remoteTip()).toBe(remote0);
    expect(readFileSync(join(b.repo, 'src/guard.ts'), 'utf8')).toBe(GUARD0);
    expect(readFileSync(join(b.repo, 'src/other.ts'), 'utf8')).toBe('export const other = 2;\n');
  });

  test('src/guard.ts 以外を触る patch は止まる（guard.ts と共に触る形も）', () => {
    const patterns: Record<string, string>[] = [
      { 'src/other.ts': 'export const other = 9;\n' },
      { 'src/guard.ts': GUARD0 + '// x\n', 'src/other.ts': 'export const other = 9;\n' },
    ];
    for (const edits of patterns) {
      const b = sandbox();
      const head0 = b.git('rev-parse', 'HEAD');
      const remote0 = b.remoteTip();
      const p = makePatch(b, 'other.diff', edits);
      const r = apply(b, args(b, { patch: p.path, sha256: p.sha }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('以外を触る');
      expect(r.stdout).toContain('    src/other.ts'); // 触る file を先に示す
      unchanged(b, head0, remote0);
    }
  });

  test('commit 文に Claude-Session か Co-authored-by が在れば止まる。Assisted-by が末尾に無くても止まる', () => {
    for (const [text, said] of [
      [`fix\n\n${ASSISTED}\nClaude-Session: https://example.invalid/x\n`, 'Claude-Session か Co-authored-by'],
      [`fix\n\nClaude-Session: https://example.invalid/x\n${ASSISTED}\n`, 'Claude-Session か Co-authored-by'],
      [`fix\n\nCo-authored-by: x <x@example.invalid>\n${ASSISTED}\n`, 'Claude-Session か Co-authored-by'],
      ['fix\n\n本文だけ\n', '末尾が'],
    ] as const) {
      const b = sandbox();
      const head0 = b.git('rev-parse', 'HEAD');
      const remote0 = b.remoteTip();
      const r = apply(b, args(b, { 'message-file': message(b, text) }));
      expect(r.status, text).toBe(1);
      expect(r.stderr, text).toContain(said);
      unchanged(b, head0, remote0);
    }
  });
});

describe('apply_guard_patch.sh — 試験が落ちれば戻す', () => {
  test('当てた物が戻り、非ゼロで、遠方は動かぬ', () => {
    const b = sandbox();
    const head0 = b.git('rev-parse', 'HEAD');
    const remote0 = b.remoteTip();
    const bad = makePatch(b, 'bad.diff', { 'src/guard.ts': GUARD0 + '// BAD\n' });
    const r = apply(b, args(b, { patch: bad.path, sha256: bad.sha }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('当てた物を戻した');
    expect(r.stderr).toContain('試験が落ちた');
    unchanged(b, head0, remote0);
  });
});

describe('apply_guard_patch.sh — 旗の誤り', () => {
  test('知らぬ旗・欠けた旗・余る引数・二度の旗・形の誤りは exit 2 で使い方を出し、何もせぬ', () => {
    const b = sandbox();
    const head0 = b.git('rev-parse', 'HEAD');
    const remote0 = b.remoteTip();
    const good = args(b);
    const drop = (flag: string) => {
      const i = good.indexOf(flag);
      return [...good.slice(0, i), ...good.slice(i + 2)];
    };
    for (const a of [
      [...good, '--force', 'yes'],
      drop('--sha256'),
      drop('--message-file'),
      [...good, 'extra'],
      [...good, '--branch', BRANCH],
      args(b, { head: 'abc1234' }),
      args(b, { sha256: 'xyz' }),
      [...good.slice(0, -1)],
    ]) {
      const r = apply(b, a);
      expect(r.status, a.join(' ')).toBe(2);
      expect(r.stderr, a.join(' ')).toContain('使い方:');
    }
    unchanged(b, head0, remote0);
  });

  test('--help は exit 0 で使い方を出す', () => {
    const b = sandbox();
    const r = apply(b, ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('使い方:');
    expect(r.stdout).toContain('--message-file');
  });
});

describe('apply_guard_patch.sh — 註と作り', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  test('頭の註に、殿が打つ物であること・門の本体だけの物であること・差し替えの口が殿の時に効かぬことを書く', () => {
    const head = text.split('\nset -euo pipefail')[0]!;
    expect(head).toContain('殿が打つ物である');
    expect(head).toContain('src/guard.ts 以外の file を触れば');
    expect(head).toContain('殿が打つ時は置かぬ');
  });
  test('force で押す形が無い', () => {
    expect(text).not.toMatch(/push[^\n]*(--force|\s-f\b|\+HEAD|\+refs)/);
  });
});
