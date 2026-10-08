/**
 * 足軽ごとの env（settings の `cli.agents.<名>.env`）と、selftest の足軽ごとの codex の信頼。
 *
 * 本物の ~/.codex・config/settings.yaml・本陣の .codex/.claude/.cursor・正本には触れぬ。
 * HOME も CODEX_HOME も正本も、使い捨ての tmpdir に作る。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { agentEnv, envPrefix, shellQuote, AGENT_ENV_ALLOWED, SETTINGS_PATH_KEY } from '../src/config';
import { rideAlongSuppressed } from '../src/inbox';
import { runConfigEnv, runGuardSelftest } from '../src/main';

// 直す前の版は homedir() で ~/.codex を読んでおった。その版で撃っても本物を読まぬよう、
// HOME を使い捨ての道へ向けておく（Bun の homedir は HOME に従う）。
const BASE = mkdtempSync(join(tmpdir(), 'honden-agent-env-'));
const HOME0 = process.env.HOME;
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
afterAll(() => {
  process.env.HOME = HOME0;
});

const y = (text: string) => Bun.YAML.parse(text);

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

describe('env の欄を読む（agentEnv）', () => {
  test('無ければ空。名と値の組を、書いた順に返す', () => {
    const doc = y('cli:\n  agents:\n    a1: { type: codex }\n    a2:\n      type: codex\n      env:\n        CODEX_HOME: /x/y\n');
    expect(agentEnv(doc, 'a1')).toEqual({ ok: true, env: [] });
    expect(agentEnv(doc, 'a2')).toEqual({ ok: true, env: [['CODEX_HOME', '/x/y']] });
    expect(agentEnv(doc, '居らぬ者')).toEqual({ ok: true, env: [] });
  });

  test('名が [A-Z_][A-Z0-9_]* でなければ止める', () => {
    for (const name of ['codex_home', 'bad-name', '1ABC', 'A B']) {
      const doc = { cli: { agents: { a: { type: 'codex', env: { [name]: '/x' } } } } };
      const r = agentEnv(doc, 'a');
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.message, name).toContain('[A-Z_][A-Z0-9_]*');
    }
  });

  test('許す名の名簿に無い名は止める（秘密を env の欄に書かせぬ）', () => {
    expect(AGENT_ENV_ALLOWED).toEqual(['CODEX_HOME']);
    for (const name of ['OPENAI_API_KEY', 'GH_TOKEN', 'PATH', 'HOME']) {
      const r = agentEnv({ cli: { agents: { a: { env: { [name]: 'x' } } } } }, 'a');
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.message, name).toContain('許しておらぬ');
    }
  });

  test('写像でない形・文でない値・制御の字は止める', () => {
    expect(agentEnv(y('cli:\n  agents:\n    a:\n      env: [CODEX_HOME]\n'), 'a').ok).toBe(false);
    expect(agentEnv(y('cli:\n  agents:\n    a:\n      env: CODEX_HOME=/x\n'), 'a').ok).toBe(false);
    expect(agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: { x: 1 } } } } } }, 'a').ok).toBe(false);
    expect(agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: '/x\nrm -rf /' } } } } }, 'a').ok).toBe(false);
  });
});

describe('引用（shellQuote・envPrefix）', () => {
  test('空白・$・!・単引用・\\ を含む値も、shell が解けば元へ戻る', () => {
    for (const v of ['/tmp/a b', '/tmp/$HOME/x', '/tmp/a!b', "/tmp/it's", '/tmp/a\\b', '/tmp/`id`', '']) {
      const prefix = envPrefix([['CODEX_HOME', v]]);
      const p = Bun.spawnSync(['bash', '-c', `${prefix} printenv CODEX_HOME`], { env: {} });
      expect(p.stdout.toString(), v).toBe(`${v}\n`);
    }
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(envPrefix([])).toBe('');
  });
});

describe('honden config env <名>', () => {
  test('前置きを返す。無ければ空。名が外れておれば非ゼロ', () => {
    const db = store(
      'cli:\n  agents:\n    a1:\n      type: codex\n      env:\n        CODEX_HOME: "/tmp/a b$c"\n' +
        '    a2: { type: claude }\n    a3:\n      type: codex\n      env:\n        GH_TOKEN: x\n',
    );
    expect(runConfigEnv(db, 'a1')).toEqual({ code: 0, out: `CODEX_HOME='/tmp/a b$c'` });
    expect(runConfigEnv(db, 'a2')).toEqual({ code: 0, out: '' });
    const bad = runConfigEnv(db, 'a3');
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('許しておらぬ');
  });

  test('急ぎの未読の横乗せを載せぬ（$( ) で受ける口ゆえ、一行混ざると命が割れる）', () => {
    expect(rideAlongSuppressed(['config', 'env', 'ashigaru1'])).toBe(true);
    expect(rideAlongSuppressed(['config', 'get', 'cli.agents.karo.model'])).toBe(true);
    expect(rideAlongSuppressed(['status'])).toBe(false); // 陽性対照: 人向けの口には載る
  });
});

describe('guard selftest — codex の信頼を足軽ごとに見る', () => {
  /** codex の門だけが据わった根。皮は禁じ手に deny を返す。 */
  function root(): string {
    const r = mkdtempSync(join(BASE, 'root-'));
    mkdirSync(join(r, '.codex/hooks'), { recursive: true });
    writeFileSync(join(r, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: 'bash .codex/hooks/guard.sh' }] } }));
    const sh = join(r, '.codex/hooks/guard.sh');
    writeFileSync(sh, `#!/bin/bash\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"deny"}}'\n`);
    chmodSync(sh, 0o755);
    return r;
  }
  /** その CODEX_HOME に信頼の記録を置く（或いは置かぬ）。 */
  function codexHome(dir: string, r: string, trusted: boolean) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), trusted ? `[hooks."${r}/.codex/hooks.json"]\ntrusted = true\n` : '# 信頼の記録は無い\n');
  }
  const codexLines = (out: string) => out.split('\n').filter((l) => l.trim().startsWith('codex'));

  test('別の CODEX_HOME の足軽に信頼が無ければ「効いておらぬ」と言い、非ゼロ', () => {
    const r = root();
    const other = join(BASE, 'codex-other dir');
    codexHome(other, r, false);
    codexHome(join(HOME, '.codex'), r, true);
    const db = store(
      `cli:\n  agents:\n    ashigaru1:\n      type: codex\n      env:\n        CODEX_HOME: "${other}"\n` +
        '    ashigaru2: { type: codex }\n    karo: { type: claude }\n',
    );
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    const lines = codexLines(res.out ?? '');
    expect(lines).toHaveLength(2);
    const l1 = lines.find((l) => l.includes('ashigaru1'))!;
    expect(l1).toContain('**効いておらぬ**');
    expect(l1).toContain(`CODEX_HOME=${other}`);
    expect(l1).toContain('信頼の記録が無い');
    const l2 = lines.find((l) => l.includes('ashigaru2'))!;
    expect(l2).toContain('生きておる');
    expect(l2).toContain(`CODEX_HOME=${join(HOME, '.codex')}`);
    expect(res.out).toContain('1 件が据わっておるのに効いておらぬ');
  });

  test('信頼が在れば「生きておる」で 0。同じ CODEX_HOME の者は一行にまとめる', () => {
    const r = root();
    const other = join(BASE, 'codex-trusted');
    codexHome(other, r, true);
    codexHome(join(HOME, '.codex'), r, true);
    const db = store(
      `cli:\n  agents:\n    ashigaru1:\n      type: codex\n      env:\n        CODEX_HOME: ${other}\n` +
        `    ashigaru3:\n      type: codex\n      env:\n        CODEX_HOME: ${other}\n` +
        '    ashigaru2: { type: codex }\n',
    );
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).toBe(0);
    const lines = codexLines(res.out ?? '');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes('生きておる'))).toBe(true);
    expect(lines.some((l) => l.includes('ashigaru1, ashigaru3'))).toBe(true);
  });

  test('陽性対照: env の無い足軽は、今どおり ~/.codex を見る', () => {
    const r = root();
    const db = store('cli:\n  agents:\n    ashigaru2: { type: codex }\n');
    codexHome(join(HOME, '.codex'), r, false);
    let res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(codexLines(res.out ?? '')[0]).toContain('**効いておらぬ**');
    codexHome(join(HOME, '.codex'), r, true);
    res = runGuardSelftest(r, db, HOME);
    expect(res.code).toBe(0);
    expect(codexLines(res.out ?? '')[0]).toContain(`生きておる  — ashigaru2（CODEX_HOME=${join(HOME, '.codex')}）`);
  });

  test('名簿に codex の足軽が居らねば、~/.codex を一行で見る（設定の無い正本も同じ）', () => {
    const r = root();
    codexHome(join(HOME, '.codex'), r, true);
    const db = store('cli:\n  agents:\n    karo: { type: claude }\n');
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).toBe(0);
    expect(codexLines(res.out ?? '')).toHaveLength(1);
    expect(codexLines(res.out ?? '')[0]).toContain('名簿に codex の足軽が居らぬ');
  });

  test('env の欄が誤った codex の足軽は、その者を「効いておらぬ」として非ゼロ', () => {
    const r = root();
    codexHome(join(HOME, '.codex'), r, true);
    const db = store('cli:\n  agents:\n    ashigaru1:\n      type: codex\n      env:\n        GH_TOKEN: x\n    ashigaru2: { type: codex }\n');
    const res = runGuardSelftest(r, db, HOME);
    expect(res.code).not.toBe(0);
    expect(codexLines(res.out ?? '').find((l) => l.includes('ashigaru1'))).toContain('env の欄が誤っておる');
  });
});
