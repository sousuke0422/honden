/**
 * 司令を閉じる前の伺い。
 *
 * 測りたいのは一つ——**「効かなんだ」が「通ってよし」に化けぬこと。**
 * 外の道具は塞がれた時も壊れた時も非 0 で終わるので、終了の数だけを
 * 見ると区別できない。
 */
import { describe, expect, test } from 'bun:test';
import { gateEnv, gateConfig, prOf, summaryVerdict, type Runner, type GateConfig } from '../src/reviewgate';

const CFG: GateConfig = { project: 'koyori', bin: ['task'] };

/** 決まった応えを返す贋の手。何をどう呼んだかも控える。 */
function fake(res: { code: number; stdout: string; stderr?: string } | null): {
  run: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: Runner = (argv) => {
    calls.push(argv);
    return res === null ? null : { code: res.code, stdout: res.stdout, stderr: res.stderr ?? '' };
  };
  return { run, calls };
}

const ok = JSON.stringify({ pr_number: 7, rounds: 1, mergeable: true, blocked_reason: null });
const ng = JSON.stringify({
  pr_number: 7,
  rounds: 1,
  mergeable: false,
  blocking: 2,
  blocked_reason: '2 high/medium finding(s) still unresolved',
});

describe('門は設定が無ければ名乗り出ぬ', () => {
  test('project が無ければ構えを起こさぬ', () => {
    expect(gateConfig(() => undefined)).toBeNull();
    expect(gateConfig((k) => (k === 'review.gate.bin' ? 'task' : undefined))).toBeNull();
  });

  test('project が在れば起こる。命の既定は task', () => {
    const c = gateConfig((k) => (k === 'review.gate.project' ? 'koyori' : undefined));
    expect(c?.project).toBe('koyori');
    expect(c?.bin).toEqual(['task']);
    expect(c?.repo).toBeUndefined();
  });

  test('命と repo は差せる（道を通したい時のため）', () => {
    const m: Record<string, string> = {
      'review.gate.project': 'koyori',
      'review.gate.bin': 'bun run /opt/task/cli.ts',
      'review.gate.repo': 'koyori-app/task',
    };
    const c = gateConfig((k) => m[k]);
    expect(c?.bin).toEqual(['bun', 'run', '/opt/task/cli.ts']);
    expect(c?.repo).toBe('koyori-app/task');
  });
});

describe('司令が PR を宣しておるか', () => {
  test('数でも文字でも受ける', () => {
    expect(prOf({ pr: 626 })).toBe(626);
    expect(prOf({ pr: ' 626 ' })).toBe(626);
  });

  test('宣しておらぬ・形が違えば null（門は働かぬ）', () => {
    for (const v of [{}, { pr: 0 }, { pr: -1 }, { pr: '1.5' }, { pr: 'main' }, null, 'x']) {
      expect(prOf(v)).toBeNull();
    }
  });
});

