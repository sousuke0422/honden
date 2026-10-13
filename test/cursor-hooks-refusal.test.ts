/**
 * selftest の cursor の行が、cursor-agent が hooks.json を丸ごと断る形（version 欠け等）を言う。
 *
 * cursor-agent（2026.10.01-e373342）は層ごとの hooks.json を検め（index.js の `se`）、version が数でない・
 * hooks が object でない・未知の event 名などが一つでも在れば、**その層を丸ごと載せぬ**。
 * 門の配線は project の層ゆえ、そこが断られれば門は黙って止まる——生死に効かせる。
 * user の層が断られても門は死なぬ——note に留める。
 *
 * 本物の ~/.cursor・~/.claude・~/.codex・config/settings.yaml・正本には触れぬ。家も根も正本も、
 * 使い捨ての tmpdir に偽の設定で作る。家の道は runGuardSelftest の口へ明示で渡す。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { SETTINGS_PATH_KEY } from '../src/config';
import { runGuardSelftest } from '../src/main';

const BASE = mkdtempSync(join(tmpdir(), 'honden-cursor-refusal-'));
const HOME = join(BASE, 'home');
mkdirSync(HOME, { recursive: true });

const gateEntry = { command: '.cursor/hooks/guard-shell.sh', failClosed: true };
const GOOD = { version: 1, hooks: { beforeShellExecution: [gateEntry] } };

/** 断られる五つの形と、正しい形。 */
const FORMS: { name: string; body: unknown; why: string }[] = [
  { name: '(1) version 無し', body: { hooks: { beforeShellExecution: [gateEntry] } }, why: 'version が数でない' },
  { name: '(2) version が文字列', body: { version: '1', hooks: { beforeShellExecution: [gateEntry] } }, why: 'version が数でない' },
  { name: '(3) version が 0', body: { version: 0, hooks: { beforeShellExecution: [gateEntry] } }, why: 'version が 1 以上の整数でない' },
  { name: '(4) hooks が配列', body: { version: 1, hooks: [gateEntry] }, why: 'hooks が object でない' },
  {
    name: '(5) 未知の event 名',
    body: { version: 1, hooks: { beforeShellExecution: [gateEntry], beforeShellExecutoin: [gateEntry] } },
    why: '未知の event 名 "beforeShellExecutoin"',
  },
];

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
const roster = (home?: string) =>
  `cli:\n  agents:\n    ashigaru7:\n      type: cursor\n` + (home !== undefined ? `      env:\n        HOME: ${JSON.stringify(home)}\n` : '');

