/**
 * 足軽ごとの HOME（settings の `cli.agents.<名>.env`。cursor の足軽だけ）と、selftest の足軽ごとの cursor の門。
 *
 * cursor-agent は user の層の hooks.json・mcp.json を `os.homedir()` の下の `.cursor` から読み、
 * CURSOR_CONFIG_DIR では動かぬ。ゆえに足軽 1 人だけに hindsight を載せるには HOME を分ける。
 *
 * 本物の ~/.cursor・~/.claude・~/.codex・config/settings.yaml・正本には触れぬ。HOME も根も正本も、
 * 使い捨ての tmpdir に偽の設定で作る。家の道は runGuardSelftest の口へ明示で渡す
 * （Bun の os.homedir() は走る中の HOME に従わぬ）。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { AGENT_ENV_ALLOWED, SETTINGS_PATH_KEY } from '../src/config';
import { runConfigEnv, runGuardSelftest, runIsolateWrap } from '../src/main';

const BASE = mkdtempSync(join(tmpdir(), 'honden-cursor-home-'));
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });

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
const agent = (id: string, home?: string, type = 'cursor') =>
  `    ${id}:\n      type: ${type}\n` + (home !== undefined ? `      env:\n        HOME: ${JSON.stringify(home)}\n` : '');
const mk = (d: string) => (mkdirSync(d, { recursive: true }), d);

describe('HOME を cursor の足軽の env の欄で許す', () => {
  test('(1) 書いた cursor の足軽の起こす命に、単引用で載る（shell が解けば一字違わず渡る）', () => {
    const dir = mk(join(BASE, 'cursor home $x'));
    const r = runConfigEnv(store(`cli:\n  agents:\n${agent('ashigaru7', dir)}`), 'ashigaru7');
    expect(r).toEqual({ code: 0, out: `HOME='${dir}'` });
    expect(AGENT_ENV_ALLOWED).toContain('HOME');
    const p = Bun.spawnSync(['bash', '-c', `${r.out} printenv HOME`], { env: {} });
    expect(p.stdout.toString()).toBe(`${dir}\n`);
  });

  test('(2) 相対・~・.・..・空は設定の層で止まる（CODEX_HOME と同じ掟）', () => {
    for (const v of ['~/.cursor-x', '.cursor-x', 'cursor-x', '', '/home/me/./.cursor-x', '/home/me/../.cursor-x', '/home/me/.cursor-x/..']) {
      const r = runConfigEnv(store(`cli:\n  agents:\n${agent('ashigaru7', v)}`), 'ashigaru7');
      expect(r.code, v).not.toBe(0);
      expect(r.err, v).toContain('HOME');
      expect(r.out ?? '', v).toBe('');
    }
  });

  test('(4) 書かぬ cursor の足軽は今どおり（空の前置き）', () => {
    expect(runConfigEnv(store(`cli:\n  agents:\n${agent('ashigaru7')}`), 'ashigaru7')).toEqual({ code: 0, out: '' });
  });

  test('HOME は cursor でない足軽には書けぬ（全ての道具が読む名ゆえ、他の CLI の在り処が割れる）', () => {
    const dir = mk(join(BASE, 'not-cursor'));
    for (const type of ['claude', 'codex', 'opencode']) {
      const r = runConfigEnv(store(`cli:\n  agents:\n${agent('ashigaru1', dir, type)}`), 'ashigaru1');
      expect(r.code, type).not.toBe(0);
      expect(r.err, type).toContain('cursor の足軽にだけ');
    }
  });

  test('起こす前に、HOME の dir が在ること（無ければ非ゼロで止まる。出陣と立て直しはここで止まる）', () => {
    const dir = join(BASE, 'not-yet-made');
    const db = store(`cli:\n  agents:\n${agent('ashigaru7', dir)}`);
    const r = runConfigEnv(db, 'ashigaru7');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('が在らぬ');
    mkdirSync(dir);
    expect(runConfigEnv(db, 'ashigaru7').code).toBe(0);
    // 陽性対照の逆: dir でなく file でも止まる
    const f = join(BASE, 'a-file');
    writeFileSync(f, '');
    expect(runConfigEnv(store(`cli:\n  agents:\n${agent('ashigaru7', f)}`), 'ashigaru7').code).not.toBe(0);
  });
});

describe('guard selftest — cursor の門を足軽ごとの HOME で見る', () => {
  /** cursor の門だけが据わった根。皮は禁じ手に deny を返す。 */
  function root(): string {
    const r = mkdtempSync(join(BASE, 'root-'));
    mkdirSync(join(r, '.cursor', 'hooks'), { recursive: true });
    writeFileSync(
      join(r, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: '.cursor/hooks/guard-shell.sh', failClosed: true }] } }),
    );
    const sh = join(r, '.cursor', 'hooks', 'guard-shell.sh');
    writeFileSync(sh, `#!/bin/bash\ncat >/dev/null\necho '{"permission":"deny"}'\n`);
    chmodSync(sh, 0o755);
    return r;
  }
  const userHooks = (home: string, body: string | null) => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    if (body !== null) writeFileSync(join(home, '.cursor', 'hooks.json'), body);
  };
  const cursorLines = (out: string) => out.split('\n').filter((l) => l.trim().startsWith('cursor'));

  test('(3) 足軽ごとに、実効の HOME と user の層の様子を書く。user の層に hook が在っても門は生きておる（足すだけで、黙らせられぬ）', () => {
    const r = root();
    const own = mk(join(BASE, 'cursor-own'));
    userHooks(
      own,
      JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: '/x/hindsight-hook.js' }], stop: [{ command: '/x/stop.js' }] } }),
    );
    userHooks(HOME, null);
    const db = store(`cli:\n  agents:\n${agent('ashigaru7', own)}${agent('ashigaru8')}    ashigaru4: { type: codex }\n`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).toBe(0);
    const lines = cursorLines(res.out ?? '');
    expect(lines).toHaveLength(2);
    const l7 = lines.find((l) => l.includes('ashigaru7'))!;
    expect(l7).toContain('生きておる');
    expect(l7).toContain(`HOME=${own}`);
    expect(l7).toContain('beforeShellExecution 1 本');
    const l8 = lines.find((l) => l.includes('ashigaru8'))!;
    expect(l8).toContain('生きておる');
    expect(l8).toContain(`HOME=${HOME}`);
    expect(l8).toContain('user の hooks.json 無し');
  });

  test('(3) user の層の hooks.json が壊れておっても、project の層の門は別に読まれる——生きておると言い、壊れておると添える', () => {
    const r = root();
    const own = mk(join(BASE, 'cursor-broken'));
    userHooks(own, '{"hooks": {"stop": [');
    const res = runGuardSelftest(r, store(`cli:\n  agents:\n${agent('ashigaru7', own)}`), HOME);
    expect(res.code).toBe(0);
    expect(cursorLines(res.out ?? '')[0]).toContain('生きておる');
    expect(cursorLines(res.out ?? '')[0]).toContain('壊れておる');
  });

  test('(3) 門を黙らせる形: 根の .cursor（か hooks.json）が symlink なら「効いておらぬ」と言い、非ゼロ', () => {
    const real = root();
    // .cursor ごと symlink
    const a = mkdtempSync(join(BASE, 'root-link-'));
    symlinkSync(join(real, '.cursor'), join(a, '.cursor'));
    const db = store(`cli:\n  agents:\n${agent('ashigaru7')}`);
    const ra = runGuardSelftest(a, db, HOME);
    expect(ra.code).not.toBe(0);
    expect(cursorLines(ra.out ?? '')[0]).toContain('**効いておらぬ**');
    expect(cursorLines(ra.out ?? '')[0]).toContain('symlink');
    // hooks.json だけ symlink
    const b = mkdtempSync(join(BASE, 'root-link2-'));
    mkdirSync(join(b, '.cursor'), { recursive: true });
    symlinkSync(join(real, '.cursor', 'hooks'), join(b, '.cursor', 'hooks'));
    symlinkSync(join(real, '.cursor', 'hooks.json'), join(b, '.cursor', 'hooks.json'));
    const rb = runGuardSelftest(b, db, HOME);
    expect(rb.code).not.toBe(0);
    expect(cursorLines(rb.out ?? '')[0]).toContain('hooks.json が symlink');
    // 陽性対照: 実体なら生きておる
    expect(runGuardSelftest(real, db, HOME).code).toBe(0);
  });

  test('(3) env の欄が誤った cursor の足軽は、その者を「効いておらぬ」として非ゼロ（読む先を推し量らぬ）', () => {
    const r = root();
    const db = store(`cli:\n  agents:\n${agent('ashigaru7', '~/.cursor-x')}${agent('ashigaru8')}`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(cursorLines(res.out ?? '').find((l) => l.includes('ashigaru7'))).toContain('env の欄が誤っておる');
    expect(cursorLines(res.out ?? '').find((l) => l.includes('ashigaru8'))).toContain('生きておる');
  });

  test('(3) 名簿に cursor の足軽が居らねば家を一行で見る。設定が読めぬ時は「読めぬ」と言い、「居らぬ」と言わぬ', () => {
    const r = root();
    const res = runGuardSelftest(r, store('cli:\n  agents:\n    ashigaru4: { type: codex }\n'), HOME);
    expect(cursorLines(res.out ?? '')).toHaveLength(1);
    expect(cursorLines(res.out ?? '')[0]).toContain('名簿に cursor の足軽が居らぬ');
    const broken = runGuardSelftest(r, store('cli:\n  agents:\n    ashigaru7: { type: cursor, note: FAKE-do-not-print\n'), HOME);
    expect(cursorLines(broken.out ?? '')[0]).toContain('設定が読めぬ');
    expect(cursorLines(broken.out ?? '')[0]).not.toContain('居らぬ');
    expect(broken.out).not.toContain('FAKE-do-not-print');
  });

  test('(3) user の hooks.json の中身（命）は出さぬ', () => {
    const r = root();
    const own = mk(join(BASE, 'cursor-secret'));
    userHooks(own, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'FAKE-secret-command-do-not-print' }] } }));
    const res = runGuardSelftest(r, store(`cli:\n  agents:\n${agent('ashigaru7', own)}`), HOME);
    expect(res.out).not.toContain('FAKE-secret-command-do-not-print');
  });
});

