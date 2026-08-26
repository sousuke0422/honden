/**
 * 場所の取り置き。
 *
 * ## 貸与とは別のものを答える
 *
 * 貸与 (src/lease.ts) が答えるのは「その足軽が塞がっておるか」。
 * 取り置きが答えるのは「**その worktree を誰が握っておるか**」。
 *
 * 足軽 2 号が空いていても、足軽 1 号が握っておる木へ振ってはならない。
 * 貸与だけでは、その振り分けが通ってしまう。
 *
 * ## 現行の決めは、構造上守れない
 *
 *   instructions/ashigaru.md:168      他の足軽のファイルを絶対に読むな
 *   instructions/ashigaru.md RACE-001 衝突の恐れがあれば blocked にして家老へ伺え
 *
 * 足軽は他人の持ち場を見られないので、恐れに気づけない。
 * 見えるのは家老だけで、その拠り所は記憶しかない。
 * 実際に worktree を重ねて merge commit を生んだ (2026-08-25)。
 *
 * ゆえに二つ置く。
 *
 *   1. 振る時に重なりを検める（家老の記憶に頼らない）
 *   2. 足軽が自分で問える `honden claim check <場所>`
 *      —— 他人の持ち場を読まずに、重なりの有無だけ分かる
 *
 * ## 断る時は路を示す
 *
 * 「使えぬ」だけでは、塞がれた側が勝手な道を探す。
 * 誰が・いつから握っておるかと、取りうる三つの手を並べる。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { checkReason } from './validate';
import { roleOf } from './roster';
import { resolve, dirname, basename, join } from 'node:path';
import { statSync, realpathSync } from 'node:fs';

export const KINDS = ['path', 'branch'] as const;
export type Kind = (typeof KINDS)[number];

export const SOURCES = ['declared', 'inferred'] as const;
export type Source = (typeof SOURCES)[number];

export interface Claim {
  id: number;
  kind: Kind;
  value: string;
  agent: string;
  taskId: string | null;
  cmdId: string | null;
  at: string;
  /**
   * declared —— 振る時に明示された。**約束**ゆえ、重なれば断る
   * inferred —— 案件の所在から補った。**見立て**ゆえ、断らずに知らせるだけ
   *
   * 見立てを約束と同じに扱ってはならない。誰も約束していない場所で
   * 仕事を断ることになる。現行では一つの案件へ複数の足軽を振るのが常で、
   * 案件の根を握らせて断れば、その常道が止まる。
   */
  source: Source;
}

/**
 * 同じ場所が同じ文字列になるように均す。
 *
 * 三つを均す。
 *
 *   一、相対を絶対へ。相対のままだと同じ場所が別物に見える
 *   二、symlink を辿る（実在する時だけ）。同じ木を二つの名で指せるゆえ
 *   三、大小を区別せぬ土地では小文字へ畳む
 *
 * ## 三つ目は土地によって違う（2026-08-26 実測）
 *
 *   /mnt/c (DrvFs)  区別せぬ —— .worktrees/VRT-FIX32 で同じ木が開く
 *   ext4            区別する
 *
 * 一律に畳むと、ext4 で本当に別の二つを同じものにしてしまう。
 * 一律に畳まぬと、/mnt/c で**同じ木へ二人が入れる**。
 * ゆえに土地を測る——推し量らずに、実際に確かめる。
 */
export function normalize(kind: Kind, value: string, cwd?: string): string {
  const v = value.trim();
  if (kind !== 'path') return v;
  let p = resolve(cwd ?? process.cwd(), v).replace(/\/+$/, '');
  // symlink は実在する時だけ辿れる。これから切る worktree は実在せぬので、
  // 辿れぬことは異常ではない。
  try {
    p = realpathSync(p);
  } catch {
    // そのままでよい
  }
  return caseInsensitiveAt(p) ? p.toLowerCase() : p;
}

/** 一度測った土地は覚える。同じ mount を何度も測らぬため。 */
const caseFoldCache = new Map<string, boolean>();

/**
 * その場所が大小を区別せぬ土地にあるか。
 *
 * **推し量らずに測る。** `/mnt/` で始まるかで決めると、
 * case-sensitive を明示した DrvFs や、別の mount で誤る。
 *
 * 実在する最も近い祖先を探し、その名の大小を入れ替えて同じ inode を
 * 指すかを見る。名に英字が無ければ、さらに上へ遡る。
 * 測れなければ「区別する」に倒す——畳まぬ側は、多く断るだけで済む。
 */
