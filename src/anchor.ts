/**
 * 偽れぬ名乗り — 親子の系譜から自分の pane を割り出す。
 *
 * ## なぜ要るか
 *
 * `TMUX_PANE` は環境変数であり、**子は自分の環境を自由にできる**。
 * ゆえに二つの騙りが通っておった（敵対レビュー 2026-08-29・実証済み）:
 *
 *   TMUX_PANE= honden-bot ...          → 「布陣の外」を騙る
 *   TMUX_PANE=%0 honden-bot ...        → 家老の pane を騙る
 *
 * src/identity.ts は「引けなかった時に env へ落ちる」筋を既に塞いでいたが、
 * **TMUX_PANE そのものが偽物**という筋が残っていた。名乗りの根が env に
 * ある限り、この種は尽きぬ。
 *
 * ## 何を根にするか
 *
 * 系譜（親子）である。tmux は各 pane の初発のプロセス（pane_pid）を知る。
 * 我が身から親を辿り、そのいずれかが pane_pid に当たれば、その pane が我が家。
 * **系譜は kernel の持ち物で、環境変数では書き換えられぬ。**
 *
 * 逃げ道は二重フォークで系譜を切ることだが、それは init へ里子に出す所作で
 * あって「うっかり」では起こらぬ。そして切れた者は錨を失う——**錨無しを
 * 拒む側（bot）では、逃げても得るものが無い**。
 *
 * ## 限界（正直に）
 *
 * 全エージェントが同じ OS ユーザで走る限り、これは**堀であって城壁ではない**。
 * app.pem は同じユーザが読めるゆえ、その気になれば錠前ごと迂回して自ら
 * JWT を鋳られる。真の境は uid 分離か仲介デーモンを要する。
 * ここが止めるのは「注入された足軽が honden-bot を呼ぶ」筋である。
 */

export interface PaneRow {
  pid: number;
  pane: string;
  agentId: string;
}

export interface Anchor {
  pane: string;
  agentId?: string;
}

export interface AncestryProbe {
  /** 我が身から親へ辿った pid の列（自身を含む・上から順）。 */
  chain: () => number[];
  /** tmux が知る pane の一覧。 */
  panes: () => PaneRow[];
}

/**
 * 系譜と pane 一覧を突き合わせ、我が pane を割り出す。
 * 見つからねば null——**布陣の外か、系譜を切った者**。どちらかは判じられぬ。
 */
export function anchorFrom(p: AncestryProbe): Anchor | null {
  const rows = p.panes();
  if (rows.length === 0) return null;
  const byPid = new Map<number, PaneRow>();
  for (const r of rows) byPid.set(r.pid, r);
  for (const pid of p.chain()) {
    const hit = byPid.get(pid);
    if (hit) return { pane: hit.pane, agentId: hit.agentId.trim() || undefined };
  }
  return null;
}

/**
 * /proc/<pid>/stat から親を読む。
 * comm は括弧で囲まれ**空白も括弧も含みうる**ゆえ、右括弧から数える
 * （素朴に split すると `(bash foo)` のような名で桁がずれる）。
 */
export function parentOf(pid: number, read: (path: string) => string): number | null {
  let text: string;
  try {
    text = read(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** 系譜を辿る。輪や深すぎる木で止まらぬよう上限を置く。 */
export function chainFrom(pid: number, read: (path: string) => string, max = 24): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur: number | null = pid;
  while (cur !== null && cur > 1 && out.length < max && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf(cur, read);
  }
  return out;
}

/** `tmux list-panes -a` の出力を読む。形は `<pid> <pane> <agent_id>`。 */
export function parsePanes(text: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const parts = t.split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || parts.length < 2) continue;
    rows.push({ pid, pane: parts[1]!, agentId: parts[2] ?? '' });
  }
  return rows;
}

/** 実物の探り。tmux が居らねば空を返す（＝錨無し）。 */
export function realProbe(): AncestryProbe {
  return {
    chain: () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      return chainFrom(process.pid, (p) => readFileSync(p, 'utf-8'));
    },
    panes: () => {
      const p = Bun.spawnSync(['tmux', 'list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{@agent_id}']);
      if (!p.success) return [];
      return parsePanes(new TextDecoder().decode(p.stdout));
    },
  };
}
