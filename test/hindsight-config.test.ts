/**
 * 足軽の env に書いた HINDSIGHT_CONFIG の file を、出陣と立て直しの前に検める（runConfigEnv）。
 *
 * hindsight-coding-agents@0.7.0 の hook は、設定が読めねば・壊れておれば空と見て、既定の
 * 送り先（Cloud）へ会話を送る。在らぬ・壊れた・自前の server を指さぬ設定は、起こす前に止める。
 *
 * file は使い捨ての dir に偽の値で作る。本物の ~/.hindsight と試しの dir は読まぬ。
 * 偽の token（FAKE_TOKEN）が、出にも止まる文にも載らぬことを、各形で見る。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { HINDSIGHT_HARNESS, SETTINGS_PATH_KEY } from '../src/config';
import { LAUNCHABLE_CLIS } from '../src/rosteredit';
import { runConfigEnv } from '../src/main';

const BASE = mkdtempSync(join(tmpdir(), 'honden-hindsight-config-'));
const FAKE_TOKEN = 'hs-FAKE-token-0000-do-not-print';

/** 使い捨ての設定と正本。agents は settings の cli.agents の YAML の行。 */
function store(agents: string): string {
  const dir = mkdtempSync(join(BASE, 'db-'));
  const sp = join(dir, 'settings.yaml');
  writeFileSync(sp, `cli:\n  agents:\n${agents}`);
  const path = join(dir, 'h.db');
  const db = openStore({ path });
  tx(db, () => setSetting(db, SETTINGS_PATH_KEY, sp, 'roster'));
  db.close();
  return path;
}
/** 使い捨ての dir に、設定の file を書く（中身は文のまま）。 */
function cfgFile(body: string): string {
  const p = join(mkdtempSync(join(BASE, 'hs-')), 'coding-agent.json');
  writeFileSync(p, body);
  return p;
}
const agent = (id: string, cli: string, cfg?: string) =>
  `    ${id}:\n      type: ${cli}\n` + (cfg !== undefined ? `      env:\n        HINDSIGHT_CONFIG: ${JSON.stringify(cfg)}\n` : '');
/** 止まったことと、文が Cloud を名指しし、偽の token を載せぬこと。 */
function stopped(r: { code: number; out?: string; err?: string }, said: string, label: string) {
  expect(r.code, label).not.toBe(0);
  expect(r.err, label).toContain(said);
  expect(r.err, label).toContain('Cloud');
  expect(r.out ?? '', label).toBe('');
  expect(`${r.out ?? ''}${r.err ?? ''}`, label).not.toContain(FAKE_TOKEN);
}

describe('HINDSIGHT_CONFIG の file が読めねば・壊れておれば止まる', () => {
  test('(1) 在らぬ道で非ゼロ', () => {
    const missing = join(mkdtempSync(join(BASE, 'none-')), 'coding-agent.json');
    stopped(runConfigEnv(store(agent('ashigaru3', 'claude', missing)), 'ashigaru3'), '在らぬ', 'missing');
  });

  test('(2) 壊れた JSON で非ゼロ（例外の文は使わず、file の中身を載せぬ）', () => {
    for (const body of [`{"serverMode": "self-hosted", "apiToken": "${FAKE_TOKEN}"`, `apiToken=${FAKE_TOKEN}`, '[1, 2]', '"str"', 'null']) {
      const p = cfgFile(body);
      stopped(runConfigEnv(store(agent('ashigaru3', 'claude', p)), 'ashigaru3'), 'JSON', body);
    }
  });
});

describe('(c) 読めて JSON も通るが、0.7.0 の resolveConfig で Cloud へ向かう形も止まる', () => {
  test('(3) {}・serverMode: cloud・serverMode 無し・self-hosted で apiUrl 無し・apiUrl が Cloud の host', () => {
    for (const [label, body, said] of [
      ['{}', '{}', 'serverMode'],
      ['cloud', `{"serverMode": "cloud", "apiToken": "${FAKE_TOKEN}"}`, 'serverMode'],
      ['知らぬ値', `{"serverMode": "bogus", "apiUrl": "http://127.0.0.1:8888"}`, 'serverMode'],
      ['serverMode 無し', `{"apiUrl": "http://127.0.0.1:8888", "apiToken": "${FAKE_TOKEN}"}`, 'serverMode'],
      ['apiUrl 無し', `{"serverMode": "self-hosted", "apiToken": "${FAKE_TOKEN}"}`, 'apiUrl'],
      ['apiUrl が空', `{"serverMode": "self-hosted", "apiUrl": ""}`, 'apiUrl'],
      ['apiUrl が Cloud', `{"serverMode": "self-hosted", "apiUrl": "https://api.hindsight.vectorize.io", "apiToken": "${FAKE_TOKEN}"}`, 'apiUrl'],
    ] as const) {
      stopped(runConfigEnv(store(agent('ashigaru3', 'claude', cfgFile(body))), 'ashigaru3'), said, label);
    }
  });

  test('(3) harness の節（claude は claude-code）が上の段を Cloud へ上書きする形も止まる', () => {
    const body = JSON.stringify({
      serverMode: 'self-hosted',
      apiUrl: 'http://127.0.0.1:8888',
      apiToken: FAKE_TOKEN,
      harnesses: { 'claude-code': { serverMode: 'cloud' } },
    });
    const p = cfgFile(body);
    stopped(runConfigEnv(store(agent('ashigaru3', 'claude', p)), 'ashigaru3'), 'serverMode', 'harness claude-code');
    // 同じ file でも、codex の足軽には claude-code の節は効かぬ（上の段の self-hosted のまま）
    const r = runConfigEnv(store(agent('ashigaru4', 'codex', p)), 'ashigaru4');
    expect(r.code, r.err).toBe(0);
  });
});

