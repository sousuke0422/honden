/**
 * 隔離（fs.default: deny）の下でも、足軽の実効の CODEX_HOME を rw で bind する。
 *
 * 使い捨ての HOME・正本で撃つ。本物の ~/.codex と本陣の settings には触れぬ。
 * HOME は /var/tmp に作る——tmpdir（/tmp の下）に置くと、全ての道が「/tmp の下」で
 * 止まり、通る形を撃てぬ。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { SETTINGS_PATH_KEY } from '../src/config';
import { fsArgs, isolatedCodexHomeProblem } from '../src/isolate';
import { runIsolateWrap, runGuardSelftest } from '../src/main';

// 家の道は runIsolateWrap・runGuardSelftest・fsArgs の口へ明示で渡す。走る中で
// process.env.HOME を差し替えても Bun の os.homedir() は従わぬ（起動の時の値のまま）ゆえ、
// 差し替えでは本物の家を守れぬ。口を使わぬ版（直す前の版）を撃つ時は、bun を起こす時に
// HOME を使い捨ての道にして起こすこと。
const BASE = mkdtempSync('/var/tmp/honden-isolate-codex-');
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });
afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

// 道具の関所（bwrap が道に在るか）は口で注ぎ替える。CI の機には bwrap が無く、手元には在る。
// 判じ（CODEX_HOME の bind と止める形）は道具の在る無しに依らず確かめる。関所そのものは下の
// 「道具が無ければ止まる」で、在らぬと答える口を渡して確かめる。
const HAS = (tool: string) => `/fake/bin/${tool}`;
const NONE = () => null;

const ISO = 'isolation:\n  level: bwrap\n  net:\n    default: deny\n  fs:\n    default: deny\n    write: []\n';

/** 設定を書き、使い捨ての正本に在り処を覚えさせる。 */
function store(settings: string): string {
  const dir = mkdtempSync(join(BASE, 'db-'));
  const sp = join(dir, 'settings.yaml');
  writeFileSync(sp, settings);
  const path = join(dir, 'h.db');
  const db = openStore({ path });
  tx(db, () => setSetting(db, SETTINGS_PATH_KEY, sp, 'roster'));
  db.close();
  return path;
}
const agentWith = (name: string, cli: string, codexHome?: string) =>
  `    ${name}:\n      type: ${cli}\n` + (codexHome !== undefined ? `      env:\n        CODEX_HOME: "${codexHome}"\n` : '');
const settingsOf = (...agents: string[]) => `cli:\n  agents:\n${agents.join('')}${ISO}`;
const mk = (p: string) => {
  mkdirSync(join(p, 'packages'), { recursive: true });
  return p;
};

describe('bwrap の引数（fsArgs）', () => {
  const yes = () => true;
  test('(1) カスタム CODEX_HOME は --bind、その packages は --ro-bind で重なる', () => {
    const args = fsArgs({ write: [] }, 'codex', yes, '/home/me', '/home/me/.codex-a3').join(' ');
    expect(args).toContain('--bind /home/me/.codex-a3 /home/me/.codex-a3');
    expect(args).toContain('--ro-bind /home/me/.codex-a3/packages /home/me/.codex-a3/packages');
    expect(args).not.toContain('/home/me/.codex ');
    // ro は rw の後に重なる（後の bind が勝つ。packages を封じる順）
    expect(args.indexOf('--ro-bind /home/me/.codex-a3/packages')).toBeGreaterThan(args.indexOf('--bind /home/me/.codex-a3 '));
  });
  test('(2) 陽性対照: CODEX_HOME の無い codex は今どおり ~/.codex', () => {
    const args = fsArgs({ write: [] }, 'codex', yes, '/home/me').join(' ');
    expect(args).toContain('--bind /home/me/.codex /home/me/.codex');
    expect(args).toContain('--ro-bind /home/me/.codex/packages /home/me/.codex/packages');
  });
  test('(4) claude と cursor の書き道は、CODEX_HOME を渡されても変わらぬ', () => {
    for (const cli of ['claude', 'cursor']) {
      expect(fsArgs({ write: [] }, cli, yes, '/home/me', '/home/me/.codex-a3')).toEqual(fsArgs({ write: [] }, cli, yes, '/home/me'));
    }
  });
});