export interface StatLike {
  ino: number | bigint;
  dev: number | bigint;
}

export function caseInsensitiveAt(
  path: string,
  // 測り方を差し替えられるようにする。差し替えられぬと、
  // 「土地を測っておるのか、パスから推し量っておるのか」を
  // 試験が見分けられない（この機では /mnt/ の当て推量でも同じ答えが出る）。
  stat: (p: string) => StatLike = statSync,
): boolean {
  let dir = path;
  for (let i = 0; i < 40; i++) {
    const parent = dirname(dir);
    const name = basename(dir);
    if (parent === dir) break; // 根まで来た

    if (/[A-Za-z]/.test(name)) {
      const flipped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
      const key = `${parent}\u0000${name}`;
      const cached = caseFoldCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const a = stat(join(parent, name));
        const b = stat(join(parent, flipped));
        const same = a.ino === b.ino && a.dev === b.dev;
        caseFoldCache.set(key, same);
        return same;
      } catch {
        // 実在せぬ。上へ遡る
      }
    }
    dir = parent;
  }
  return false;
}

/**
 * 二つの取り置きが重なるか。
 *
 * path は前置きの一致まで見る。`.worktrees/x` を握っておる者が居れば
 * `.worktrees/x/apps` も重なる——同じ木の中だからで、
 * 文字列が違えば別物としてしまうと、一段深い所から入れてしまう。
 *
 * 区切りの境目で切る。`/a/bc` は `/a/b` の中ではない。
 */
export function overlaps(a: { kind: Kind; value: string }, b: { kind: Kind; value: string }): boolean {
  if (a.kind !== b.kind) return false;
  if (a.value === b.value) return true;
  if (a.kind !== 'path') return false;
  const [short, long] = a.value.length < b.value.length ? [a.value, b.value] : [b.value, a.value];
  return long.startsWith(short.endsWith('/') ? short : `${short}/`);
}

export function live(db: Database): Claim[] {
  return (
    db
      .query(
        'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, source FROM claim WHERE released_at IS NULL ORDER BY id',
      )
      .all() as Claim[]
  );
}

/**
 * その場所と重なる、生きた取り置き。
 *
 * `declaredOnly` を立てると、約束されたものだけを見る。
 * 振る門はこちらを使う——見立てで仕事を断ってはならぬゆえ。
 */
export function conflicts(db: Database, kind: Kind, value: string, exclude?: string, declaredOnly = false): Claim[] {
  const want = { kind, value: normalize(kind, value) };
  return live(db).filter(
    (c) => c.agent !== exclude && overlaps(want, c) && (!declaredOnly || c.source === 'declared'),
  );
}

export interface ClaimResult {
  ok: boolean;
  id?: number;
  message?: string;
  held?: Claim[];
}

/** 断る時に出す文。**取りうる手を並べる。** */
export function explainConflict(kind: Kind, value: string, held: Claim[]): string {
  const lines = [
    `${kind === 'path' ? 'その場所' : 'その枝'}は既に握られておる: ${value}`,
    ...held.map(
      (c) => `    ${c.agent} が ${c.at} から（${c.taskId ?? '仕事不明'} / ${c.cmdId ?? '司令不明'}）: ${c.value}`,
    ),
    '',
    '  取りうる手は三つ。',
    '    一、待つ。相手が納めれば取り置きは解ける',
    '    二、別の場所を切る。worktree なら新しく切ればよい',
    `    三、譲らせる。家老が honden claim release ${held[0]?.id ?? '<番号>'} --force --reason "…" で解ける`,
    '',
    '  三は相手の仕掛かりを止める。止めてよいか確かめてからにされよ。跡は台帳に残る。',
  ];
  return lines.join('\n');
}

/**
 * 場所を取り置く。
 *
 * 重なりがあれば断る。**書き込みは行わない。**
 */
