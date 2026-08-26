/**
 * 誰がどのペインに居るか。
 *
 * ## 名簿へ持たせない
 *
 * 出所は tmux の `@agent_id` である。設定ファイルへ書き写すと、
 * ペインを組み替えた時に静かに古くなる。古い対応で合図を撃つと、
 * **別人のペインへ打ち込む**。現行でも一度起きている
 * (multi-agent-shogun incident_watcher_pane_misroute_2026_06_19:
 *  settings.yaml の順ズレで pane+1 へ誤射)。
 *
 * `@agent_id` は出陣時に付けられ、以後変わらない。ペインの番号のほうが
 * 動くので、番号ではなく名で引く。現行の karo.md も同じ引き方をしている。
 *
 * ## 一度に全部引く
 *
 * 1 体ずつ `tmux display-message` を呼ぶと、頭数ぶんプロセスが起きる。
 * 常駐しない側とはいえ、7 体なら 7 回になる。一覧は 1 回で足りる。
 */

export interface Pane {
  /** `%4` のような不変の識別子。番号より安全に撃てる。 */
  id: string;
  /** `multiagent:agents.1` のような人が読む形。報告に出す。 */
  label: string;
}

/**
 * 布陣にいま居る者と、そのペイン。
 *
 * tmux が居なければ空を返す。**投げない**——布陣の外から
 * `honden inbox unread` を叩く筋があり、そこで倒れては使えない。
 */
export function panes(session?: string): Map<string, Pane> {
  const out = new Map<string, Pane>();

  // どのセッションを見るか。
  //
  // 既定は全セッション（-a）だが、**同名の agent が二つのセッションに居ると
  // 危うい**。試験の布陣と本番の布陣の双方に karo が居る時、-a では後に
  // 列挙された方が勝ち、**試験の合図が本番の pane へ飛びうる**。
  //
  // 試験環境は必ず HONDEN_TMUX_SESSION で自分のセッションに絞ること
  // （scripts/testenv.sh が設定する）。env で渡すのは、これが「どの世界を
  // 見るか」の指定であって名乗りではないゆえ——芯を起動した env が
  // 手（nudge）へそのまま継がれ、芯と手が必ず同じ世界を見る。
  const scope = session ?? process.env.HONDEN_TMUX_SESSION?.trim() ?? '';
  const args =
    scope !== ''
      ? ['list-panes', '-s', '-t', scope]
      : ['list-panes', '-a'];

  let p;
  try {
    p = Bun.spawnSync([
      'tmux',
      ...args,
      '-F',
      '#{pane_id}\t#{session_name}:#{window_name}.#{pane_index}\t#{@agent_id}',
    ]);
  } catch {
    return out;
  }
  if (!p.success) return out;

  for (const line of new TextDecoder().decode(p.stdout).split('\n')) {
    const [id, label, agent] = line.split('\t');
    if (!id || !label || !agent || agent.trim() === '') continue;
    out.set(agent.trim(), { id, label });
  }
  return out;
}
