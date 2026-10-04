import { describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// scripts/setup_githooks.sh を、使い捨ての repo で撃つ。本物の ~/.git-hooks も本陣の git config も
// 読まぬ（HOME・global・system を差し替える）。global の Assisted-by の hook は作り物の鎖で渡す。
//
// HONDEN_SETUP_SCRIPT を置けば、別の版の script で同じ試験を撃てる（直す前の版で落ちることを見る用）。
const ROOT = join(import.meta.dir, '..');
const SETUP = process.env.HONDEN_SETUP_SCRIPT ?? join(ROOT, 'scripts/setup_githooks.sh');
// 検めの script。直す前の版（検めが無い）で撃つ時は、HONDEN_CHECK_SCRIPT に在らぬ路を渡す。
const CHECK = process.env.HONDEN_CHECK_SCRIPT ?? join(ROOT, 'scripts/check_githooks.sh');

type Box = { base: string; repo: string; env: NodeJS.ProcessEnv };

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
}

/** repo（main に .githooks と script、枝 old は .githooks を持たぬ）を作る。 */
function sandbox(): Box {
  const base = mkdtempSync(join(tmpdir(), 'honden-setup-githooks-'));
  const home = join(base, 'home');
  mkdirSync(home);
  writeFileSync(join(base, 'gitconfig'), '[core]\n\thooksPath = /GLOBAL/hooks\n');
  const chain = join(base, 'chain');
  writeFileSync(chain, '#!/bin/sh\nprintf \'\\nAssisted-by: fake-chain\\n\' >> "$1"\n');
  chmodSync(chain, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    HONDEN_PREPARE_COMMIT_MSG_CHAIN: chain,
  };
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
  cpSync(SETUP, join(repo, 'scripts/setup_githooks.sh'));
  if (existsSync(CHECK)) cpSync(CHECK, join(repo, 'scripts/check_githooks.sh'));
  for (const f of ['prepare-commit-msg', 'commit-msg']) chmodSync(join(repo, '.githooks', f), 0o755);
  const g = (...a: string[]) => {
    const r = sh('git', a, repo, env);
    expect(r.status).toBe(0);
  };
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'old');
  g('rm', '-rq', '.githooks');
  g('commit', '-q', '-m', 'old: .githooks を持たぬ枝');
  g('checkout', '-q', 'main');
  return { base, repo, env };
}

const done = (b: Box) => rmSync(b.base, { recursive: true, force: true });
const setup = (b: Box) => sh('bash', ['scripts/setup_githooks.sh'], b.repo, b.env);
const cfg = (b: Box, ...a: string[]) => sh('git', ['config', '--file', join(b.repo, '.git/config'), ...a], b.repo, b.env);
const MSG = 'feat: x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\nCo-authored-by: Alice <alice@example.com>\n';

/** old 枝の worktree を作り、そこで commit して、最終の commit 本文を返す。 */
function commitInOldWorktree(b: Box): { wt: string; message: string; commitStatus: number | null } {
  const wt = join(b.base, 'wt-old');
  expect(sh('git', ['worktree', 'add', '-q', wt, 'old'], b.repo, b.env).status).toBe(0);
  const c = sh('git', ['commit', '-q', '--allow-empty', '-m', MSG], wt, b.env);
  const message = sh('git', ['log', '-1', '--format=%B'], wt, b.env).stdout;
  return { wt, message, commitStatus: c.status };
}