describe('伺いの読み方', () => {
  test('blocked_reason が空なら通す', () => {
    expect(summaryVerdict(CFG, 7, fake({ code: 0, stdout: ok }).run)).toEqual({ state: 'mergeable' });
  });

  test('埋まっておれば塞ぐ。理由をそのまま持ち帰る', () => {
    const v = summaryVerdict(CFG, 7, fake({ code: 1, stdout: ng }).run);
    expect(v.state).toBe('blocked');
    expect(v).toHaveProperty('reason', '2 high/medium finding(s) still unresolved');
  });

  test('**道具が無いのを「塞がれた」と読まぬ**', () => {
    const v = summaryVerdict(CFG, 7, fake(null).run);
    expect(v.state).toBe('unknown');
    expect(v).toHaveProperty('reason', expect.stringContaining('起こせなんだ'));
  });

  test('**応えが読めねば unknown。終了 0 でも信じぬ**', () => {
    // 壊れ方は非 0 とは限らぬ。0 で黙って空を返す道具もある
    for (const s of ['', 'not json', '<html>rate limited</html>']) {
      expect(summaryVerdict(CFG, 7, fake({ code: 0, stdout: s }).run).state).toBe('unknown');
    }
  });

  test('**別の命の応えを summary と読まぬ**（版が動いた時の守り）', () => {
    const other = JSON.stringify({ pr_number: 7, rounds: 1, mergeable: true }); // 鍵が無い
    const v = summaryVerdict(CFG, 7, fake({ code: 0, stdout: other }).run);
    expect(v.state).toBe('unknown');
  });

  test('**陰性対照** — mergeable だけを見ると壊れた応えが通ってしまう', () => {
    // `mergeable: true` を持つが blocked_reason を持たぬ物。上の試験が
    // 拾っておるのは、まさにこれが通らぬことである
    const other = JSON.parse(JSON.stringify({ mergeable: true }));
    expect(other.mergeable).toBe(true); // 素朴に読めば「通ってよし」
    expect(summaryVerdict(CFG, 7, fake({ code: 0, stdout: JSON.stringify(other) }).run).state).toBe(
      'unknown',
    );
  });

  test('頭の照合は task へ譲る（家老の樹は別の枝に居る）', () => {
    const f = fake({ code: 0, stdout: ok });
    summaryVerdict(CFG, 7, f.run);
    expect(f.calls[0]).toContain('--no-head-check');
    expect(f.calls[0]).toContain('--json');
    expect(f.calls[0]!.join(' ')).toContain('--pr 7');
  });

  test('repo は在る時だけ渡す', () => {
    const f1 = fake({ code: 0, stdout: ok });
    summaryVerdict(CFG, 7, f1.run);
    expect(f1.calls[0]).not.toContain('--repo');

    const f2 = fake({ code: 0, stdout: ok });
    summaryVerdict({ ...CFG, repo: 'koyori-app/task' }, 7, f2.run);
    expect(f2.calls[0]).toContain('koyori-app/task');
  });
});

/**
 * `cmd done` へ繋いだところ。
 *
 * 押さえたいのは二つ——**設定が無ければ黙る**（honden は task 無しで立つ）、
 * **頼めば効く**（そして効かなんだ時は通さぬ）。
 */
import { openStore } from '../src/store';
import { setSetting } from '../src/settings';
import { SETTINGS_PATH_KEY } from '../src/config';
import { reviewBlocker } from '../src/main';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 設定を持つ土台。`config get` は settings.yaml を引くので、鍵だけ据える。 */
function dbWith(settings: string | null) {
  const db = openStore({ path: ':memory:' });
  if (settings !== null) {
    const p = join(mkdtempSync(join(tmpdir(), 'honden-gate-')), 'settings.yaml');
    writeFileSync(p, settings);
    setSetting(db, SETTINGS_PATH_KEY, p, 'test');
  }
  return db;
}

