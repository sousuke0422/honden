/**
 * 足軽ごとの CLAUDE_CONFIG_DIR（settings の `cli.agents.<名>.env`）と、selftest の足軽ごとの claude の門。
 *
 * 本物の ~/.claude・~/.claude.json・config/settings.yaml・本陣の .claude・正本には触れぬ。
 * HOME も CLAUDE_CONFIG_DIR も根も正本も、使い捨ての tmpdir に作る。家の道は
 * runGuardSelftest の口へ明示で渡す（Bun の os.homedir() は走る中の HOME に従わぬ）。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { AGENT_ENV_ALLOWED, SETTINGS_PATH_KEY } from '../src/config';
import { runConfigEnv, runGuardSelftest, runIsolateWrap } from '../src/main';

const BASE = mkdtempSync(join(tmpdir(), 'honden-claude-config-dir-'));
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });

/** 設定の file を書き、使い捨ての正本に在り処を覚えさせる。 */
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
const claudeAgent = (id: string, dir?: string, type = 'claude') =>
  `    ${id}:\n      type: ${type}\n` + (dir !== undefined ? `      env:\n        CLAUDE_CONFIG_DIR: ${JSON.stringify(dir)}\n` : '');

describe('CLAUDE_CONFIG_DIR を env の欄で許す', () => {
  test('(1) 書いた claude の足軽の起こす命に、単引用で載る（shell が解けば一字違わず渡る）', () => {
    const dir = join(BASE, 'claude a1 $x');
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', dir)}`);
    const r = runConfigEnv(db, 'ashigaru1');
    expect(r).toEqual({ code: 0, out: `CLAUDE_CONFIG_DIR='${dir}'` });
    expect(AGENT_ENV_ALLOWED).toContain('CLAUDE_CONFIG_DIR');
    const p = Bun.spawnSync(['bash', '-c', `${r.out} printenv CLAUDE_CONFIG_DIR`], { env: {} });
    expect(p.stdout.toString()).toBe(`${dir}\n`);
  });

  test('(2) 相対・~・.・..・空は設定の層で止まる（CODEX_HOME と同じ掟）', () => {
    for (const v of ['~/.claude-x', '.claude-x', 'claude-x', '', '/home/me/./.claude-x', '/home/me/../.claude-x', '/home/me/.claude-x/..']) {
      const r = runConfigEnv(store(`cli:\n  agents:\n${claudeAgent('ashigaru1', v)}`), 'ashigaru1');
      expect(r.code, v).not.toBe(0);
      expect(r.err, v).toContain('CLAUDE_CONFIG_DIR');
      expect(r.out ?? '', v).toBe('');
    }
  });

  test('(4) 書かぬ足軽は今どおり。type が claude でない足軽に書かれても、CODEX_HOME と同じく止めずに載せる', () => {
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru2')}${claudeAgent('ashigaru4', '/home/me/.claude-a4', 'codex')}`);
    expect(runConfigEnv(db, 'ashigaru2')).toEqual({ code: 0, out: '' });
    expect(runConfigEnv(db, 'ashigaru4')).toEqual({ code: 0, out: `CLAUDE_CONFIG_DIR='/home/me/.claude-a4'` });
  });
});