describe('setup_githooks.sh（使い捨ての repo）', () => {
  test('共有に core.bare=true が在れば exit 1 で、共有に extensions.worktreeConfig を入れぬ', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'core.bare', 'true').status).toBe(0);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('core.bare');
      expect(cfg(b, '--get', 'extensions.worktreeConfig').status).toBe(1);
    } finally {
      done(b);
    }
  });

  test('共有に core.hooksPath が在れば警めを出して続け、共有の値は変わらぬ', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'core.hooksPath', '/SHARED/legacy').status).toBe(0);
      const r = setup(b);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('全 worktree に効いておる');
      expect(r.stderr).toContain('/SHARED/legacy');
      expect(cfg(b, '--get', 'core.hooksPath').stdout.trim()).toBe('/SHARED/legacy');
    } finally {
      done(b);
    }
  });

  test('本の木に .githooks が無ければ、何も書かずに止まる', () => {
    const b = sandbox();
    try {
      expect(sh('git', ['checkout', '-q', 'old'], b.repo, b.env).status).toBe(0);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('.githooks');
      expect(cfg(b, '--get', 'extensions.worktreeConfig').status).toBe(1);
      expect(existsSync(join(b.repo, '.git/config.worktree'))).toBe(false);
    } finally {
      done(b);
    }
  });

  test('据えた後に作る、.githooks を持たぬ枝の worktree でも hook が走る（回帰）', () => {
    const b = sandbox();
    try {
      const r = setup(b);
      expect(r.status).toBe(0);
      const { wt, message, commitStatus } = commitInOldWorktree(b);
      expect(commitStatus).toBe(0);
      // 路は本の木の .githooks を指す絶対路で、新しい木へ写されても同じ先を指す
      const p = sh('git', ['config', 'core.hooksPath'], wt, b.env).stdout.trim();
      expect(p).toBe(join(b.repo, '.githooks'));
      // strip が効く・人の共著は残る・global の Assisted-by に当たる鎖が働く
      expect(message).not.toContain('cursoragent@cursor.com');
      expect(message).toContain('Co-authored-by: Alice <alice@example.com>');
      expect(message).toContain('Assisted-by: fake-chain');
    } finally {
      done(b);
    }
  });

  test('陽性対照: 旧い相対路で据えると、同じ commit で Cursor 行が残る', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'extensions.worktreeConfig', 'true').status).toBe(0);
      expect(sh('git', ['config', '--worktree', 'core.hooksPath', '.githooks'], b.repo, b.env).status).toBe(0);
      const { message, commitStatus } = commitInOldWorktree(b);
      expect(commitStatus).toBe(0);
      expect(message).toContain('cursoragent@cursor.com');
      expect(message).not.toContain('Assisted-by: fake-chain');
    } finally {
      done(b);
    }
  });

  // --worktree を落とす形は二つ。
  //  (a) config.worktree の位置に directory を置く。repo の config が読めなくなり、戻しの git まで
  //      死ぬ形（戻せぬのに「戻した」と言わぬことを固める）。
  //  (b) PATH の先頭に、`--worktree` を渡されたら落ちる git の包みを置く。repo は壊さず、
  //      「立てる前から拡張が在った」場合を作れる。
  // noopRestore: 戻しの書き込み（git -C / config --file … extensions.worktreeConfig false）を、
  // 成功を装って何もせぬ（書いたのに戻っておらぬ形）。
  const wrapGit = (b: Box, opts: { noopRestore?: boolean } = {}) => {
    const bin = join(b.base, 'bin');
    mkdirSync(bin);
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const noop = opts.noopRestore
      ? `case "$*" in *"-C / config --file"*"extensions.worktreeConfig false"*) exit 0;; esac\n`
      : '';
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\n${noop}for a in "$@"; do [ "$a" = "--worktree" ] && exit 1; done\nexec ${real} "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    b.env = { ...b.env, PATH: `${bin}:${process.env.PATH}` };
  };

  test('--worktree が落ちたら（config.worktree が読めぬ形）、拡張を外して戻し、exit 1', () => {
    const b = sandbox();
    try {
      mkdirSync(join(b.repo, '.git/config.worktree'));
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('落ちた');
      expect(r.stderr).toContain('git version');
      expect(r.stderr).toContain('元に戻した');
      // 「戻した」と言うなら、実際に戻っておる（読み返す。config.worktree が読めぬゆえ repo の外から）
      const back = sh('git', ['-C', '/', 'config', '--file', join(b.repo, '.git/config'), '--get', 'extensions.worktreeConfig'], b.base, b.env);
      expect(back.status).toBe(1);
    } finally {
      done(b);
    }
  });

  test('--worktree が落ちたら（包んだ git）、立てる前に拡張が無かった時に限り外して戻し、exit 1', () => {
    const b = sandbox();
    try {
      wrapGit(b);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('落ちた');
      expect(r.stderr).toContain('git version');
      expect(r.stderr).toContain('元に戻した');
      expect(cfg(b, '--get', 'extensions.worktreeConfig').status).toBe(1);
      expect(cfg(b, '--get', 'core.hooksPath').status).toBe(1);
    } finally {
      done(b);
    }
  });

  test('--worktree が落ちても、立てる前から在った拡張は外さぬ', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'extensions.worktreeConfig', 'true').status).toBe(0);
      wrapGit(b);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('据え付けの前から在った');
      expect(r.stderr).not.toContain('元に戻した');
      expect(cfg(b, '--get', 'extensions.worktreeConfig').stdout.trim()).toBe('true');
    } finally {
      done(b);
    }
  });

  // 戻しの片方（前から在った拡張）も、書いた後に読み返し、前の値と合った時だけ「そのまま」と言う。
  test('前の値が false の拡張: --worktree が落ちたら、前の値へ戻し、読み返して合ったと言う', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'extensions.worktreeConfig', 'false').status).toBe(0);
      wrapGit(b);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('据え付けの前から在った');
      expect(r.stderr).toContain('前の値のままと確かめた');
      expect(cfg(b, '--get', 'extensions.worktreeConfig').stdout.trim()).toBe('false');
    } finally {
      done(b);
    }
  });

  test('前の値が false の拡張: 戻しが効かなんだら、「そのまま」と言わず、今の値と手で戻す命を示す', () => {
    const b = sandbox();
    try {
      expect(cfg(b, 'extensions.worktreeConfig', 'false').status).toBe(0);
      wrapGit(b, { noopRestore: true });
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stderr).not.toContain('前の値のままと確かめた');
      expect(r.stderr).toContain('戻せなんだ');
      expect(r.stderr).toContain('今の値: true');
      expect(r.stderr).toContain("extensions.worktreeConfig 'false'");
      // 実際にも戻っておらぬ（嘘を言わなかったことの裏）
      expect(cfg(b, '--get', 'extensions.worktreeConfig').stdout.trim()).toBe('true');
    } finally {
      done(b);
    }
  });
});