/** 門の hook の皮が deny を返す根。project の層の設定は body（文字列か object）。 */
function root(body: unknown = GOOD): string {
  const r = mkdtempSync(join(BASE, 'root-'));
  mkdirSync(join(r, '.cursor', 'hooks'), { recursive: true });
  writeFileSync(join(r, '.cursor', 'hooks.json'), typeof body === 'string' ? body : JSON.stringify(body));
  const sh = join(r, '.cursor', 'hooks', 'guard-shell.sh');
  writeFileSync(sh, `#!/bin/bash\ncat >/dev/null\necho '{"permission":"deny"}'\n`);
  chmodSync(sh, 0o755);
  return r;
}
/** 家の user の層に設定を置く（null は置かぬ）。 */
function userHome(body: unknown | null): string {
  const h = mkdtempSync(join(BASE, 'uhome-'));
  if (body !== null) {
    mkdirSync(join(h, '.cursor'), { recursive: true });
    writeFileSync(join(h, '.cursor', 'hooks.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return h;
}
const cursorLine = (out: string | undefined) => (out ?? '').split('\n').find((l) => l.trim().startsWith('cursor')) ?? '';

describe('project の層（門の配線）を cursor が断る形は「効いておらぬ」', () => {
  for (const f of FORMS) {
    test(`${f.name}: 効いておらぬ・非ゼロ・断られる訳を添える`, () => {
      const res = runGuardSelftest(root(f.body), store(roster()), HOME);
      const line = cursorLine(res.out);
      expect(res.code).not.toBe(0);
      expect(line).toContain('**効いておらぬ**');
      expect(line).toContain('project の hooks.json が cursor-agent に断られる');
      expect(line).toContain(f.why);
      expect(line).toContain('門の hook は一つも走らず');
    });
  }

  test('(6) version 1 の正しい形は今までどおり生きておる', () => {
    const res = runGuardSelftest(root(GOOD), store(roster()), HOME);
    expect(res.code).toBe(0);
    expect(cursorLine(res.out)).toContain('生きておる');
    expect(cursorLine(res.out)).not.toContain('断られる');
  });

  test('今の repo の project の層の設定は生きておるまま（cursor の検めを通る）', () => {
    const real = readFileSync(join(import.meta.dir, '..', '.cursor', 'hooks.json'), 'utf8');
    const res = runGuardSelftest(root(real), store(roster()), HOME);
    expect(res.code).toBe(0);
    expect(cursorLine(res.out)).toContain('生きておる');
    expect(cursorLine(res.out)).not.toContain('断られる');
  });

  test('注釈つきの正しい設定は生きておる（cursor は注釈を落として読む）', () => {
    const body = `// 先頭の注釈\n{ /* 塊 */ "version": 1,\n  "hooks": { "beforeShellExecution": [ { "command": ".cursor/hooks/guard-shell.sh", "failClosed": true } ] } }\n`;
    const res = runGuardSelftest(root(body), store(roster()), HOME);
    expect(res.code).toBe(0);
    expect(cursorLine(res.out)).toContain('生きておる');
  });

  test('hook の形の不正（command が文字列でない・timeout が負・failClosed が文字列）も断られる形', () => {
    for (const entry of [{ command: 5 }, { command: 'x', timeout: -1 }, { command: 'x', failClosed: 'yes' }, 'x']) {
      const res = runGuardSelftest(root({ version: 1, hooks: { beforeShellExecution: [gateEntry, entry] } }), store(roster()), HOME);
      expect(res.code, JSON.stringify(entry)).not.toBe(0);
      expect(cursorLine(res.out), JSON.stringify(entry)).toContain('断られる');
    }
  });

  test('project の層が JSON として壊れておれば、門は黙って止まると言う', () => {
    const res = runGuardSelftest(root('{"version": 1, "hooks": {'), store(roster()), HOME);
    expect(res.code).not.toBe(0);
    expect(cursorLine(res.out)).toContain('**効いておらぬ**');
  });
});

describe('user の層を cursor が断る形は note のみ——門の生死は変わらぬ', () => {
  for (const f of FORMS) {
    test(`${f.name}: 生きておる・code 0・「その層の hook は一つも走らぬ」を添える`, () => {
      const own = userHome(f.body);
      const res = runGuardSelftest(root(GOOD), store(roster(own)), HOME);
      const line = cursorLine(res.out);
      expect(res.code).toBe(0);
      expect(line).toContain('生きておる');
      expect(line).toContain('user の hooks.json は cursor-agent に断られる');
      expect(line).toContain(f.why);
      expect(line).toContain('その層の hook は一つも走らぬ');
      expect(line).not.toContain('有り（');
    });
  }

  test('(6) version 1 の正しい形は今までどおり本数を言う', () => {
    const own = userHome({ version: 1, hooks: { beforeShellExecution: [{ command: '/x/a.js' }], stop: [{ command: '/x/s.js' }] } });
    const res = runGuardSelftest(root(GOOD), store(roster(own)), HOME);
    expect(res.code).toBe(0);
    const line = cursorLine(res.out);
    expect(line).toContain('user の hooks.json 有り（beforeShellExecution 1 本）');
    expect(line).not.toContain('断られる');
  });

  test('user の層が無い家は今までどおり「無し」', () => {
    const res = runGuardSelftest(root(GOOD), store(roster(userHome(null))), HOME);
    expect(res.code).toBe(0);
    expect(cursorLine(res.out)).toContain('user の hooks.json 無し');
  });

  test('両方の層が断られる形なら、project の層の訳で効いておらぬ・user の層の訳も note に在る', () => {
    const own = userHome({ hooks: {} });
    const res = runGuardSelftest(root({ hooks: { beforeShellExecution: [gateEntry] } }), store(roster(own)), HOME);
    const line = cursorLine(res.out);
    expect(res.code).not.toBe(0);
    expect(line).toContain('**効いておらぬ**');
    expect(line).toContain('project の hooks.json が cursor-agent に断られる');
    expect(line).toContain('user の hooks.json は cursor-agent に断られる');
  });
});

describe('断りの訳に載る file 由来の文字は escape され、丈が切られ、門の表は崩れぬ', () => {
  const FAKE = 'bogus\n  codex   生きておる';
  const withType = (type: unknown) => ({ version: 1, hooks: { beforeShellExecution: [gateEntry, { command: 'x', type }] } });
  const withKey = (key: string) => ({ version: 1, hooks: { beforeShellExecution: [gateEntry], [key]: [gateEntry] } });
  /** 同じ形で project の層（root の設定）と user の層（家の設定）の各々に body を置いて撃つ。 */
  const layers: { name: string; run: (body: unknown) => { out: string; code: number } }[] = [
    {
      name: 'project の層',
      run: (body) => {
        const res = runGuardSelftest(root(body), store(roster()), HOME);
        return { out: res.out ?? '', code: res.code };
      },
    },
    {
      name: 'user の層',
      run: (body) => {
        const res = runGuardSelftest(root(GOOD), store(roster(userHome(body))), HOME);
        return { out: res.out ?? '', code: res.code };
      },
    },
  ];
  const lines = (out: string) => out.split('\n');
  const startsWith = (out: string, name: string) => lines(out).filter((l) => l.trim().startsWith(name));

  for (const layer of layers) {
    test(`${layer.name}: (1) hook の type に改行と偽の行を入れても、cursor の行は一行のままで codex で始まる行が増えぬ`, () => {
      const plain = layer.run(withType('bogus'));
      const fake = layer.run(withType(FAKE));
      expect(lines(fake.out).length).toBe(lines(plain.out).length);
      expect(startsWith(fake.out, 'cursor').length).toBe(startsWith(plain.out, 'cursor').length);
      expect(startsWith(fake.out, 'codex').length).toBe(startsWith(plain.out, 'codex').length);
      expect(fake.out).not.toContain('bogus\n');
      // 改行は見える形（\n）で載る
      expect(startsWith(fake.out, 'cursor')[0]).toContain('bogus\\n  codex   生きておる');
      expect(fake.code).toBe(plain.code);
    });

    test(`${layer.name}: (2) 未知の event の鍵に改行を入れても同じ`, () => {
      const plain = layer.run(withKey('plainkey'));
      const fake = layer.run(withKey(FAKE));
      expect(lines(fake.out).length).toBe(lines(plain.out).length);
      expect(startsWith(fake.out, 'codex').length).toBe(startsWith(plain.out, 'codex').length);
      expect(startsWith(fake.out, 'cursor')[0]).toContain('未知の event 名 "bogus\\n  codex   生きておる"');
    });

    test(`${layer.name}: (3) 400 字の鍵でも訳の丈は上限で切れ、切った印（…）が付く`, () => {
      const long = 'k'.repeat(400);
      const res = layer.run(withKey(long));
      const line = startsWith(res.out, 'cursor')[0]!;
      expect(line).not.toContain('k'.repeat(61));
      expect(line).toContain(`"${'k'.repeat(60)}…"`);
      expect(lines(res.out).length).toBe(lines(layer.run(withKey('plainkey')).out).length);
    });

    test(`${layer.name}: ANSI の escape 列・引用符・DEL・C1・行区切りも見える形になる`, () => {
      const nasty = '\u001b[31mred\u001b[0m"q\u007f\u0085\u2028end';
      const res = layer.run(withType(nasty));
      expect(res.out).not.toContain('\u001b');
      expect(res.out).not.toContain('\u007f');
      expect(res.out).not.toContain('\u0085');
      expect(res.out).not.toContain('\u2028');
      const line = startsWith(res.out, 'cursor')[0]!;
      expect(line).toContain('\\u001b[31mred');
      expect(line).toContain('\\"q');
      expect(line).toContain('\\u007f\\u0085\\u2028end');
    });
  }
});

describe('cursor の検めを一つ外すと落ちる試験（突然変異で生き残った四つ）', () => {
  /** user の層で note を、project の層で生死を見る。 */
  const userNote = (body: unknown) => {
    const res = runGuardSelftest(root(GOOD), store(roster(userHome(body))), HOME);
    return { code: res.code, line: cursorLine(res.out) };
  };
  const project = (body: unknown) => {
    const res = runGuardSelftest(root(body), store(roster()), HOME);
    return { code: res.code, line: cursorLine(res.out) };
  };
  const withEntry = (entry: unknown) => ({ version: 1, hooks: { beforeShellExecution: [gateEntry, entry] } });

  test('(a) event の値が配列かを見る: object・文字列・数は断られる。空の配列は通る', () => {
    for (const v of [gateEntry, 'x', 5, true, null]) {
      const body = { version: 1, hooks: { beforeShellExecution: [gateEntry], stop: v } };
      const u = userNote(body);
      expect(u.line, JSON.stringify(v)).toContain('stop が配列でない');
      expect(u.code).toBe(0);
    }
    expect(userNote({ version: 1, hooks: { beforeShellExecution: [gateEntry], stop: [] } }).line).not.toContain('断られる');
    // project の層の門の event が配列でない形は、門が死ぬ
    const p = project({ version: 1, hooks: { beforeShellExecution: gateEntry } });
    expect(p.code).not.toBe(0);
  });

  test('(b) matcher の正規表現を見る: 不正な正規表現・文字列でない物は断られる。空・*・正しい正規表現は通る', () => {
    for (const m of ['(', '[', '*abc', 'a{2,1}']) {
      const u = userNote(withEntry({ command: 'x', matcher: m }));
      expect(u.line, m).toContain('matcher が正規表現として不正');
    }
    expect(userNote(withEntry({ command: 'x', matcher: 5 })).line).toContain('matcher が文字列でない');
    for (const m of ['', '*', '^git (push|commit)$', 'Shell|Read']) {
      expect(userNote(withEntry({ command: 'x', matcher: m })).line, m).not.toContain('断られる');
    }
    expect(project(withEntry({ command: 'x', matcher: '(' })).code).not.toBe(0);
  });

  test('(c) loop_limit を見る: 0・負・小数・文字列は断られる。null と正の整数は通る', () => {
    for (const l of [0, -1, 1.5, '3', true]) {
      const u = userNote(withEntry({ command: 'x', loop_limit: l }));
      expect(u.line, JSON.stringify(l)).toContain('loop_limit が正の整数でない');
    }
    for (const l of [null, 1, 3]) {
      expect(userNote(withEntry({ command: 'x', loop_limit: l })).line, JSON.stringify(l)).not.toContain('断られる');
    }
    expect(project(withEntry({ command: 'x', loop_limit: 0 })).code).not.toBe(0);
  });

  test('(d) 設定が object かを見る: 配列・null・文字列・数の最上位は断られる（user の層）', () => {
    for (const body of ['[]', 'null', '"x"', '5', '[{"version":1,"hooks":{}}]']) {
      const u = userNote(body);
      expect(u.line, body).toContain('user の hooks.json は cursor-agent に断られる（設定が object でない）');
      expect(u.code).toBe(0);
    }
  });
});
