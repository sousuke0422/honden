/**
 * 手が塞がっておるか — pane の画面から CLI の busy を見立てる。
 *
 * 旧 lib/agent_status.sh の agent_is_busy_check の移植。判定の順序まで
 * 旧のまま保つ。順序に歴史がある:
 *
 * - Claude Code は考えておる最中も ❯ を出すゆえ、idle 判定だけだと
 *   false-idle になる（旧 is_busy を壊した虫）。
 * - 古い spinner の文は scroll-back に残るゆえ、5 行全部で 'esc to' を
 *   探すと false-busy になる（旧 T-BUSY-008）。**最終行だけ**を見る。
 *
 * これが要る訳: codex は仕事中に /new を打たれると拒む（殿実測 2026-08-27）。
 * 文脈消しは手すきの相手にしか効かぬゆえ、busy なら次の周へ延期する。
 * 旧 watcher の busy guard（「/clear deferred to next cycle」）と同じ倒し方。
 *
 * 画面の文字列に頼る検知は脆い——それは承知の上で持ち込む。旧環境で
 * 実戦を経た紋様であり、誤りの向きも安全側（false-busy = 延期）に倒れる。
 *
 * CLI サポート階層（殿裁定 2026-08-27・docs/decisions.md 十）:
 *   T1 実測済み = claude / cursor / codex。T2 = opencode（移植・未実測）。
 *   T3 = copilot / kimi（純 port・この環境では使えぬ。使う時は再校正）。
 */
import type { Database } from 'bun:sqlite';
import type { Pane } from './pane';

const SPINNER =
  /(Working|Thinking|Planning|Sending|task is in progress|Compacting conversation|thought for|思考中|考え中|計画中|送信中|処理中|実行中)/i;

/** 画面の文字列だけで見立てる純関数。試験はこちらを叩く。 */
export function isBusyText(capture: string, cli: string | null): boolean {
  const lines = capture.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-5);
  const tailText = tail.join('\n');

  if (cli === 'opencode') {
    const visible = lines.filter((l) => l.trim() !== '');
    if (visible.length === 0) return false; // 描画前の空白は idle 扱い（旧の作法）
    if (/[■⬝]{8}/.test(visible.join('\n'))) return true; // busy の帯
    const last = visible[visible.length - 1]!;
    return /(^|\s)esc(\s+to)?\s+interrupt(\s|$)/i.test(last);
  }

  if (cli === 'cursor') {
    // cursor は処理中だけ 'ctrl+c to stop' を出す
    return /ctrl\+c to stop/i.test(tailText);
  }

  // ── 既定（claude ほか） ──
  const visible = tail.filter((l) => l.trim() !== '');
  if (visible.length === 0) return false;

  // 状態帯（最終行）の 'esc to' が最も確か。処理中しか出ぬ。
  const last = visible[visible.length - 1]!;
  if (/esc to/i.test(last)) return true;

  // idle の印
  if (/(\? for shortcuts|context left)/.test(tailText)) return false; // codex の待ち画面
  if (/^(❯|›)\s*$/m.test(tailText)) return false; // 素のプロンプト

  // spinner の言葉（末尾 5 行）
  if (/background terminal running/i.test(tailText)) return true;
  if (SPINNER.test(tailText)) return true;

  return false;
}

/** 実際に pane を写して見立てる。tmux が要る側。 */
export function captureBusy(pane: Pane, cli: string | null): boolean {
  const r = Bun.spawnSync(['tmux', 'capture-pane', '-t', pane.id, '-p']);
  if (!r.success) return false; // 写せぬなら idle 扱い — 撃てぬ理由は send が別途返す
  return isBusyText(r.stdout.toString(), cli);
}

/**
 * 使用枠が尽きておるか — pane の画面から見立てる。
 *
 * 5h 枠の枯渇で CLI が止まると、段梯子が /clear まで上がって
 * **仕掛かりを焼いた上で空の prompt で固まる**（殿の実戦報せ・2026-09-05）。
 * 枠切れの相手には何を撃っても無駄で、clear だけが実害を残す。
 *
 * busy と同じく画面の文字列に頼る。誤りの向きは安全側——
 * 誤検知は合図が数分遅れるだけ、見逃しは従前どおりの梯子。
 * 尻の数行だけを見る（scroll-back の古い文で false を作らぬ・busy と同じ作法）。
 */