// 据えた後に、指す先（本の木の .githooks）が消える窓。git は警めを出さぬ。
describe('check_githooks.sh（指す先が消える窓）', () => {
  const check = (repoDir: string, b: Box, ...a: string[]) =>
    sh('bash', ['scripts/check_githooks.sh', ...a], repoDir, b.env);

  test('窓 (1)(2): 本の木が .githooks を持たぬ枝へ移ると hook が落ち、検めが NG を並べて非ゼロ、戻せば 0', () => {
    const b = sandbox();
    try {
      const s0 = setup(b);
      expect(s0.status).toBe(0);
      expect(s0.stdout).toContain('ok  ');
      const wt = join(b.base, 'wt-old');
      expect(sh('git', ['worktree', 'add', '-q', wt, 'old'], b.repo, b.env).status).toBe(0);
      expect(check(b.repo, b).status).toBe(0);

      // 本の木が .githooks の無い枝へ移る（old は別の木が持つゆえ、detach で移る）
      expect(sh('git', ['checkout', '-q', '--detach', 'old'], b.repo, b.env).status).toBe(0);
      // 窓が現に在る: 別の木の commit に Cursor 行が残り、鎖（Assisted-by）が働かぬ
      const c = sh('git', ['commit', '-q', '--allow-empty', '-m', MSG], wt, b.env);
      expect(c.status).toBe(0);
      const msg = sh('git', ['log', '-1', '--format=%B'], wt, b.env).stdout;
      expect(msg).toContain('cursoragent@cursor.com');
      expect(msg).not.toContain('Assisted-by: fake-chain');
      // 検めは NG を並べて非ゼロ
      const bad = check(b.repo, b);
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain('NG  ');
      expect(bad.stdout).toContain('commit-msg が無い');

      // 本の木を戻せば 0
      expect(sh('git', ['checkout', '-q', 'main'], b.repo, b.env).status).toBe(0);
      const good = check(b.repo, b);
      expect(good.status).toBe(0);
      expect(good.stdout).not.toContain('NG  ');
    } finally {
      done(b);
    }
  });

  test('窓 (3): repo の在処を mv で動かすと、検めが NG と言う', () => {
    const b = sandbox();
    try {
      expect(setup(b).status).toBe(0);
      expect(sh('git', ['worktree', 'add', '-q', join(b.base, 'wt-old'), 'old'], b.repo, b.env).status).toBe(0);
      const moved = join(b.base, 'repo-moved');
      renameSync(b.repo, moved);
      const bad = check(moved, b);
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain('NG  ');
    } finally {
      done(b);
    }
  });

  test('据えておらぬ木は -- と出て NG に数えず（setup は 0 で終わる）、--all なら NG に数える', () => {
    const b = sandbox();
    try {
      // setup の前に作った木は、据えておらぬ（global の hook が走る）
      expect(sh('git', ['worktree', 'add', '-q', join(b.base, 'wt-pre'), 'old'], b.repo, b.env).status).toBe(0);
      const s0 = setup(b);
      expect(s0.status).toBe(0);
      expect(s0.stdout).toContain('--  ');
      expect(check(b.repo, b).status).toBe(0);
      expect(check(b.repo, b, '--all').status).not.toBe(0);
    } finally {
      done(b);
    }
  });

  test('setup は据えた後に検め、NG の木が在れば非ゼロで終える', () => {
    const b = sandbox();
    try {
      const bad = join(b.base, 'wt-bad');
      expect(sh('git', ['worktree', 'add', '-q', bad, 'old'], b.repo, b.env).status).toBe(0);
      expect(cfg(b, 'extensions.worktreeConfig', 'true').status).toBe(0);
      // 指す先の無い hooksPath を、その木に据えておく（据えておって、消えておる木）
      expect(sh('git', ['config', '--worktree', 'core.hooksPath', '/nonexistent/hooks'], bad, b.env).status).toBe(0);
      const r = setup(b);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('NG  ');
      expect(r.stderr).toContain('検めに NG が在る');
    } finally {
      done(b);
    }
  });
});

