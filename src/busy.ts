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