describe('隔離の下で許せぬ CODEX_HOME（isolatedCodexHomeProblem）', () => {
  const where = { home: '/home/me', dbDir: '/home/me/.honden', repoRoot: '/srv/honden' };
  test('(3) 止める形', () => {
    for (const [p, said] of [
      ['/tmp/codex-a3', '/tmp の下'],
      ['/tmp', '/tmp の下'],
      ['/home/me', '$HOME そのもの'],
      ['/home/me/', '$HOME そのもの'],
      ['/', '祖先'],
      ['/home', '祖先'],
      ['/home/me/.honden/codex', '本陣の正本'],
      ['/srv/honden/.codex', 'honden の repo'],
      ['/srv', 'honden の repo'],
    ] as const) {
      const why = isolatedCodexHomeProblem(p, where);
      expect(why, p).not.toBeNull();
      expect(why!, p).toContain(said);
    }
  });
  test('陽性対照: $HOME の下の、本陣と repo に掛からぬ dir は通す', () => {
    for (const p of ['/home/me/.codex-a3', '/home/me/.honden-not/x', '/srv/honden2/x', '/data/codex']) {
      expect(isolatedCodexHomeProblem(p, where), p).toBeNull();
    }
  });
});

describe('honden isolate wrap --agent（settings から実効の CODEX_HOME を引く）', () => {
  test('(1) カスタム CODEX_HOME と fs.default: deny の併用で、その道が --bind・packages が --ro-bind', () => {
    const h = mk(join(HOME, '.codex-ashigaru3'));
    mk(join(HOME, '.codex'));
    const db = store(settingsOf(agentWith('ashigaru3', 'codex', h)));
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME, HAS);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`--bind ${h} ${h}`);
    expect(r.out).toContain(`--ro-bind ${h}/packages ${h}/packages`);
    expect(r.out).not.toContain(`--bind ${HOME}/.codex `);
  });

  test('(2) 陽性対照: env の無い codex の足軽は今どおり ~/.codex', () => {
    const d = mk(join(HOME, '.codex'));
    const db = store(settingsOf(agentWith('ashigaru1', 'codex')));
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME, HAS);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`--bind ${d} ${d}`);
    expect(r.out).toContain(`--ro-bind ${d}/packages ${d}/packages`);
  });

  test('(3) /tmp の下・$HOME・~/.honden の下・在らぬ道の CODEX_HOME で、理由と直し方を示して止まる', () => {
    mkdirSync(join(HOME, '.honden/codex'), { recursive: true });
    for (const [p, said] of [
      ['/tmp/codex-ashigaru3', '/tmp の下'],
      [HOME, '$HOME そのもの'],
      [join(HOME, '.honden/codex'), '本陣の正本'],
      [join(HOME, '.codex-not-made'), '在らぬ'],
    ] as const) {
      const db = store(settingsOf(agentWith('ashigaru3', 'codex', p)));
      const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME, HAS);
      expect(r.code, p).not.toBe(0);
      expect(r.err, p).toContain(said);
      expect(r.out ?? '', p).toBe(''); // 包んだ命を返さぬ（裸でも起こさぬ）
      if (said !== '在らぬ') expect(r.err, p).toContain(`${HOME}/.codex-ashigaru3`); // 直し方の例
    }
  });

  test('陽性対照: 隔離が無い（level が bwrap でない）時は、/tmp の下でも止めぬ', () => {
    const sp = `cli:\n  agents:\n${agentWith('ashigaru3', 'codex', '/tmp/codex-ashigaru3')}`;
    const db = store(sp);
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME, HAS);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('codex --search');
  });

  test('(4) claude と cursor の足軽は、CODEX_HOME の判じも置き換えもせぬ', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    for (const cli of ['claude', 'cursor']) {
      const db = store(settingsOf(agentWith('ashigaru2', cli, '/tmp/codex-x')));
      const r = runIsolateWrap(db, `${cli} --x`, cli, 'ashigaru2', HOME, HAS);
      expect(r.code, `${cli}: ${r.err}`).toBe(0);
      expect(r.out, cli).not.toContain('codex-x');
    }
  });
});

