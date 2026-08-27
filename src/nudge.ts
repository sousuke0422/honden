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
 * ## 将軍へ撃つかは、殿が在席かで決まる
 *
 * 撃たぬのは将軍が特別だからではなく、**殿がいま打ち込んでおる最中を潰す**ゆえ。
 * 殿が席を外しておられる間——夜間や仕事中——は潰す入力が無く、
 * **将軍を起こすのが前提になる**。起こさねば家老からの escalation が
 * 誰にも届かず、パイプラインが朝まで止まる
 * (memory: shogun_night_autonomous_escalation)。
 *
 * 判断は運用の様態 (src/mode.ts) で決まる。旗にすると「例外的に起こす」と
 * 読めるが、自律運用では起こすのが常道であって例外ではない。
 *
 * ## 一回きりの明示は、様態とは別に要る
 *
 * 「いまこの件だけ将軍を起こせ」と明示の指示が出ることがある。
 * これを様態の切り替えで代用すると、**戻し忘れが常態化する**——
 * 一件のために自律へ移し、そのまま殿が席へ戻られる。
 *
 * ゆえに `--wake-shogun` を別に置く。効くのはその一回だけで、
 * 正本には何も残さない（様態は動かない）。台帳には別の名で残す。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { summarize, nudgeText, type Summary } from './inbox';
import { roster } from './roster';
import { panes, type Pane } from './pane';
import { isAutonomous } from './mode';

/** 殿が在席の間は撃たぬ相手。殿の入力と同じ場所に居るゆえ。 */
export const ATTENDED_SILENT = 'shogun';
/** 旧名。呼び出し側の移行が済むまで残す。 */
export const NEVER_NUDGE = ATTENDED_SILENT;

export const LEVEL_2_AFTER_MS = 2 * 60_000;
export const LEVEL_3_AFTER_MS = 4 * 60_000;
/** 同じ段を撃ち直すまでの間。うるさくせぬため。 */
export const REPEAT_MS = 60_000;
/** 文脈を消させるのは 5 分に一度まで。 */
export const RESET_COOLDOWN_MS = 5 * 60_000;

/** 立て直しに Escape×2 と Ctrl-C を要する CLI。現行 CLAUDE.md より。 */
const NEEDS_HARD_RECOVERY = new Set(['copilot', 'kimi']);
/**
 * 急ぎの合図の後に添え押しする「follow-up 確認キー」。
 * codex は作業中に届いた入力をこのキーで確かめられる（Tab は仮置き・
 * codex を布陣へ座らせた時に実測で校正する）。claude は押さずとも
 * 切りのいい所で読む。cursor に該当キーは無い——完了まで読まぬゆえ、
 * 急報は honden コマンド出力への横乗せ（src/main.ts ridealong）が拾う。
 */
export const FOLLOWUP_KEY: Record<string, string> = {
  codex: 'Tab',
};
/**
 * 文脈を消す命令。CLI ごとに違う。
 * cursor に /clear は無い——/new-chat を使う（旧 watcher L718 実証済み）。
 * codex は /clear で CLI ごと終了するため、未知の CLI への既定も /new に倒す
 * （旧 watcher の codex-safe fallback と同じ）。
 */
const RESET_COMMAND: Record<string, string> = {
  claude: '/clear',
  copilot: '/clear',
  kimi: '/clear',
  codex: '/new',
  opencode: '/new',
  cursor: '/new-chat',
};

export type Level = 1 | 2 | 3;

export interface Plan {
  agent: string;
  pane?: Pane;
  cli: string | null;
  unread: number;
  /** 急ぎ（URGENT_TYPES）の未読を含むか。follow-up 確認キーの添え押しに使う。 */
  urgent: boolean;
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
  /**
   * 経ちから出した段。撃つ段 (`level`) とは別に持つ。
   *
   * 文脈消しが冷ましで塞がれると `level` は 2 へ落ちるが、
   * **落ちた段を覚えると次の回に「段が上がった」と判ぜられ、
   * 撃ち直しの間を素通りして連射になる**（外部レビューで再現・2026-08-26）。
   * 覚えるのは「escalation のどこまで来たか」であって「何を撃ったか」ではない。
   */
  escalationLevel: Level;
  /**
   * 様態ではなく一回きりの明示で撃つのか。
   *
   * 台帳へ別の名で残すために持つ。後から「なぜ殿の在席中に
   * 将軍が起こされたか」を辿れるようにする。
   */
  byExplicitWake?: boolean;
}

interface State {
  since: string | null;
  last_at: string | null;
  last_level: number | null;
  last_reset_at: string | null;
}