describe('陽性対照', () => {
  test('(4) self-hosted と apiUrl を持つ file（偽の token）は code=0 で、env の行が今どおり出る', () => {
    const p = cfgFile(JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'http://127.0.0.1:8888', apiToken: FAKE_TOKEN }));
    const r = runConfigEnv(store(agent('ashigaru3', 'claude', p)), 'ashigaru3');
    expect(r).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${p}'` });
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  test('(4) daemon（127.0.0.1 の手元の server）も通る。harness の節が self-hosted へ直す形も通る', () => {
    const d = cfgFile(JSON.stringify({ serverMode: 'daemon' }));
    expect(runConfigEnv(store(agent('ashigaru3', 'claude', d)), 'ashigaru3').code).toBe(0);
    const h = cfgFile(JSON.stringify({ harnesses: { codex: { serverMode: 'self-hosted', apiUrl: 'http://hs.lan:8888' } } }));
    expect(runConfigEnv(store(agent('ashigaru4', 'codex', h)), 'ashigaru4').code).toBe(0);
  });

  test('(5) HINDSIGHT_CONFIG を書かぬ足軽は今どおり（file を検めず、前置きも今のまま）', () => {
    const db = store(agent('ashigaru1', 'claude') + `    ashigaru2:\n      type: codex\n      env:\n        CODEX_HOME: /home/me/.codex-a2\n`);
    expect(runConfigEnv(db, 'ashigaru1')).toEqual({ code: 0, out: '' });
    expect(runConfigEnv(db, 'ashigaru2')).toEqual({ code: 0, out: `CODEX_HOME='/home/me/.codex-a2'` });
  });
});

describe('opencode の足軽にも harness の節（opencode）を重ねる', () => {
  // 上の段は self-hosted、harnesses.opencode だけが Cloud へ向ける
  const body = JSON.stringify({
    serverMode: 'self-hosted',
    apiUrl: 'http://127.0.0.1:8888',
    apiToken: FAKE_TOKEN,
    harnesses: { opencode: { serverMode: 'cloud' } },
  });

  test('(1) harnesses.opencode が cloud なら opencode の足軽は非ゼロ', () => {
    stopped(runConfigEnv(store(agent('ashigaru6', 'opencode', cfgFile(body))), 'ashigaru6'), 'harnesses.opencode', 'opencode cloud');
  });

  test('(2) 陽性対照: harnesses.opencode が self-hosted なら code=0', () => {
    const ok = cfgFile(
      JSON.stringify({
        serverMode: 'self-hosted',
        apiUrl: 'http://127.0.0.1:8888',
        apiToken: FAKE_TOKEN,
        harnesses: { opencode: { serverMode: 'self-hosted', apiUrl: 'http://hs.lan:8888' } },
      }),
    );
    const r = runConfigEnv(store(agent('ashigaru6', 'opencode', ok)), 'ashigaru6');
    expect(r).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${ok}'` });
  });

  test('(3) 同じ file でも codex の足軽には opencode の節は効かぬ（code=0）', () => {
    const r = runConfigEnv(store(agent('ashigaru4', 'codex', cfgFile(body))), 'ashigaru4');
    expect(r.code, r.err).toBe(0);
  });

  test('(4) 対応表が LAUNCHABLE_CLIS を覆い、名が 0.7.0 の源に在る harness の名である', () => {
    // hindsight-coding-agents@0.7.0 の dist で harness として渡る名（claude-hook.js 等と
    // dist/index.js の createPluginEntry("opencode")）。opencode2 は別の CLI（v2）の名ゆえ載せぬ。
    const known = ['claude-code', 'codex', 'cursor-cli', 'opencode'];
    for (const cli of LAUNCHABLE_CLIS) {
      expect(HINDSIGHT_HARNESS[cli], cli).toBeString();
      expect(known, cli).toContain(HINDSIGHT_HARNESS[cli]);
    }
    expect(Object.keys(HINDSIGHT_HARNESS).sort()).toEqual([...LAUNCHABLE_CLIS].sort());
  });
});