describe('道具が無ければ止まる（本番の関所。口で注ぎ替えても関所そのものは残る）', () => {
  test('bwrap が道に無ければ、包んだ命を返さず非ゼロで止まる（裸で起こさぬ）', () => {
    mkdirSync(join(HOME, '.codex/packages'), { recursive: true });
    const db = store(settingsOf(agentWith('ashigaru1', 'codex')));
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME, NONE);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('隔離に bwrap が要るが、道に無い');
    expect(r.out ?? '').toBe('');
  });

  test('outbound を許す構えでは pasta も問い、無ければ止まる', () => {
    const db = store(
      `cli:\n  agents:\n${agentWith('ashigaru1', 'codex')}isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [outbound]\n`,
    );
    const asked: string[] = [];
    const onlyBwrap = (t: string) => {
      asked.push(t);
      return t === 'bwrap' ? '/fake/bin/bwrap' : null;
    };
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME, onlyBwrap);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('隔離に pasta が要るが、道に無い');
    expect(asked).toContain('pasta');
  });

  test('陽性対照: 口を省けば Bun.which を使う（本番の既定）', () => {
    // 口を省いた時と、Bun.which を明示で渡した時が同じ答えになる。どちらの機でも成り立つ
    const db = store(settingsOf(agentWith('ashigaru1', 'codex')));
    const byDefault = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME);
    const byBun = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME, (t) => Bun.which(t));
    expect(byDefault).toEqual(byBun);
    expect(byDefault.code === 0).toBe(Bun.which('bwrap') !== null);
  });
});

describe('(5) selftest が見る道と、檻の中で codex が書く道は同じ', () => {
  test('同じ settings から、selftest の CODEX_HOME= と wrap の --bind が同じ道を指す', () => {
    const h = mk(join(HOME, '.codex-ashigaru5'));
    const root = mkdtempSync(join(BASE, 'root-'));
    mkdirSync(join(root, '.codex/hooks'), { recursive: true });
    writeFileSync(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: 'bash .codex/hooks/guard.sh' }] } }));
    writeFileSync(join(root, '.codex/hooks/guard.sh'), `#!/bin/bash\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"deny"}}'\n`);
    writeFileSync(join(h, 'config.toml'), `[hooks."${root}/.codex/hooks.json"]\ntrusted = true\n`);
    const db = store(settingsOf(agentWith('ashigaru5', 'codex', h)));
    const st = runGuardSelftest(root, db, HOME);
    const line = (st.out ?? '').split('\n').find((l) => l.includes('ashigaru5'))!;
    const seen = /CODEX_HOME=([^）]+)）/.exec(line)?.[1];
    const w = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru5', HOME, HAS);
    const bound = /--bind (\S+) \1 --ro-bind \1\/packages/.exec(w.out ?? '')?.[1];
    expect(seen).toBe(h);
    expect(bound).toBe(h);
    expect(line).toContain('生きておる');
  });
});