describe('cmd done への繋ぎ', () => {
  const RAW = 'id: cmd_1\npr: 626\n';

  test('設定が無ければ黙る（task を要る物にせぬ）', () => {
    const db = dbWith(null);
    const f = fake({ code: 1, stdout: ng });
    expect(reviewBlocker(db, RAW, f.run)).toBeNull();
    expect(f.calls).toHaveLength(0); // 呼びにすら行かぬ
  });

  test('司令が pr を宣しておらねば働かぬ', () => {
    const db = dbWith('review:\n  gate:\n    project: koyori\n');
    const f = fake({ code: 1, stdout: ng });
    expect(reviewBlocker(db, 'id: cmd_1\n', f.run)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test('指摘が残っておれば塞ぐ', () => {
    const db = dbWith('review:\n  gate:\n    project: koyori\n');
    const b = reviewBlocker(db, RAW, fake({ code: 1, stdout: ng }).run);
    expect(b).toContain('#626');
    expect(b).toContain('still unresolved');
  });

  test('片付いておれば通す', () => {
    const db = dbWith('review:\n  gate:\n    project: koyori\n');
    expect(reviewBlocker(db, RAW, fake({ code: 0, stdout: ok }).run)).toBeNull();
  });

  test('**引けなんだ時も通さぬ**（頼んだ門が効かぬまま進ませぬ）', () => {
    const db = dbWith('review:\n  gate:\n    project: koyori\n');
    const b = reviewBlocker(db, RAW, fake(null).run);
    expect(b).toContain('引けなんだ');
    expect(b).toContain('通さぬ');
  });

  test('原文が解けずとも、そこでは塞がぬ（別の話ゆえ）', () => {
    const db = dbWith('review:\n  gate:\n    project: koyori\n');
    expect(reviewBlocker(db, '::: これは yaml ではない', fake(null).run)).toBeNull();
  });
});

describe('案件ごとの宛先（別の task を立てる筋）', () => {
  const M: Record<string, string> = {
    'review.gate.project': 'koyori',
    'review.gate.bin': 'task',
    'review.gates.myproj.project': 'local-task',
    'review.gates.myproj.api_url': 'http://127.0.0.1:3400',
    'review.gates.myproj.tenant': 't_xxx',
    'review.gates.myproj.token_env': 'TASK_TOKEN_MYPROJ',
  };
  const read = (k: string) => M[k];

  test('司令の project に上書きが在ればそれが勝つ。鍵ごとに落ちる', () => {
    const c = gateConfig(read, 'myproj')!;
    expect(c.project).toBe('local-task');
    expect(c.apiUrl).toBe('http://127.0.0.1:3400');
    expect(c.bin).toEqual(['task']); // gates に無い鍵は既定へ落ちる
    expect(gateConfig(read, 'other')!.project).toBe('koyori');
    expect(gateConfig(read)!.project).toBe('koyori');
  });

  test('宛先の env が runner へ渡る（token は env の名から引く）', () => {
    process.env['TASK_TOKEN_MYPROJ'] = 'tok-xyz';
    try {
      let got: Record<string, string> | undefined;
      const run: Runner = (_argv, env) => { got = env; return { code: 0, stdout: ok, stderr: '' }; };
      const v = summaryVerdict(gateConfig(read, 'myproj')!, 7, run);
      expect(v.state).toBe('mergeable');
      expect(got).toEqual({ TASK_API_URL: 'http://127.0.0.1:3400', TASK_TENANT: 't_xxx', TASK_TOKEN: 'tok-xyz' });
    } finally {
      delete process.env['TASK_TOKEN_MYPROJ'];
    }
  });

  test('**token_env を指したのに env が空なら通さぬ**（鍵なしで叩いて取り違えぬ）', () => {
    delete process.env['TASK_TOKEN_MYPROJ'];
    const run: Runner = () => { throw new Error('叩いてはならぬ'); };
    const v = summaryVerdict(gateConfig(read, 'myproj')!, 7, run as unknown as Runner);
    expect(v.state).toBe('unknown');
    expect(v).toHaveProperty('reason', expect.stringContaining('TASK_TOKEN_MYPROJ'));
  });

  test('**api_url を書かねば暗黙で task.koyori.app**（宛先だけが暗黙を持つ）', () => {
    let got: Record<string, string> | undefined;
    const run: Runner = (_a, env) => { got = env; return { code: 0, stdout: ok, stderr: '' }; };
    summaryVerdict(gateConfig(read)!, 7, run);
    expect(got).toEqual({ TASK_API_URL: 'https://task.koyori.app/api' });
    // tenant / token に暗黙は無い——取り違えたまま成功するのが一番怖い
    expect(got).not.toHaveProperty('TASK_TENANT');
    expect(got).not.toHaveProperty('TASK_TOKEN');
  });
});

describe('gateEnv — 門と起票が同じ宛先を通る', () => {
  test('指定なしは env 無し', () => {
    expect(gateEnv({ project: 'x', bin: ['task'] })).toEqual({ ok: true });
  });
  test('token_env が空なら拒む（起票側も同じ守りを得る）', () => {
    delete process.env['NO_SUCH_TOKEN_ENV'];
    const r = gateEnv({ project: 'x', bin: ['task'], tokenEnv: 'NO_SUCH_TOKEN_ENV' });
    expect(r.ok).toBe(false);
  });
});