export function stateOf(db: Database, agent: string): State {
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
  opts: {
    autonomous?: boolean;
    wakeShogun?: boolean;
    panes?: Map<string, Pane>;
    /** 手が塞がっておる者。段 3（文脈消し）を素の合図へ降ろして延期する。 */
    busy?: Set<string>;
  } = {},
): Plan[] {
  const p = opts.panes ?? panes();
  // 様態は正本から引く。opts.autonomous は試験のための差し替え。
  const autonomous = opts.autonomous ?? isAutonomous(db, now);
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

    if (entry.id === ATTENDED_SILENT && !autonomous && !opts.wakeShogun) {
      send = false;
      reason =
        '殿が在席ゆえ撃たぬ。打ち込んでおる最中を潰す。' +
        '（この一件だけなら --wake-shogun、席を外されるなら honden mode autonomous --until 08:00）';
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
        out.push(mark(build(entry.id, entry.cli, pane, s, 2, true, undefined, now, st, 3)));
        continue;
      }
      if (opts.busy?.has(entry.id)) {
        // 手が塞がっておる者に文脈消しは効かぬ。codex は仕事中の /new を
        // 拒む（殿実測 2026-08-27）。旧 watcher と同じく次の周へ延期し、
        // その間は素の合図で叩き続ける。reset の刻印を残さぬゆえ、
        // 手すきになった最初の周で文脈消しが届く。
        out.push(
          mark(build(entry.id, entry.cli, pane, s, 2, true, '手が塞がっておるゆえ文脈消しを延期', now, st, 3)),
        );
        continue;
      }
    }

    out.push(mark(build(entry.id, entry.cli, pane, s, level, send, reason, now, st, level)));
  }

  return out;

  /** 一回きりの明示で撃った将軍の分に印をつける。 */
  function mark(pl: Plan): Plan {
    if (pl.agent === ATTENDED_SILENT && pl.send && !autonomous && opts.wakeShogun) {
      pl.byExplicitWake = true;
    }
    return pl;
  }
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
  escalationLevel: Level,
): Plan {
  const text = level === 3 ? RESET_COMMAND[cli ?? ''] ?? '/new' : nudgeText(s);
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

  return { agent, pane, cli, unread: s.total, urgent: s.urgent, level, escalationLevel, send, reason, text, hardRecovery, nextInMs };
}

/** 撃った跡を残す。 */
export function record(db: Database, p: Plan, now: Date, reason?: string, by?: string): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO nudge(agent, since, last_at, last_level, last_reset_at)
     VALUES (?, COALESCE((SELECT since FROM nudge WHERE agent = ?), ?), ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       since = COALESCE(nudge.since, excluded.since),
       last_at = excluded.last_at,
       last_level = excluded.last_level,
       last_reset_at = COALESCE(excluded.last_reset_at, nudge.last_reset_at)`,
  ).run(p.agent, p.agent, at, at, p.escalationLevel, p.level === 3 ? at : null);

  journal(db, {
    // 誰が起こしたかを残す。'nudge' 固定では、明示で起こした跡が辿れぬ。
    actor: p.byExplicitWake ? (by ?? '名乗り無し') : 'nudge',
    action: p.byExplicitWake ? 'nudge.wake_shogun' : p.level === 3 ? 'nudge.reset' : `nudge.L${p.level}`,
    target: p.agent,
    detail:
      `unread=${p.unread} pane=${p.pane?.label ?? 'なし'} ${JSON.stringify(p.text)}` +
      (p.byExplicitWake && reason ? ` reason=${JSON.stringify(reason)}` : ''),
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

/**
 * 未読が 0 から増えた者に、続き始めの時刻を刻む。
 *
 * ## 山が入れ替わったら、時計を戻す
 *
 * COALESCE で古い since を無条件に残すと、**前の山（ack で片付いた未読）の
 * 時計が次の山へ持ち越される**。片付いてから次の未読が来るまでの間に
 * 手が一度も呼ばれぬと forget が走らず、次の手でいきなり段 3——
 * 試験環境の受け手へ /clear が飛んだ（2026-08-27 実測、smoke が釣った）。
 *
 * since より新しい未読しか残っておらぬなら、前の山は片付いておる。
 * その時は since を今へ戻す。段が数えるのは「いまの山に撃ち始めてから
 * 返事が無い時間」であって、昔の山の古さではない。
 */
export function markSince(db: Database, agent: string, now: Date): void {
  const cur = db.query('SELECT since FROM nudge WHERE agent = ?').get(agent) as { since: string | null } | null;
  if (cur?.since) {
    const oldest = db
      .query('SELECT MIN(created_at) t FROM inbox WHERE agent = ? AND read = 0')
      .get(agent) as { t: string | null };
    if (oldest.t && oldest.t > cur.since) {
      // いま在る未読はどれも since より新しい ＝ 前の山は片付いた。時計を戻す。
      db.prepare('UPDATE nudge SET since = ?, last_level = NULL WHERE agent = ?').run(now.toISOString(), agent);
      return;
    }
  }
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

  // 急ぎなら、CLI が作業中でも合図に気づける確認キーを添え押しする。
  // 段 3 は文脈消しゆえ添えぬ。
  if (p.urgent && p.level !== 3) {
    const key = FOLLOWUP_KEY[p.cli ?? ''];
    if (key) {
      await Bun.sleep(300);
      run(['send-keys', '-t', target, key]); // 押せずとも合図自体は届いておる
    }
  }
  return { ok: true };
}


/**
 * 未読が続いておる者の時計を進め、片付いた者の覚えを消す。
 *
 * **撃たぬ相手には時計を刻まない。** 在席の間は将軍へ撃たぬが、時計だけ
 * 回しておくと、殿が席を外して様態を切り替えた最初の一発が段 3（文脈消し）に
 * なる。夜間運用の開始と同時に将軍の文脈が焼ける（外部レビューで再現・2026-08-26）。
 *
 * 段が数えておるのは「撃ち始めてから返事が無い時間」であって、
 * 「未読が置かれてからの時間」ではない。
 */
export function startClocks(
  db: Database,
  now: Date,
  opts: { autonomous?: boolean; wakeShogun?: boolean } = {},
): { live: string[]; quiet: string[] } {
  const autonomous = opts.autonomous ?? isAutonomous(db, now);
  const silent = autonomous || opts.wakeShogun ? new Set<string>() : new Set([ATTENDED_SILENT]);
  const live: string[] = [];
  const quiet: string[] = [];
  for (const e of roster(db)) {
    if (summarize(db, e.id).total > 0) {
      if (!silent.has(e.id)) markSince(db, e.id, now);
      live.push(e.id);
    } else {
      quiet.push(e.id);
    }
  }
  // 片付いた者の覚えは消す。残すと次の未読がいきなり段 3 から始まる。
  forget(db, quiet);
  return { live, quiet };
}
