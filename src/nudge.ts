/**
 * 合図を飛ばす側。
 *
 * 常駐する芯 (core/watch) から呼ばれる。芯は「何か起きた」としか言わないので、
 * 誰に何を撃つかはここで決める。
 *
 * ## 段（escalation）は現行踏襲
 *
 * CLAUDE.md の表をそのまま写した。
 *
 * | 経ち | すること |
 * |---|---|
 * | 0〜2 分 | 素の合図 |
 * | 2〜4 分 | 立て直しの合図。Copilot/Kimi は Escape×2 + Ctrl-C を先に打つ |
 * | 4 分〜 | 文脈を消させる。5 分に一度まで |
 *
 * 段は覚えず、時刻の差から毎回計算する。段を持つと、覚えと実際がずれた時に
 * どちらが正しいか決まらない。
 *
 * ## 将軍へは撃たない
 *
 * 殿の入力を割り込みで潰すゆえ。現行 karo.md の `to_shogun: false` と同じ理由で、
 * こちらは配達の側から塞ぐ。夜間の自律運用だけが例外で、明示の旗が要る。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { summarize, nudgeText, type Summary } from './inbox';
import { roster } from './roster';
import { panes, type Pane } from './pane';

/** 殿の入力を潰さぬため、既定では撃たぬ相手。 */
export const NEVER_NUDGE = 'shogun';

export const LEVEL_2_AFTER_MS = 2 * 60_000;
export const LEVEL_3_AFTER_MS = 4 * 60_000;
/** 同じ段を撃ち直すまでの間。うるさくせぬため。 */
export const REPEAT_MS = 60_000;
/** 文脈を消させるのは 5 分に一度まで。 */
export const RESET_COOLDOWN_MS = 5 * 60_000;

/** 立て直しに Escape×2 と Ctrl-C を要する CLI。現行 CLAUDE.md より。 */
const NEEDS_HARD_RECOVERY = new Set(['copilot', 'kimi']);
/** 文脈を消す命令。CLI ごとに違う。 */
const RESET_COMMAND: Record<string, string> = {
  claude: '/clear',
  copilot: '/clear',
  kimi: '/clear',
  codex: '/new',
  opencode: '/new',
  cursor: '/clear',
};

export type Level = 1 | 2 | 3;

export interface Plan {
  agent: string;
  pane?: Pane;
  cli: string | null;
  unread: number;
  level: Level;
  /** 実際に撃つか。撃たぬ時は理由がつく。 */
  send: boolean;
  reason?: string;
  /** 撃つ中身。 */
  text: string;
  /** 先に Escape×2 と Ctrl-C を打つか。 */
  hardRecovery: boolean;
  /** 次にこの相手を見るまでの間 (ms)。 */
  nextInMs: number;
}

interface State {
  since: string | null;
  last_at: string | null;
  last_level: number | null;
  last_reset_at: string | null;
}

function stateOf(db: Database, agent: string): State {
  return (
    (db.query('SELECT since, last_at, last_level, last_reset_at FROM nudge WHERE agent = ?').get(agent) as
      | State
      | null) ?? { since: null, last_at: null, last_level: null, last_reset_at: null }
  );
}

export function levelFor(elapsedMs: number): Level {
  if (elapsedMs >= LEVEL_3_AFTER_MS) return 3;
  if (elapsedMs >= LEVEL_2_AFTER_MS) return 2;
  return 1;
}

/**
 * 誰に何を撃つか決める。**何も撃たない。**
 *
 * 決めるところと撃つところを分けておくと、--dry-run が
 * 「撃たぬ経路」ではなく「同じ経路の途中まで」になる。
 * 別経路にすると、試した形と本番の形が違ってしまう。
 */
export function plan(
  db: Database,
  now: Date = new Date(),
  // ペインの一覧は差し替えられるようにする。試験が tmux の在り様に
  // 左右されると、布陣が動くたびに赤くなる。
  opts: { wakeShogun?: boolean; panes?: Map<string, Pane> } = {},
): Plan[] {
  const p = opts.panes ?? panes();
  const out: Plan[] = [];

  for (const entry of roster(db)) {
    const s: Summary = summarize(db, entry.id);
    const st = stateOf(db, entry.id);

    if (s.total === 0) continue;

    const since = st.since ? new Date(st.since) : now;
    const elapsed = now.getTime() - since.getTime();
    const level = levelFor(elapsed);
    const pane = p.get(entry.id);

    let send = true;
    let reason: string | undefined;

    if (entry.id === NEVER_NUDGE && !opts.wakeShogun) {
      send = false;
      reason = '将軍へは撃たぬ。殿の入力を割り込みで潰すゆえ。';
    } else if (!pane) {
      send = false;
      reason = `${entry.id} のペインが見つからぬ。布陣に居らぬか、@agent_id が付いておらぬ。`;
    } else if (st.last_at) {
      const sinceLast = now.getTime() - new Date(st.last_at).getTime();
      // 段が上がったなら間を置かずに撃つ。上がっておらぬなら間を置く。
      const rose = st.last_level !== null && level > st.last_level;
      if (!rose && sinceLast < REPEAT_MS) {
        send = false;
        reason = `${Math.round((REPEAT_MS - sinceLast) / 1000)} 秒後まで撃ち直さぬ`;
      }
    }

    if (send && level === 3) {
      const last = st.last_reset_at ? new Date(st.last_reset_at).getTime() : 0;
      if (now.getTime() - last < RESET_COOLDOWN_MS) {
        // 文脈を消すのは重い。連発すると仕掛かりを繰り返し捨てる。
        // 消せぬ間は素の合図へ落とす。黙るのではない。
        out.push(build(entry.id, entry.cli, pane, s, 2, true, undefined, now, st));
        continue;
      }
    }

    out.push(build(entry.id, entry.cli, pane, s, level, send, reason, now, st));
  }

  return out;
}