describe('(A) 包んだ命の引数は、どんな字面でもホストの shell に解かれず元のまま bwrap に渡る', () => {
  // 実在の dir を、置換・backtick・; ・単引用・空白・$ を含む名で使い捨ての家の下に作る。
  // 包んだ命を bash に解かせ、argv を書き出すだけの贋の bwrap で受ける。印の file は
  // 使い捨ての dir（cwd）の中にだけ出来うる形にしてある（; の後ろは在らぬ命の名）。
  const WEIRD = "cx a$b 'q' $(touch mark1) ;zzhonden_nocmd `touch mark2`";

  /** 包んだ命を bash に解かせ、贋の bwrap が受けた argv と、cwd に出来た file を返す。 */
  function runWrapped(cmd: string): { argv: string[]; made: string[] } {
    const box = mkdtempSync(join(BASE, 'box-'));
    const bin = join(box, 'bin');
    mkdirSync(bin);
    const out = join(box, 'argv.bin');
    writeFileSync(join(bin, 'bwrap'), `#!/bin/bash\nfor a in "$@"; do printf '%s\\0' "$a"; done > "$ARGV_OUT"\n`);
    chmodSync(join(bin, 'bwrap'), 0o755);
    const cwd = join(box, 'cwd');
    mkdirSync(cwd);
    Bun.spawnSync(['bash', '-c', cmd], { cwd, env: { PATH: `${bin}:/usr/bin:/bin`, ARGV_OUT: out, HOME } });
    const argv = existsSync(out) ? readFileSync(out, 'utf8').split('\0').slice(0, -1) : [];
    return { argv, made: readdirSync(cwd) };
  }
  const seq = (argv: string[], ...want: string[]) =>
    argv.some((_, i) => want.every((w, k) => argv[i + k] === w));

  test('CODEX_HOME: 置換も ; も走らず、--bind と --ro-bind の道が一字違わず渡る', () => {
    const h = join(HOME, WEIRD);
    mkdirSync(join(h, 'packages'), { recursive: true });
    const db = store(`cli:\n  agents:\n    ashigaru3:\n      type: codex\n      env:\n        CODEX_HOME: ${JSON.stringify(h)}\n${ISO}`);
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME, HAS);
    expect(r.code, r.err).toBe(0);
    const { argv, made } = runWrapped(r.out!);
    expect(made).toEqual([]); // 印が出来ぬ（$(…) も backtick も ; の後ろも走らぬ）
    expect(seq(argv, '--bind', h, h)).toBe(true);
    expect(seq(argv, '--ro-bind', `${h}/packages`, `${h}/packages`)).toBe(true);
    expect(argv.slice(-3)).toEqual(['bash', '-lc', 'codex --search']);
  });

  test('fs.write の道も同じ口を通る（設定に書いた道が素で命に入らぬ）', () => {
    const w = join(HOME, `work ${WEIRD}`);
    mkdirSync(w, { recursive: true });
    mkdirSync(join(HOME, '.codex/packages'), { recursive: true });
    const iso = `isolation:\n  level: bwrap\n  net:\n    default: deny\n  fs:\n    default: deny\n    write: [${JSON.stringify(w)}]\n`;
    const db = store(`cli:\n  agents:\n    ashigaru1: { type: codex }\n${iso}`);
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME, HAS);
    expect(r.code, r.err).toBe(0);
    const { argv, made } = runWrapped(r.out!);
    expect(made).toEqual([]);
    expect(seq(argv, '--bind', w, w)).toBe(true);
  });

  test('陽性対照: 引用の要らぬ道の命は、今の見た目のまま（素の引数）', () => {
    const r = runIsolateWrap(store(settingsOf(agentWith('ashigaru1', 'codex'))), 'codex --search', 'codex', 'ashigaru1', HOME, HAS);
    expect(r.out).toStartWith('bwrap --ro-bind / / --tmpfs /tmp');
    expect(r.out).toEndWith(`--die-with-parent --unshare-net -- bash -lc 'codex --search'`);
  });
});