describe('harness の名が分からぬ足軽', () => {
  const noType = (id: string, cfg: string) => `    ${id}:\n      env:\n        HINDSIGHT_CONFIG: ${JSON.stringify(cfg)}\n`;

  test('(5) type が無く、file に harnesses の鍵が在れば非ゼロ', () => {
    const p = cfgFile(
      JSON.stringify({
        serverMode: 'self-hosted',
        apiUrl: 'http://127.0.0.1:8888',
        apiToken: FAKE_TOKEN,
        harnesses: { 'claude-code': { serverMode: 'cloud' } },
      }),
    );
    stopped(runConfigEnv(store(noType('ashigaru7', p)), 'ashigaru7'), 'harness の名が分からぬ', 'type 無し');
    // 表に無い CLI（設定は type: kimi を受ける）も同じ。harnesses が空の写像でも鍵が在れば止める
    stopped(runConfigEnv(store(agent('ashigaru8', 'kimi', p)), 'ashigaru8'), 'harness の名が分からぬ', 'kimi');
    const empty = cfgFile(JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'http://127.0.0.1:8888', harnesses: {} }));
    stopped(runConfigEnv(store(agent('ashigaru8', 'kimi', empty)), 'ashigaru8'), 'harness の名が分からぬ', 'kimi 空の harnesses');
  });

  test('(5) type が無くても、harnesses の鍵が無ければ今どおり（code=0）', () => {
    const p = cfgFile(JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'http://127.0.0.1:8888', apiToken: FAKE_TOKEN }));
    expect(runConfigEnv(store(noType('ashigaru7', p)), 'ashigaru7')).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${p}'` });
    expect(runConfigEnv(store(agent('ashigaru8', 'kimi', p)), 'ashigaru8')).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${p}'` });
  });
});

describe('banks.<id> の節も同じ判じにかける（applyBankConfig は serverMode・apiUrl を除かず重ねる）', () => {
  const top = { serverMode: 'self-hosted', apiUrl: 'http://127.0.0.1:8888', apiToken: FAKE_TOKEN };
  const bad = [
    ['serverMode が cloud', { serverMode: 'cloud' }, 'serverMode'],
    ['serverMode が知らぬ値', { serverMode: 'bogus' }, 'serverMode'],
    ['serverMode が null', { serverMode: null }, 'serverMode'],
    ['apiUrl が Cloud', { apiUrl: 'https://api.hindsight.vectorize.io' }, 'apiUrl'],
    ['apiUrl が URL でない', { apiUrl: 'not a url' }, 'apiUrl'],
    ['apiUrl が null', { apiUrl: null }, 'apiUrl'],
  ] as const;

  test('(6) 上の段の banks.x が Cloud へ向ければ、節の名を名指しして非ゼロ', () => {
    for (const [label, sec, said] of bad) {
      const p = cfgFile(JSON.stringify({ ...top, banks: { x: { ...sec, apiToken: FAKE_TOKEN } } }));
      const r = runConfigEnv(store(agent('ashigaru3', 'claude', p)), 'ashigaru3');
      stopped(r, 'banks.x', label);
      expect(r.err, label).toContain(said);
    }
  });

  test('(6) harnesses.<harness>.banks.x も同じ（claude は claude-code、opencode は opencode）', () => {
    for (const [cli, harness] of [['claude', 'claude-code'], ['opencode', 'opencode']] as const) {
      for (const [label, sec, said] of bad) {
        const p = cfgFile(JSON.stringify({ ...top, harnesses: { [harness]: { banks: { x: sec } } } }));
        const r = runConfigEnv(store(agent('ashigaru3', cli, p)), 'ashigaru3');
        stopped(r, `harnesses.${harness}.banks.x`, `${cli} ${label}`);
        expect(r.err, label).toContain(said);
      }
    }
  });

  test('(7) 陽性対照: banks.x が自前の値だけを持てば code=0（上の段も harness の節も）', () => {
    const sec = { serverMode: 'self-hosted', apiUrl: 'http://hs.lan:8888', apiToken: FAKE_TOKEN, bankIdTemplate: '{repo}' };
    const p = cfgFile(
      JSON.stringify({ ...top, banks: { x: sec, y: { serverMode: 'daemon' }, z: { retainTags: ['a'] } }, harnesses: { 'claude-code': { banks: { x: sec } } } }),
    );
    const r = runConfigEnv(store(agent('ashigaru3', 'claude', p)), 'ashigaru3');
    expect(r).toEqual({ code: 0, out: `HINDSIGHT_CONFIG='${p}'` });
  });
});