// 実物の旗（殿採取・2026-09-05）: You've hit your session limit · resets 6:20pm (Asia/Tokyo)
// —— 初版の紋様は「session limit」も「resets 6:20pm」（at 無し）も取りこぼした。
// 実文をそのまま試験に釘打ちしてある（test/busy.test.ts）。
const LIMITED =
  /(hit your \w+ limit|(usage|session) limit|limit reached|5-?h(our)? limit|rate limit(ed)?|resets?( at)? \d{1,2}(:\d{2})?\s*(am|pm)?|try again (at|in)|out of (free )?(usage|credits)|quota (exceeded|reached)|上限に達し|利用制限)/i;

// 枠が**有る**ことの案内。字面が枠切れの旗と紛らわしい（殿採取・2026-09-10・claude）:
//   You have 3 usage limit resets available. Run /usage to use one.
// 「usage limit」だけを見て立てると、余裕を告げる文を枯渇と読む。旗より先に当てる。
const NOT_LIMITED = /resets?\s+available/i;

/** 尻の数行だけを見る（scroll-back の古い文で false を作らぬ・busy と同じ作法）。 */
function tailOf(capture: string, n = 8): string {
  return capture
    .replace(/\s+$/, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n');
}

/**
 * 枠切れか否かは**刻で決まる**。案内された刻が過ぎておれば枠は既に戻っておる。
 *
 * 判定は `limitedWaitMs` の一本に集める——「切れておるか」と「いつ明けるか」を
 * 別々に判ずると、字面では切れておるのに待ちが無い、という食い違いが生まれる。
 */
export function isLimitedText(capture: string, now: Date = new Date()): boolean {
  return limitedWaitMs(capture, now) !== null;
}

/** 実際に pane を写して見立てる。写せぬなら「切れておらぬ」扱い（撃つ側の判断へ譲る）。 */
export function captureLimited(pane: Pane, now: Date = new Date()): boolean {
  const r = Bun.spawnSync(['tmux', 'capture-pane', '-t', pane.id, '-p']);
  if (!r.success) return false;
  return isLimitedText(r.stdout.toString(), now);
}

/**
 * 働いておる印 — 画面ではなく正本（台帳と lease）から見立てる。
 *
 * 画面の見立て（isBusyText）は CLI の描き方に依る。cursor は 'ctrl+c to stop' を
 * 出さぬ形で長い命（coder ssh …）を回すことがあり、その間は idle と見えて
 * 段 3 の文脈消しが刺さる。ashigaru6 は cmd_15 で配られてから 19 分の間に
 * claim と guard.deny を台帳へ刻みながら三度 /new-chat を撃たれ、仕掛かりを
 * 失った（台帳実測・2026-09-06 01:03〜01:22 JST）。
 *
 * 台帳に己の名で刻めるのは生きて動いておる者だけである。直近に刻みがあるか、
 * 生きた lease を握っておるなら「手が塞がっておる」と見て文脈消しを延期する。
 * 死んでおる者は刻まぬし、lease も切れるゆえ、いずれ梯子は届く。
 * 誤りの向きは busy と同じく安全側（延期）に倒れる。
 */
export const WORKING_WINDOW_MS = 10 * 60_000;

export function isWorking(db: Database, agent: string, now: Date = new Date()): string | null {
  const sinceIso = new Date(now.getTime() - WORKING_WINDOW_MS).toISOString();
  const row = db
    .query('SELECT action, at FROM ledger WHERE actor = ? AND at > ? ORDER BY at DESC LIMIT 1')
    .get(agent, sinceIso) as { action: string; at: string } | null;
  if (row) {
    const ago = Math.round((now.getTime() - new Date(row.at).getTime()) / 60_000);
    return `台帳に ${ago} 分前の刻み（${row.action}）`;
  }
  const lease = db
    .query('SELECT lease_until FROM task WHERE agent = ? AND holder IS NOT NULL AND lease_until > ?')
    .get(agent, now.toISOString()) as { lease_until: string } | null;
  if (lease) return `lease を ${lease.lease_until} まで握っておる`;
  return null;
}

/**
 * 枠切れの旗から「明ける刻」を読む（殿の求め・2026-09-10）。
 *
 * 実物の旗は刻を刷る:
 *   claude: You've hit your session limit · resets 6:20pm (Asia/Tokyo)
 *   codex:  … or try again at 5:55 AM.
 *
 * **枠切れの印は復帰時刻の併記である**（殿の決め・2026-09-10）。旗の字面だけを
 * 見ると、枠が**有る**ことの案内（`… resets available`）まで枯渇と読む。刻を
 * 併記せぬ文面は、`usage limit` の字を含んでいても枠切れと見ぬ。
 *
 * 併記された刻が過ぎておれば枠は既に戻っておるゆえ、旗が画面に残っておっても
 * 枠切れと見ぬ。pane の写しは scroll-back を抱えるゆえ、明けた後も旗は居座る
 * ——字面だけで判ずると、一度枠を使い切った相手が延々と撃たれぬままになる。
 *
 * 刻が読めれば「その刻 + 2 分」までの待ちを返す。読めぬ形（刻の併記が無い・
 * 24 時を超える等）は枠切れと見ぬ——**撃たぬ側へ倒すのは安全ではない**。
 * 撃たねば相手は止まったまま気づかれず、段梯子も台帳の跡も進まぬ。
 * 刻は端末の locale の壁時計と看做す（旗の TZ 註記が母屋と食い違う CLI は
 * 今のところ無い）。待ちは 6 時間で頭打ち——読み違いで一昼夜黙る事故を作らぬ。
 */
const LIMITED_MARGIN_MS = 2 * 60_000;
const LIMITED_MAX_WAIT_MS = 6 * 60 * 60_000;
const RESET_TIME = /(?:resets?(?:\s+at)?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * 壁時計の刻を暦へ落とす。**今から最も近い解釈を採る。**
 *
 * 旗は日付を刷らぬゆえ、「5:55」が今日の朝か明朝かは前後関係でしか決まらぬ。
 * 深夜 23 時に「5:55 AM」と出れば明朝（6 時間後）であり、朝 7 時に同じ字面を
 * 見れば今朝（1 時間前・既に明けておる）である。どちらも「近い方」を採れば合う。
 * 境目はちょうど 12 時間で、そこでは過去の側を採る——半日前に明けると
 * 告げられた旗は、もう用を終えておる。
 */
function nearestClockTime(h: number, min: number, now: Date): Date {
  const today = new Date(now);
  today.setHours(h, min, 0, 0);
  // 暦日で動かす（±24h の足し算では夏時間で 1 時間ずれる）
  const prev = new Date(today);
  prev.setDate(prev.getDate() - 1);
  const next = new Date(today);
  next.setDate(next.getDate() + 1);
  let best = today;
  for (const c of [prev, next]) {
    if (Math.abs(c.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime())) best = c;
  }
  return best;
}

export function limitedWaitMs(capture: string, now: Date): number | null {
  const tail = tailOf(capture);
  if (NOT_LIMITED.test(tail)) return null; // 枠が有るという案内。枯渇ではない
  if (!LIMITED.test(tail)) return null;
  const m = RESET_TIME.exec(tail);
  if (!m) return null; // 刻の併記が無い——枠切れの印はこれである
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null; // 刻が読めぬ
  const t = nearestClockTime(h, min, now);
  if (t.getTime() <= now.getTime()) return null; // 刻は過ぎておる——枠は戻っておる
  const wait = t.getTime() - now.getTime() + LIMITED_MARGIN_MS;
  return Math.min(wait, LIMITED_MAX_WAIT_MS);
}

/** pane を写して待ちを見立てる。枠切れでなければ null。 */
export function captureLimitedWaitMs(pane: Pane, now: Date = new Date()): number | null {
  const r = Bun.spawnSync(['tmux', 'capture-pane', '-t', pane.id, '-p']);
  if (!r.success) return null;
  return limitedWaitMs(r.stdout.toString(), now);
}
