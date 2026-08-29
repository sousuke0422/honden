/**
 * 布陣の様子を一枚に並べる。
 *
 * 旧 scripts/agent_status.sh（258 行・bash + python + yaml）の移植。
 * だが honden では**書き直すほどのものが無い**——並べる値はすべて
 * 正本と busy の見立てに既に在る:
 *
 *   顔ぶれ・CLI・模型   roster 表
 *   pane の在り処        tmux（src/pane.ts）
 *   手が塞がっておるか   pane を写して見立てる（src/busy.ts）
 *   任と其の様           task 表
 *   持ち場の貸与         lease（期限切れの印つき）
 *   未読と急ぎ           inbox 表
 *
 * 旧は task YAML と inbox YAML を python で開いて読んでいた。
 * 正本を一つに寄せた今、開く先も一つである。
 */
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { roster } from './roster';
import { summarize } from './inbox';
import { panes, type Pane } from './pane';
import { captureBusy } from './busy';
import { leaseState } from './lease';

export interface Row {
  agent: string;
  role: string;
  cli: string | null;
  model: string | null;
  pane: string | null;
  busy: boolean | null;
  taskId: string | null;
  taskStatus: string;
  lease: 'held' | 'expired' | 'free';
  unread: number;
  urgent: boolean;
}

export function collect(
  db: Database,
  opts: { panes?: Map<string, Pane>; busy?: (p: Pane, cli: string | null) => boolean; now?: Date } = {},
): Row[] {
  const p = opts.panes ?? panes();
  const isBusy = opts.busy ?? captureBusy;
  const now = opts.now ?? new Date();

  return roster(db).map((e) => {
    const pane = p.get(e.id);
    const t = db
      .query('SELECT task_id, status, holder, lease_until FROM task WHERE agent = ?')
      .get(e.id) as { task_id: string | null; status: string; holder: string | null; lease_until: string | null } | null;
    const s = summarize(db, e.id);
    return {
      agent: e.id,
      role: e.role,
      cli: e.cli,
      model: e.model,
      pane: pane?.label ?? null,
      // pane が無ければ見立てようが無い。false（手すき）と言い切らぬ——
      // 「居らぬ」と「手すき」は別物である。
      busy: pane ? isBusy(pane, e.cli) : null,
      taskId: t?.task_id ?? null,
      taskStatus: t?.status ?? 'idle',
      lease: t ? leaseState({ holder: t.holder, leaseUntil: t.lease_until }, now) : 'free',
      unread: s.total,
      urgent: s.urgent,
    };
  });
}

export function render(rows: Row[]): string {
  // 全角を 2 と数える。揃わぬ表は読む気を削ぐ。
  const width = (s: string) =>
    [...s].reduce((a, ch) => a + (/[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1), 0);
  /** n 桁へ収める。**溢れたら削る**——溢れさせると以降の桁が全て崩れる。 */
  const pad = (s: string, n: number) => {
    let t = s;
    if (width(t) > n - 1) {
      const chars = [...t];
      let w = 0;
      const kept: string[] = [];
      for (const ch of chars) {
        const cw = /[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1;
        if (w + cw > n - 2) break;
        kept.push(ch);
        w += cw;
      }
      t = kept.join('') + '…';
    }
    return t + ' '.repeat(Math.max(0, n - width(t)));
  };
  const head =
    '  ' + pad('名', 11) + pad('役', 8) + pad('CLI', 9) + pad('様', 8) + pad('任', 26) + pad('持ち場', 10) + '未読';
  const line = '  ' + '─'.repeat(76);
  const body = rows.map((r) => {
    const state = r.pane === null ? '不在' : r.busy ? '働中' : '待機';
    const lease = r.lease === 'expired' ? '★期限切' : r.lease === 'held' ? '握中' : '空き';
    const unread = r.unread === 0 ? '—' : `${r.unread}${r.urgent ? ' ⚠急' : ''}`;
    return (
      '  ' +
      pad(r.agent, 11) +
      pad(r.role === 'commander' ? '差配' : '働き', 8) +
      pad(r.cli ?? '—', 9) +
      pad(state, 8) +
      pad(r.taskId ? `${r.taskId} ${r.taskStatus}` : r.taskStatus, 26) +
      pad(lease, 10) +
      unread
    );
  });
  return [head, line, ...body].join('\n');
}

/** 芯の生死。 */
export interface CoreCheck {
  /** 己の正本を見張る芯が生きておるか。 */
  alive: boolean;
  /** 己の正本以外を見張る芯（孤児の疑い）。 */
  strays: { pid: string; path: string }[];
}

/**
 * 芯（honden-watch）の様子を見る。
 *
 * 生死は**錠への相乗り**で判ずる。芯は起動時に flock で錠を握る——
 * 取れれば誰も握っておらぬ（死）、取れねば握っておる（生）。
 * ps の command line を grep する手は採らぬ——己の command line に当たる
 * 前科が二度ある（旧 watcher の自己検知・出陣の儀の芯検知）。
 *
 * 孤児: 陣を畳んでも芯は死なぬことがある（実測 2026-08-28: kill-session の
 * 後も親が tmux サーバのまま生きておった）。**別の正本を見張る芯**を列挙し、
 * 報せる。畳むのは人の手である——将軍は kill を打てぬ（D006）。
 */
/**
 * 芯まわりの道を**一箇所で**決める。
 *
 * 出陣（scripts/shutsujin.sh）と試験環境（scripts/testenv.sh）が各々で
 * 組み立てており、名が食い違っておった——出陣は `<正本>.watch.lock`、
 * 検めは `<親>/watch.lock`。**別の file ゆえ、出陣で立てた陣では
 * `honden status` が常に「芯は死んでおる」と出ておった**（実測 2026-08-29）。
 *
 * 道を二箇所で組めば、いつか必ずずれる。ここを正とし、shell からは
 * `honden paths` で引かせる。
 */
export function corePaths(dbPath: string): { db: string; signal: string; lock: string } {
  // 錠は**正本と同じ場所に一つ**。名から導くと、正本が `h.db` の時に
  // `h.dbwatch.lock` という奇形が出る（試験が暴いた）。場所で決める。
  return {
    db: dbPath,
    signal: `${dbPath}.signal`,
    lock: join(dirname(dbPath), 'watch.lock'),
  };
}

export function coreCheck(dbPath: string): CoreCheck {
  const lock = corePaths(dbPath).lock;
  const tryLock = Bun.spawnSync(['flock', '-n', lock, 'true']);
  // flock が取れた（exit 0）なら誰も握っておらぬ = 死んでおる。
  // 錠のファイルが無い場合も flock は作って取る → 死と判ずる（正しい）。
  const alive = !tryLock.success;

  const strays: { pid: string; path: string }[] = [];
  const ps = Bun.spawnSync(['ps', '-eo', 'pid,args']);
  if (ps.success) {
    for (const line of ps.stdout.toString().split('\n')) {
      const m = line.match(/^\s*(\d+)\s+.*honden-watch\s+--path\s+(\S+)/);
      if (!m) continue;
      const watched = m[2]!;
      if (!watched.startsWith(dbPath)) strays.push({ pid: m[1]!, path: watched });
    }
  }
  return { alive, strays };
}