function build(
  agent: string,
  cli: string | null,
  pane: Pane | undefined,
  s: Summary,
  level: Level,
  send: boolean,
  reason: string | undefined,
  now: Date,
  st: State,
): Plan {
  const text = level === 3 ? RESET_COMMAND[cli ?? ''] ?? '/clear' : nudgeText(s);
  const hardRecovery = level === 2 && NEEDS_HARD_RECOVERY.has(cli ?? '');

  // 次にこの相手を見るまで。段が上がる時刻か、撃ち直せる時刻の早いほう。
  const since = st.since ? new Date(st.since).getTime() : now.getTime();
  const elapsed = now.getTime() - since;
  const toNextLevel =
    elapsed < LEVEL_2_AFTER_MS
      ? LEVEL_2_AFTER_MS - elapsed
      : elapsed < LEVEL_3_AFTER_MS
        ? LEVEL_3_AFTER_MS - elapsed
        : RESET_COOLDOWN_MS;
  const nextInMs = Math.max(1000, Math.min(toNextLevel, REPEAT_MS));

  return { agent, pane, cli, unread: s.total, level, send, reason, text, hardRecovery, nextInMs };
}

/** 撃った跡を残す。 */
export function record(db: Database, p: Plan, now: Date): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO nudge(agent, since, last_at, last_level, last_reset_at)
     VALUES (?, COALESCE((SELECT since FROM nudge WHERE agent = ?), ?), ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       since = COALESCE(nudge.since, excluded.since),
       last_at = excluded.last_at,
       last_level = excluded.last_level,
       last_reset_at = COALESCE(excluded.last_reset_at, nudge.last_reset_at)`,
  ).run(p.agent, p.agent, at, at, p.level, p.level === 3 ? at : null);

  journal(db, {
    actor: 'nudge',
    action: p.level === 3 ? 'nudge.reset' : `nudge.L${p.level}`,
    target: p.agent,
    detail: `unread=${p.unread} pane=${p.pane?.label ?? 'なし'} ${JSON.stringify(p.text)}`,
  });
}

/**
 * 未読が片付いた者の覚えを消す。
 *
 * 消さぬと、次に未読が来た時に前の since が残っており、
 * **いきなり段 3 から始まる**。文脈をいきなり消させることになる。
 */
export function forget(db: Database, agents: string[]): void {
  if (agents.length === 0) return;
  const q = agents.map(() => '?').join(',');
  db.run(`DELETE FROM nudge WHERE agent IN (${q})`, agents);
}

/** 未読が 0 から増えた者に、続き始めの時刻を刻む。 */
export function markSince(db: Database, agent: string, now: Date): void {
  db.prepare(
    `INSERT INTO nudge(agent, since) VALUES (?,?)
     ON CONFLICT(agent) DO UPDATE SET since = COALESCE(nudge.since, excluded.since)`,
  ).run(agent, now.toISOString());
}

/**
 * 実際に打ち込む。
 *
 * 文字と Enter を分けて、間を 0.3 秒あける（現行 CLAUDE.md の作法）。
 * 一度に送ると、受け取る側が読み終える前に確定してしまう CLI がある。
 *
 * ペインの番号ではなく `%4` のような識別子へ撃つ。番号は組み替えで動く。
 */
export async function send(p: Plan): Promise<{ ok: boolean; err?: string }> {
  if (!p.pane) return { ok: false, err: 'ペインが無い' };
  const target = p.pane.id;

  const run = (args: string[]): boolean => Bun.spawnSync(['tmux', ...args]).success;

  if (p.hardRecovery) {
    // 立て直し。入力待ちでない状態から引き戻す。
    if (!run(['send-keys', '-t', target, 'Escape'])) return { ok: false, err: 'Escape を送れぬ' };
    if (!run(['send-keys', '-t', target, 'Escape'])) return { ok: false, err: 'Escape を送れぬ' };
    if (!run(['send-keys', '-t', target, 'C-c'])) return { ok: false, err: 'Ctrl-C を送れぬ' };
    await Bun.sleep(300);
  }

  if (!run(['send-keys', '-t', target, '-l', p.text])) return { ok: false, err: '本文を送れぬ' };
  await Bun.sleep(300);
  if (!run(['send-keys', '-t', target, 'Enter'])) return { ok: false, err: 'Enter を送れぬ' };
  return { ok: true };
}