describe('隔離の下の HOME', () => {
  const iso = (fs: boolean) => `isolation:\n  level: bwrap\n  net:\n    default: deny\n${fs ? '  fs:\n    default: deny\n    write: []\n' : ''}`;
  const which = () => '/usr/bin/true';

  test('fs の縛りの下で足軽ごとの HOME を書いた cursor の足軽は、起こす前に止まる（bind をまだ組まぬ）', () => {
    const dir = mk(join(BASE, 'cursor-iso'));
    const db = store(`${iso(true)}cli:\n  agents:\n${agent('ashigaru7', dir)}${agent('ashigaru8')}`);
    const r = runIsolateWrap(db, 'cursor-agent', 'cursor', 'ashigaru7', HOME, which);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('HOME');
    // 陽性対照: 書かぬ足軽は今どおり包める
    expect(runIsolateWrap(db, 'cursor-agent', 'cursor', 'ashigaru8', HOME, which).code).toBe(0);
  });

  test('fs を縛らぬ（網だけの）隔離では止めぬ（/ は rw のまま）', () => {
    const dir = mk(join(BASE, 'cursor-net'));
    const db = store(`${iso(false)}cli:\n  agents:\n${agent('ashigaru7', dir)}`);
    expect(runIsolateWrap(db, 'cursor-agent', 'cursor', 'ashigaru7', HOME, which).code).toBe(0);
  });
});
