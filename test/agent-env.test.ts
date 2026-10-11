/**
 * 足軽ごとの env（settings の `cli.agents.<名>.env`）と、selftest の足軽ごとの codex の信頼。
 *
 * 本物の ~/.codex・config/settings.yaml・本陣の .codex/.claude/.cursor・正本には触れぬ。
 * HOME も CODEX_HOME も正本も、使い捨ての tmpdir に作る。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { agentEnv, envPrefix, shellQuote, AGENT_ENV_ALLOWED, SETTINGS_PATH_KEY } from '../src/config';
import { rideAlongSuppressed } from '../src/inbox';
import { runConfigEnv, runGuardSelftest } from '../src/main';

// 家の道は runGuardSelftest の口へ明示で渡す。走る中で process.env.HOME を差し替えても
// Bun の os.homedir() は従わぬ（起動の時の値のまま）ゆえ、差し替えでは本物の家を守れぬ。
// 口を使わぬ版（直す前の版）を撃つ時は、bun を起こす時に HOME を使い捨ての道にして起こすこと。
const BASE = mkdtempSync(join(tmpdir(), 'honden-agent-env-'));
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });

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
    expect(AGENT_ENV_ALLOWED).toEqual(['CODEX_HOME', 'HINDSIGHT_CONFIG', 'CLAUDE_CONFIG_DIR']);
    // 陽性対照: 秘密を運ぶ名は、HINDSIGHT_CONFIG・CLAUDE_CONFIG_DIR を許した後も今どおり止まる。
    // HINDSIGHT_API_TOKEN は hindsight の hook が、ANTHROPIC_AUTH_TOKEN・CLAUDE_CODE_OAUTH_TOKEN は
    // Claude Code が env から読む名だが、許さぬ
    for (const name of [
      'OPENAI_API_KEY',
      'GH_TOKEN',
      'PATH',
      'HOME',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'HINDSIGHT_API_TOKEN',
      'HINDSIGHT_API_URL',
    ]) {
      const r = agentEnv({ cli: { agents: { a: { env: { [name]: 'x' } } } } }, 'a');
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.message, name).toContain('許しておらぬ');
    }
  });

  test('HINDSIGHT_CONFIG を受け、CODEX_HOME と同じ道の掟（絶対・. と .. の区画を拒む）を通す', () => {
    const ok = '/home/me/.hindsight-a3/coding-agent.json';
    expect(agentEnv({ cli: { agents: { a: { env: { HINDSIGHT_CONFIG: ok } } } } }, 'a')).toEqual({
      ok: true,
      env: [['HINDSIGHT_CONFIG', ok]],
    });
    for (const [v, said] of [
      ['~/.hindsight/coding-agent.json', '絶対の道'],
      ['.hindsight/coding-agent.json', '絶対の道'],
      ['coding-agent.json', '絶対の道'],
      ['', '絶対の道'],
      ['/home/me/./.hindsight/coding-agent.json', '. の区画'],
      ['/home/me/../me/.hindsight/coding-agent.json', '..'],
    ] as const) {
      const r = agentEnv({ cli: { agents: { a: { env: { HINDSIGHT_CONFIG: v } } } } }, 'a');
      expect(r.ok, v).toBe(false);
      if (!r.ok) {
        expect(r.message, v).toContain('HINDSIGHT_CONFIG');
        expect(r.message, v).toContain(said);
        expect(r.message, v).toContain('$HOME を展開した絶対の道');
      }
    }
  });

  test('CODEX_HOME は / で始まる絶対の道に限る（~・相対・空・.. は止める）', () => {
    // 値は単引用で載るゆえ ~ も $HOME も展開されぬ。selftest が読む先と codex が使う先を
    // 食い違わせぬため、絶対の道だけを受ける。.. は畳まずに止める（symlink を越えると
    // 字面の正規化と実の在り処がずれうる）。
    for (const [v, said] of [
      ['~/.codex-x', '絶対の道'],
      ['codex-x', '絶対の道'],
      ['./codex-x', '絶対の道'],
      ['$HOME/.codex-x', '絶対の道'],
      ['', '絶対の道'],
      ['/home/me/../me/.codex-x', '..'],
      ['/home/me/.codex-x/..', '..'],
    ] as const) {
      const r = agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: v } } } } }, 'a');
      expect(r.ok, v).toBe(false);
      if (!r.ok) {
        expect(r.message, v).toContain(said);
        expect(r.message, v).toContain('$HOME を展開した絶対の道');
      }
    }
    // 陽性対照: 絶対の道は通る（空白や $ を含む名の dir も、.. を含まねば通る）
    for (const v of ['/home/me/.codex-x', '/tmp/a b$c', '/home/me/..codex']) {
      expect(agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: v } } } } }, 'a'), v).toEqual({ ok: true, env: [['CODEX_HOME', v]] });
    }
  });

  test('CODEX_HOME の . の区画も止める（/./ を挟んで隔離の拒みの前方一致を外させぬ）', () => {
    for (const v of ['/home/me/./.honden', '/srv/./honden/.codex', '/./tmp/x', '/home/./me', '/home/me/.codex-x/.']) {
      const r = agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: v } } } } }, 'a');
      expect(r.ok, v).toBe(false);
      if (!r.ok) {
        expect(r.message, v).toContain('. の区画');
        expect(r.message, v).toContain('$HOME を展開した絶対の道');
      }
    }
    // 陽性対照: . で始まる名の dir（.codex-a3・.codexfoo・.codex）は区画ではないゆえ通る
    for (const v of ['/home/me/.codex-a3', '/home/me/.codexfoo', '/home/me/x/.codex']) {
      expect(agentEnv({ cli: { agents: { a: { env: { CODEX_HOME: v } } } } }, 'a'), v).toEqual({ ok: true, env: [['CODEX_HOME', v]] });
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

  test('HINDSIGHT_CONFIG を書いた足軽の起こす命に、単引用で載る（CODEX_HOME と並べても書いた順に）', () => {
    // 設定の file は起こす前に検められる（在らぬ・自前の server を指さぬなら止まる。
    // test/hindsight-config.test.ts）。ここでは使い捨ての dir に、偽の値の正しい file を作る
    const good = JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'http://127.0.0.1:8888', apiToken: 'FAKE' });
    const dir = mkdtempSync(join(BASE, 'hs a1-'));
    const h1 = join(dir, 'coding-agent.json');
    const h2 = join(dir, 'a2.json');
    writeFileSync(h1, good);
    writeFileSync(h2, good);
    const db = store(
      'cli:\n  agents:\n' +
        `    h1:\n      type: claude\n      env:\n        HINDSIGHT_CONFIG: ${JSON.stringify(h1)}\n` +
        `    h2:\n      type: codex\n      env:\n        CODEX_HOME: /home/me/.codex-a2\n        HINDSIGHT_CONFIG: ${JSON.stringify(h2)}\n` +
        '    h3:\n      type: claude\n      env:\n        ANTHROPIC_API_KEY: sk-x\n',
    );
    expect(runConfigEnv(db, 'h1')).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${h1}'` });
    expect(runConfigEnv(db, 'h2')).toEqual({
      code: 0,
      out: `CODEX_HOME='/home/me/.codex-a2' HINDSIGHT_CONFIG='${h2}'`,
    });
    // 載った前置きを shell に解かせると、元の道（空白を含む）が一字違わず渡る
    const p = Bun.spawnSync(['bash', '-c', `${runConfigEnv(db, 'h1').out} printenv HINDSIGHT_CONFIG`], { env: {} });
    expect(p.stdout.toString()).toBe(`${h1}\n`);
    // 陽性対照: 秘密を運ぶ名は今どおり止まる
    const bad = runConfigEnv(db, 'h3');
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('許しておらぬ');
  });

  test('CODEX_HOME が絶対の道でなければ非ゼロ（出陣と立て直しはこの口で止まる）', () => {
    const db = store(
      'cli:\n  agents:\n    t:\n      type: codex\n      env:\n        CODEX_HOME: "~/.codex-x"\n' +
        '    r:\n      type: codex\n      env:\n        CODEX_HOME: codex-x\n' +
        '    e:\n      type: codex\n      env:\n        CODEX_HOME: ""\n' +
        '    ok:\n      type: codex\n      env:\n        CODEX_HOME: /home/me/.codex-x\n',
    );
    for (const a of ['t', 'r', 'e']) {
      const res = runConfigEnv(db, a);
      expect(res.code, a).not.toBe(0);
      expect(res.err, a).toContain('$HOME を展開した絶対の道');
      expect(res.out ?? '', a).toBe(''); // 前置きを返さぬ（命に載せぬ）
    }
    expect(runConfigEnv(db, 'ok')).toEqual({ code: 0, out: `CODEX_HOME='/home/me/.codex-x'` });
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
    expect(codexLines(res.out ?? '')[0]).not.toContain('読めぬ');
  });

  test('(2) settings.yaml が壊れておれば、codex の行は『読めぬ』と言い『居らぬ』と言わぬ（中身は載せぬ）', () => {
    const r = root();
    codexHome(join(HOME, '.codex'), r, true);
    const db = store('cli:\n  agents:\n    ashigaru4: { type: codex, note: FAKE-settings-value-do-not-print\n');
    const res = runGuardSelftest(r, db, HOME);
    const line = codexLines(res.out ?? '')[0];
    expect(codexLines(res.out ?? '')).toHaveLength(1);
    expect(line).toContain('設定が読めぬ');
    expect(line).toContain('壊れておる');
    expect(line).toContain(`${join(HOME, '.codex')} だけを見た`);
    expect(line).not.toContain('居らぬ');
    expect(res.out).not.toContain('FAKE-settings-value-do-not-print');
    // 生き死にの判じは変えぬ（既定の dir に信頼が在る）
    expect(line).toContain('生きておる');
  });

  test('CODEX_HOME が絶対の道でない足軽は、その者を「効いておらぬ」として非ゼロ（読む先を推し量らぬ）', () => {
    const r = root();
    codexHome(join(HOME, '.codex'), r, true);
    // ~/.codex-x の形。selftest が展開して読めば緑に見えうるが、codex は単引用の ~ を展開せぬ
    codexHome(join(HOME, '.codex-x'), r, true);
    for (const v of ['~/.codex-x', '.codex-x', '']) {
      const db = store(`cli:\n  agents:\n    ashigaru1:\n      type: codex\n      env:\n        CODEX_HOME: "${v}"\n    ashigaru2: { type: codex }\n`);
      const res = runGuardSelftest(r, db, HOME);
      expect(res.code, v).not.toBe(0);
      const l1 = codexLines(res.out ?? '').find((l) => l.includes('ashigaru1'));
      expect(l1, v).toContain('**効いておらぬ**');
      expect(l1, v).toContain('絶対の道');
      // 陽性対照: 同じ正本の、判じを通る足軽は今どおり生きておる
      expect(codexLines(res.out ?? '').find((l) => l.includes('ashigaru2')), v).toContain('生きておる');
    }
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