export function take(
  db: Database,
  opts: {
    kind: Kind;
    value: string;
    agent: string;
    taskId?: string;
    cmdId?: string;
    now?: Date;
    /** 既定は declared。見立てなら 'inferred'。 */
    source?: Source;
  },
): ClaimResult {
  const now = opts.now ?? new Date();
  if (!(KINDS as readonly string[]).includes(opts.kind)) {
    return { ok: false, message: `取り置けるのは ${KINDS.join(' か ')} である。` };
  }
  const value = normalize(opts.kind, opts.value);
  if (value === '') return { ok: false, message: '取り置く場所が空である。' };

  const source: Source = opts.source ?? 'declared';

  // 同じ者が同じ所を取り直すのは通す。振り直しで倒れては困る。
  //
  // 見立て (inferred) は断らない。誰も約束していない場所で仕事を止めることになる。
  // 現行は一つの案件へ複数の足軽を振るのが常で、案件の根を握らせて断れば
  // その常道が止まる。見立ては「そこに誰が居るか」を見えるようにするためだけに置く。
  if (source === 'declared') {
    const held = conflicts(db, opts.kind, value, opts.agent, true);
    if (held.length > 0) {
      return { ok: false, held, message: explainConflict(opts.kind, value, held) };
    }
  }

  db.prepare('INSERT INTO claim(kind, value, agent, task_id, cmd_id, at, source) VALUES (?,?,?,?,?,?,?)').run(
    opts.kind,
    value,
    opts.agent,
    opts.taskId ?? null,
    opts.cmdId ?? null,
    now.toISOString(),
    source,
  );
  const id = Number((db.query('SELECT last_insert_rowid() n').get() as { n: number }).n);
  journal(db, {
    actor: opts.agent,
    action: source === 'inferred' ? 'claim.infer' : 'claim.take',
    target: value,
    detail: `kind=${opts.kind} task=${opts.taskId ?? 'なし'} cmd=${opts.cmdId ?? 'なし'}`,
  });
  return { ok: true, id };
}

/** その足軽の取り置きを全部解く。仕事を納めた時に呼ぶ。 */
export function releaseAllOf(db: Database, agent: string, now: Date = new Date()): number {
  const held = live(db).filter((c) => c.agent === agent);
  if (held.length === 0) return 0;
  db.run('UPDATE claim SET released_at = ? WHERE released_at IS NULL AND agent = ?', [now.toISOString(), agent]);
  journal(db, {
    actor: agent,
    action: 'claim.release',
    target: held.map((c) => c.value).join(' / '),
    detail: `${held.length} 件`,
  });
  return held.length;
}

/**
 * 一つ解く。
 *
 * 他人のものは force と理由が要る。**譲らせるのは相手の仕掛かりを止めること**ゆえ、
 * 誤って通れてはならない。貸与の強制解除 (src/lease.ts) と同じ四箇条を課す。
 */
export function release(
  db: Database,
  opts: { id: number; by: string; force?: boolean; reason?: string; now?: Date },
): ClaimResult {
  const now = opts.now ?? new Date();
  const c = db
    .query(
      'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, source FROM claim WHERE id = ? AND released_at IS NULL',
    )
    .get(opts.id) as Claim | null;
  if (!c) return { ok: false, message: `生きた取り置きが無い: #${opts.id}` };

  if (c.agent !== opts.by) {
    // 譲らせるのは相手の仕掛かりを止めること。上役の裁定にする。
    //
    // 案内文は「家老が」と言うておったのに、実装はどの名乗りでも通っていた。
    // 散文の禁止を構造へ移したと言いながら、移っておらなんだ。
    if (roleOf(opts.by) !== 'commander') {
      return {
        ok: false,
        held: [c],
        message:
          `${c.value} を握っておるのは ${c.agent} である。足軽が他人の取り置きを解くことはできぬ。\n` +
          '  家老へ回されよ。譲らせるかどうかは裁定である。',
      };
    }
    if (!opts.force) {
      return {
        ok: false,
        held: [c],
        message:
          `${c.value} を握っておるのは ${c.agent} である。他人の取り置きは解けぬ。\n` +
          `  譲らせるなら --force --reason "…" で解ける。相手の仕掛かりが止まる。\n` +
          '  跡は台帳に残る。',
      };
    }
    const bad = checkReason(opts.reason, `${c.agent} の pane が落ちて 1 時間`);
    if (bad) return { ok: false, held: [c], message: bad };
  }

  db.run('UPDATE claim SET released_at = ? WHERE id = ?', [now.toISOString(), opts.id]);
  const forced = c.agent !== opts.by;
  journal(db, {
    actor: opts.by,
    action: forced ? 'claim.release.force' : 'claim.release',
    target: c.value,
    // 譲らせた時は、相手がその時どう見えていたかを併せて残す。
    // 後から「本当に止まっていたか」を検めるため。
    detail: forced
      ? `prev=${c.agent} task=${c.taskId ?? '不明'} 握り始め=${c.at} reason=${JSON.stringify(opts.reason)}`
      : `task=${c.taskId ?? '不明'}`,
  });
  return { ok: true, id: c.id };
}
