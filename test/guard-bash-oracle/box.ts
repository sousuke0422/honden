/**
 * 箱の中の bash を物差しにする試験の、箱（bubblewrap）。
 *
 * 箱の形:
 * - 全ての名前空間を分ける（`--unshare-all`）。網は lo だけで、外へ出られぬ
 * - 根は空の tmpfs を読み取り専用にした物（`--remount-ro /`）。手元の家・repo・/usr は見えぬ
 * - 入れるのは bash と、その共有 library だけ（どれも読み取り専用）。bash は `/oracle/sh` に置き、
 *   PATH の上にも `/bin` にも無い。他に走らせられる file は箱の中に無い
 * - 書き込めるのは `/tmp`（捨てる tmpfs）だけ。箱が閉じれば消える
 * - 命の字は手元の一時 dir の file から、読み取り専用で `/oracle/in/case` に置く
 * - 時限（既定 3 秒）を過ぎれば bwrap ごと殺す。PID の名前空間ゆえ、中の子も道連れに消える
 *
 * 箱が作れぬ環境（bwrap が無い・利用者の名前空間が使えぬ）では `probe()` が理由を返し、試験は撃たずに飛ばす。
 * **箱の外で bash に命の字を渡す道は、この file に作らぬ。**
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASH = '/usr/bin/bash';
const RECORDER = join(import.meta.dir, 'recorder.sh');

/** bash が要る共有 library の実の道（ldd で引く。ldd は bash の main を走らせぬ）。 */
function libraries(): string[] {
  const r = spawnSync('ldd', [BASH], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const m = /(?:=>\s*)?(\/\S+)\s+\(0x/.exec(line);
    if (m?.[1] && existsSync(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * 陽性対照の対照だけが使う、箱を緩めた形（物差しの本番では使わぬ）。
 * - `usr`: /usr を読み取り専用で置き、PATH を通す（走れば痕が残ることを見せるため）
 * - `net`: 網の名前空間を分けぬ（箱の網の断ちが効いておることを比べるため）
 */
export interface Loosen {
  usr?: boolean;
  net?: boolean;
}

/** 箱の bwrap の argv。`inDir` を `/oracle/in` に読み取り専用で置き、`script` を箱の bash に読ませる。 */
export function boxArgv(inDir: string, script: string, loosen: Loosen = {}): string[] {
  const binds: string[] = [];
  for (const lib of libraries()) {
    // 道が symlink なら、実の file を同じ道に置く（ld が道で探すため）
    binds.push('--ro-bind', realpathSync(lib), lib);
  }
  return [
    'bwrap',
    '--unshare-all',
    ...(loosen.net ? ['--share-net'] : []),
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    ...(loosen.usr ? ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib64', '/lib64', '--setenv', 'PATH', '/usr/bin'] : []),
    '--ro-bind', BASH, '/oracle/sh',
    ...(loosen.usr ? [] : binds),
    '--ro-bind', inDir, '/oracle/in',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/sink',
    '--chdir', '/tmp/sink',
    '--remount-ro', '/',
    '/oracle/sh', '--noprofile', '--norc', script,
  ];
}

export interface BoxRun {
  /** 箱の bash が fd 9（記録）と標準出力へ出した物 */
  stdout: string;
  status: number | null;
  /** 時限で殺した */
  timedOut: boolean;
}

/** `files` を一時 dir に書き、箱の中で `script`（箱の中の道）を撃つ。一時 dir は撃った後に消す。 */
export function runInBox(files: Record<string, string>, script: string, timeoutMs = 3000, loosen: Loosen = {}): BoxRun {
  const dir = mkdtempSync(join(tmpdir(), 'guard-bash-oracle-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const argv = boxArgv(dir, script, loosen);
    const r = spawnSync(argv[0]!, argv.slice(1), {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { stdout: r.stdout ?? '', status: r.status, timedOut };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 記録係（recorder.sh）を箱に入れ、命の字 `cmd` を読ませる。 */
export function record(cmd: string, timeoutMs = 3000): BoxRun {
  return runInBox({ case: cmd, 'recorder.sh': readFileSync(RECORDER, 'utf8') }, '/oracle/in/recorder.sh', timeoutMs);
}

/** 箱が作れるか。作れねば理由を返す（試験はこれを見て飛ばす）。 */
export function probe(): string | undefined {
  const which = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  if (which.status !== 0) return 'bwrap が無い';
  if (!existsSync(BASH)) return `${BASH} が無い`;
  if (libraries().length === 0) return 'bash の共有 library を引けぬ（ldd）';
  const r = runInBox({ 'probe.sh': 'echo box-ok\n' }, '/oracle/in/probe.sh');
  if (r.stdout.trim() !== 'box-ok') return `箱を作れぬ（利用者の名前空間が使えぬ等）: status=${r.status}`;
  return undefined;
}