describe('symlink の別名を介しても、守る物に掛かる CODEX_HOME は止まる（実体で判じる）', () => {
  // symlink も、その向け先も、すべて使い捨ての家（/var/tmp の下）と使い捨ての /tmp の dir の
  // 中だけに作る。本物の ~/.honden・~/.codex・正本・repo を指す symlink は作らぬ。
  // 門の repo は runIsolateWrap では本物の REPO_ROOT ゆえ、偽の repo を渡せる判じの関数で撃つ。
  const codexDb = (h: string) =>
    store(`cli:\n  agents:\n    ashigaru3:\n      type: codex\n      env:\n        CODEX_HOME: ${JSON.stringify(h)}\n${ISO}`);
  const freshHome = () => {
    const home = mkdtempSync(join(BASE, 'h-'));
    mkdirSync(join(home, '.honden/codex/packages'), { recursive: true });
    return home;
  };
  const wrapAs = (db: string, home: string) => runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', home, HAS);

  test('(1) 正本の在り処（~/.honden と正本の dir）を指す別名で止まる', () => {
    const home = freshHome();
    const a1 = join(home, '.codex-a1');
    symlinkSync(join(home, '.honden/codex'), a1);
    let r = wrapAs(codexDb(a1), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('本陣の正本');
    expect(r.out ?? '').toBe('');
    // 正本の dir（HONDEN_DB の dir）を指す別名。正本を作ってから、その dir へ向ける
    const a2 = join(home, '.codex-a2');
    const db = codexDb(a2);
    mkdirSync(join(dirname(db), 'packages'), { recursive: true });
    symlinkSync(dirname(db), a2);
    r = wrapAs(db, home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('本陣の正本');
  });

  test('(2) 門の repo（とその .codex）を指す別名で止まる（偽の repo で判じの関数を撃つ）', () => {
    const home = freshHome();
    const repo = mkdtempSync(join(BASE, 'repo-'));
    mkdirSync(join(repo, '.codex'), { recursive: true });
    for (const [name, target] of [['.codex-r1', repo], ['.codex-r2', join(repo, '.codex')]] as const) {
      const link = join(home, name);
      symlinkSync(target, link);
      const why = isolatedCodexHomeProblem(link, { home, repoRoot: repo });
      expect(why, name).not.toBeNull();
      expect(why!, name).toContain('honden の repo');
    }
  });

  test('(3) /tmp の下を指す別名で止まる', () => {
    const home = freshHome();
    const t = mkdtempSync(join(tmpdir(), 'honden-c223-'));
    expect(t.startsWith('/tmp/')).toBe(true);
    mkdirSync(join(t, 'packages'));
    const link = join(home, '.codex-t');
    symlinkSync(t, link);
    const r = wrapAs(codexDb(link), home);
    rmSync(t, { recursive: true, force: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('/tmp の下');
  });

  test('(4) $HOME そのものを指す別名で止まる', () => {
    const home = freshHome();
    const link = join(home, '.codex-h');
    symlinkSync(home, link);
    const r = wrapAs(codexDb(link), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('$HOME そのもの');
  });

  test('道の途中の要素が symlink の形（$HOME/link/codex で link が ~/.honden を指す）でも止まる', () => {
    const home = freshHome();
    symlinkSync(join(home, '.honden'), join(home, 'link'));
    const r = wrapAs(codexDb(join(home, 'link/codex')), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('本陣の正本');
  });

  test('壊れた symlink（指す先が在らぬ）は、解けぬゆえ止まる', () => {
    const home = freshHome();
    const link = join(home, '.codex-broken');
    symlinkSync(join(home, 'no-such-dir'), link);
    const r = wrapAs(codexDb(link), home);
    expect(r.code).not.toBe(0);
  });

  test('陽性対照: symlink を介さぬ普通の CODEX_HOME は、その道のまま bind する', () => {
    const home = freshHome();
    const h = join(home, '.codex-plain');
    mkdirSync(join(h, 'packages'), { recursive: true });
    const r = wrapAs(codexDb(h), home);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`--bind ${h} ${h}`);
  });

  test('陽性対照: 守る物を指さぬ symlink は通り、判じた実体の道を bind する', () => {
    const home = freshHome();
    const real = join(home, 'codex-real');
    mkdirSync(join(real, 'packages'), { recursive: true });
    const link = join(home, '.codex-ok');
    symlinkSync(real, link);
    const r = wrapAs(codexDb(link), home);
    expect(r.code, r.err).toBe(0);
    const rp = realpathSync(real);
    expect(r.out).toContain(`--bind ${rp} ${rp}`);
    expect(r.out).toContain(`--ro-bind ${rp}/packages ${rp}/packages`);
    expect(r.out).not.toContain(link);
  });
});

describe('判じてから檻が起こるまでの差し替え（TOCTOU）——どの檻からも書ける道の内の CODEX_HOME は止まる', () => {
  // 差し替えを打てるのは、檻の中の足軽が rw で持つ道だけと定める（足軽と本陣は同じ uid ゆえ、
  // 檻の外の手は数えぬ）。陣の全ての足軽の檻の rw の道（fs.write・各 CLI の書き道・各々の
  // CODEX_HOME）と、CODEX_HOME の実体が重なれば止める。使い捨ての家の中だけで撃つ。
  const fresh = () => {
    const home = mkdtempSync(join(BASE, 't-'));
    mkdirSync(join(home, '.honden/codex'), { recursive: true });
    return home;
  };
  const isoWith = (write: string[]) =>
    `isolation:\n  level: bwrap\n  net:\n    default: deny\n  fs:\n    default: deny\n    write: ${JSON.stringify(write)}\n`;
  const codexAgent = (id: string, h?: string) =>
    `    ${id}:\n      type: codex\n` + (h ? `      env:\n        CODEX_HOME: ${JSON.stringify(h)}\n` : '');
  const plainAgent = (id: string, cli: string) => `    ${id}:\n      type: ${cli}\n`;
  const dbOf = (agents: string[], write: string[]) => store(`cli:\n  agents:\n${agents.join('')}${isoWith(write)}`);
  const wrap3 = (db: string, home: string) => runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', home, HAS);
  const mkc = (p: string) => mkdirSync(join(p, 'packages'), { recursive: true });

  test('(1) fs.write（足軽の workspace）の内に在る CODEX_HOME は止まる', () => {
    const home = fresh();
    const h = join(home, 'work/codex-a3');
    mkc(h);
    const r = wrap3(dbOf([codexAgent('ashigaru3', h), plainAgent('ashigaru1', 'claude')], [join(home, 'work')]), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('rw で持つ道');
    expect(r.err).toContain(join(home, 'work'));
    expect(r.out ?? '').toBe('');
  });

  test('(1) 他の足軽の CLI の書き道（claude の ~/.claude）の内に在る CODEX_HOME は止まる', () => {
    const home = fresh();
    const h = join(home, '.claude/codex-a3');
    mkc(h);
    const r = wrap3(dbOf([codexAgent('ashigaru3', h), plainAgent('ashigaru1', 'claude')], []), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('ashigaru1');
    expect(r.err).toContain(join(home, '.claude'));
  });

  test('(1) 同じ CODEX_HOME を二人の codex の足軽が持つ形は止まる', () => {
    const home = fresh();
    const h = join(home, '.codex-shared');
    mkc(h);
    const r = wrap3(dbOf([codexAgent('ashigaru3', h), codexAgent('ashigaru4', h)], []), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('ashigaru4');
  });

  test('(2) 祖先が他の足軽の rw の道（その足軽の CODEX_HOME）の内に在る形は止まる', () => {
    const home = fresh();
    const b = join(home, '.codex-b');
    const h = join(b, 'inner');
    mkc(b);
    mkc(h);
    const r = wrap3(dbOf([codexAgent('ashigaru3', h), codexAgent('ashigaru4', b)], []), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('ashigaru4');
    expect(r.err).toContain(b);
  });

  test('(2) 己の fs.write が CODEX_HOME の内に在る形（rw の道が CODEX_HOME を割る）も止まる', () => {
    const home = fresh();
    const h = join(home, '.codex-a3');
    mkc(h);
    mkdirSync(join(h, 'sub'));
    const r = wrap3(dbOf([codexAgent('ashigaru3', h)], [join(h, 'sub')]), home);
    expect(r.code).not.toBe(0);
  });

  test('(3) packages が守る物への symlink なら止まる（次の --ro-bind で正本を檻へ見せぬ）', () => {
    const home = fresh();
    const h = join(home, '.codex-a3');
    mkdirSync(h, { recursive: true });
    symlinkSync(join(home, '.honden'), join(h, 'packages'));
    const r = wrap3(dbOf([codexAgent('ashigaru3', h)], []), home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('packages');
    expect(r.err).toContain('symlink');
  });

  test('(4) 陽性対照: どの檻からも書けぬ祖先を持つ普通の道（~/.codex-a3）は通る', () => {
    const home = fresh();
    const h = join(home, '.codex-a3');
    mkc(h);
    mkdirSync(join(home, 'work'), { recursive: true });
    const r = wrap3(
      dbOf([codexAgent('ashigaru3', h), codexAgent('ashigaru4'), plainAgent('ashigaru1', 'claude'), plainAgent('ashigaru2', 'cursor')], [join(home, 'work')]),
      home,
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`--bind ${h} ${h}`);
  });

  test('陽性対照: fs の縛りが無い（網だけの）隔離では、この判じは掛けぬ', () => {
    const home = fresh();
    const h = join(home, 'work/codex-a3');
    mkc(h);
    const db = store(`cli:\n  agents:\n${codexAgent('ashigaru3', h)}isolation:\n  level: bwrap\n  net:\n    default: deny\n`);
    const r = wrap3(db, home);
    expect(r.code, r.err).toBe(0);
  });
});
