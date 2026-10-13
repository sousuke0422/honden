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
    why: '未知の event 名 beforeShellExecutoin',
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
