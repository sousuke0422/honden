/**
 * 隔離（fs.default: deny）の下でも、足軽の実効の CODEX_HOME を rw で bind する。
 *
 * 使い捨ての HOME・正本で撃つ。本物の ~/.codex と本陣の settings には触れぬ。
 * HOME は /var/tmp に作る——tmpdir（/tmp の下）に置くと、全ての道が「/tmp の下」で
 * 止まり、通る形を撃てぬ。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`--bind ${h} ${h}`);
    expect(r.out).toContain(`--ro-bind ${h}/packages ${h}/packages`);
    expect(r.out).not.toContain(`--bind ${HOME}/.codex `);
  });

  test('(2) 陽性対照: env の無い codex の足軽は今どおり ~/.codex', () => {
    const d = mk(join(HOME, '.codex'));
    const db = store(settingsOf(agentWith('ashigaru1', 'codex')));
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru1', HOME);
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
      const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME);
      expect(r.code, p).not.toBe(0);
      expect(r.err, p).toContain(said);
      expect(r.out ?? '', p).toBe(''); // 包んだ命を返さぬ（裸でも起こさぬ）
      if (said !== '在らぬ') expect(r.err, p).toContain(`${HOME}/.codex-ashigaru3`); // 直し方の例
    }
  });

  test('陽性対照: 隔離が無い（level が bwrap でない）時は、/tmp の下でも止めぬ', () => {
    const sp = `cli:\n  agents:\n${agentWith('ashigaru3', 'codex', '/tmp/codex-ashigaru3')}`;
    const db = store(sp);
    const r = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru3', HOME);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('codex --search');
  });

  test('(4) claude と cursor の足軽は、CODEX_HOME の判じも置き換えもせぬ', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    for (const cli of ['claude', 'cursor']) {
      const db = store(settingsOf(agentWith('ashigaru2', cli, '/tmp/codex-x')));
      const r = runIsolateWrap(db, `${cli} --x`, cli, 'ashigaru2', HOME);
      expect(r.code, `${cli}: ${r.err}`).toBe(0);
      expect(r.out, cli).not.toContain('codex-x');
    }
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
    const w = runIsolateWrap(db, 'codex --search', 'codex', 'ashigaru5', HOME);
    const bound = /--bind (\S+) \1 --ro-bind \1\/packages/.exec(w.out ?? '')?.[1];
    expect(seen).toBe(h);
    expect(bound).toBe(h);
    expect(line).toContain('生きておる');
  });
});