describe('guard selftest — claude の門を足軽ごとの CLAUDE_CONFIG_DIR で見る', () => {
  /** claude の門だけが据わった根。皮は禁じ手に deny を返す。 */
  function root(): string {
    const r = mkdtempSync(join(BASE, 'root-'));
    mkdirSync(join(r, '.claude/hooks'), { recursive: true });
    writeFileSync(
      join(r, '.claude/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${r}/.claude/hooks/guard.sh` }] }] } }),
    );
    const sh = join(r, '.claude/hooks/guard.sh');
    writeFileSync(sh, `#!/bin/bash\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"deny"}}'\n`);
    chmodSync(sh, 0o755);
    return r;
  }
  /** その dir に user の settings を置く（body が null なら置かぬ）。 */
  function userSettings(dir: string, body: string | null) {
    mkdirSync(dir, { recursive: true });
    if (body !== null) writeFileSync(join(dir, 'settings.json'), body);
  }
  const claudeLines = (out: string) => out.split('\n').filter((l) => l.trim().startsWith('claude'));

  test('(3) 分けた dir の settings に disableAllHooks: true が在れば「効いておらぬ」と言い、非ゼロ', () => {
    const r = root();
    const other = join(BASE, 'claude-other dir');
    userSettings(other, JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_API_KEY: 'sk-FAKE-do-not-print' } }));
    userSettings(join(HOME, '.claude'), JSON.stringify({ model: 'x' }));
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', other)}${claudeAgent('ashigaru2')}    ashigaru4: { type: codex }\n`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    const lines = claudeLines(res.out ?? '');
    expect(lines).toHaveLength(2);
    const l1 = lines.find((l) => l.includes('ashigaru1'))!;
    expect(l1).toContain('**効いておらぬ**');
    expect(l1).toContain(`CLAUDE_CONFIG_DIR=${other}`);
    expect(l1).toContain('disableAllHooks');
    const l2 = lines.find((l) => l.includes('ashigaru2'))!;
    expect(l2).toContain('生きておる');
    expect(l2).toContain(`CLAUDE_CONFIG_DIR=${join(HOME, '.claude')}`);
    // settings の中の値（鍵）は出さぬ
    expect(res.out).not.toContain('sk-FAKE-do-not-print');
  });

  test('(3) 陽性対照: 同じ dir で disableAllHooks が無い・false なら「生きておる」で 0。同じ dir の者は一行にまとめる', () => {
    const r = root();
    const other = join(BASE, 'claude-ok');
    for (const body of [null, '{}', JSON.stringify({ disableAllHooks: false, hooks: { Stop: [] } })]) {
      userSettings(other, body);
      const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', other)}${claudeAgent('ashigaru3', other)}`);
      const res = runGuardSelftest(r, db, HOME);
      expect(res.code, String(body)).toBe(0);
      const lines = claudeLines(res.out ?? '');
      expect(lines, String(body)).toHaveLength(1);
      expect(lines[0], String(body)).toContain('生きておる');
      expect(lines[0], String(body)).toContain('ashigaru1, ashigaru3');
    }
  });

  test('(3) 書かぬ足軽は既定の ~/.claude を見る。そこに disableAllHooks が在れば同じく死んでおる', () => {
    const r = root();
    userSettings(join(HOME, '.claude'), JSON.stringify({ disableAllHooks: true }));
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru2')}`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(claudeLines(res.out ?? '')[0]).toContain('**効いておらぬ**');
    userSettings(join(HOME, '.claude'), '{}');
    expect(runGuardSelftest(r, db, HOME).code).toBe(0);
  });

  test('(3) 重ね順: 根の .claude/settings.json が false を書けば user の true に勝つ。settings.local.json の true は皆を止める', () => {
    const r = root();
    const other = join(BASE, 'claude-layer');
    userSettings(other, JSON.stringify({ disableAllHooks: true }));
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', other)}`);
    expect(runGuardSelftest(r, db, HOME).code).not.toBe(0);
    const projectFile = join(r, '.claude/settings.json');
    writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), disableAllHooks: false }));
    const ok = runGuardSelftest(r, db, HOME);
    expect(ok.code).toBe(0);
    expect(claudeLines(ok.out ?? '')[0]).toContain('生きておる');
    writeFileSync(join(r, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }));
    const dead = runGuardSelftest(r, db, HOME);
    expect(dead.code).not.toBe(0);
    expect(claudeLines(dead.out ?? '')[0]).toContain('settings.local.json');
  });

  test('(3) settings が JSON として読めねば、生きておるとは言わぬ（判じられぬ）', () => {
    const r = root();
    const other = join(BASE, 'claude-broken');
    userSettings(other, '{"disableAllHooks": tru');
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', other)}`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(claudeLines(res.out ?? '')[0]).toContain('**効いておらぬ**');
  });

  test('(3) env の欄が誤った claude の足軽は、その者を「効いておらぬ」として非ゼロ（読む先を推し量らぬ）', () => {
    const r = root();
    userSettings(join(HOME, '.claude'), '{}');
    const db = store(`cli:\n  agents:\n${claudeAgent('ashigaru1', '~/.claude-x')}${claudeAgent('ashigaru2')}`);
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(claudeLines(res.out ?? '').find((l) => l.includes('ashigaru1'))).toContain('env の欄が誤っておる');
    expect(claudeLines(res.out ?? '').find((l) => l.includes('ashigaru2'))).toContain('生きておる');
  });

  test('(3) 名簿に claude の足軽が居らねば、~/.claude を一行で見る', () => {
    const r = root();
    userSettings(join(HOME, '.claude'), '{}');
    const res = runGuardSelftest(r, store('cli:\n  agents:\n    ashigaru4: { type: codex }\n'), HOME);
    expect(claudeLines(res.out ?? '')).toHaveLength(1);
    expect(claudeLines(res.out ?? '')[0]).toContain('名簿に claude の足軽が居らぬ');
  });
});

describe('隔離の下の CLAUDE_CONFIG_DIR', () => {
  const iso = (fs: boolean) => `isolation:\n  level: bwrap\n  net:\n    default: deny\n${fs ? '  fs:\n    default: deny\n    write: []\n' : ''}`;
  const which = () => '/usr/bin/true';

  test('fs の縛りの下で足軽ごとの CLAUDE_CONFIG_DIR を書いた claude の足軽は、起こす前に止まる（bind をまだ組まぬ）', () => {
    const dir = join(BASE, 'claude-iso');
    mkdirSync(dir, { recursive: true });
    const db = store(`${iso(true)}cli:\n  agents:\n${claudeAgent('ashigaru1', dir)}${claudeAgent('ashigaru2')}`);
    const r = runIsolateWrap(db, 'claude', 'claude', 'ashigaru1', HOME, which);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('CLAUDE_CONFIG_DIR');
    // 陽性対照: 書かぬ足軽は今どおり包める
    expect(runIsolateWrap(db, 'claude', 'claude', 'ashigaru2', HOME, which).code).toBe(0);
  });

  test('fs を縛らぬ（網だけの）隔離では止めぬ（/ は rw のまま）', () => {
    const dir = join(BASE, 'claude-net');
    mkdirSync(dir, { recursive: true });
    const db = store(`${iso(false)}cli:\n  agents:\n${claudeAgent('ashigaru1', dir)}`);
    expect(runIsolateWrap(db, 'claude', 'claude', 'ashigaru1', HOME, which).code).toBe(0);
  });
});
