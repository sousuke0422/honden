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
/**
 * tmux を叩く手。**注ぎ口にしてある。**
 *
 * ここが差し替えられぬ限り、この箱は試験できぬ——そして試験できぬ箱に
 * 「将軍へ合図が届かぬ」穴が住んでおった（2026-08-29）。`identity.ts` が
 * `lookup` を注がせるのと同じ流儀にする。
 *
 * 返すのは stdout。引けなければ null（「引けなかった」と「空だった」は別物）。
 */
export type TmuxRunner = (args: string[]) => string | null;

const realTmux: TmuxRunner = (args) => {
  try {
    const p = Bun.spawnSync(['tmux', ...args]);
    return p.success ? new TextDecoder().decode(p.stdout) : null;
  } catch {
    return null;
  }
};

/**
 * 我らが立てた陣の名。
 *
 * 出陣が陣を立てた折に `@honden` へ置き場を書き込む（`scripts/shutsujin.sh`）。
 *
 * `HONDEN_ROOT` が立っておれば、**同じ置き場を指す印だけ**を我らのものと見る
 * ——一つの機で二つの honden を走らせる筋があり、他方の陣を掴んでは並走の
 * 意味が無い。立っておらねば、印の付いた陣をすべて我らのものと見る
 * （どの置き場のものか判ぜぬゆえ、絞りは陣の別までで止まる）。
 *
 * tmux が居らねば空。呼ぶ側は `-a` へ戻す。
 */
export function ownSessions(run: TmuxRunner = realTmux): string[] {
  const root = process.env.HONDEN_ROOT?.trim() ?? '';
  const text = run(['list-sessions', '-F', '#{session_name}\t#{@honden}']);
  if (text === null) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const [name, mark] = line.split('\t');
    if (!name || !mark || mark.trim() === '') continue;
    if (root !== '' && mark.trim() !== root) continue;
    out.push(name);
  }
  return out;
}

export function panes(session?: string, run: TmuxRunner = realTmux): Map<string, Pane> {
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
  // **複数の陣を見張れる。** 将軍は別の陣（`shogun`）に住むゆえ、
  // 働き手の陣だけに絞ると将軍へ合図が届かぬ——直訴（guard appeal）は
  // 将軍宛であり、永久に届かなんだ（実測 2026-08-29）。
  // 読点で区切れば複数を見る。絞りの効き目（試験の合図が本番へ飛ばぬ）は保つ。
  const scope = session ?? process.env.HONDEN_TMUX_SESSION?.trim() ?? '';
  const scopes = scope.split(',').map((x) => x.trim()).filter((x) => x !== '');
  // **絞りが無いとき、印（`@honden`）の付いた陣だけを見る。**
  //
  // 並走（旧環境と honden を同時に動かす）では、`-a` は他人の陣まで拾う。
  // 実地で八つの陣が並び、`shogun` の名が三つの陣に重複していた
  // （2026-09-01）。後勝ちなので、将軍宛の合図が古い試験の陣へ落ちる。
  //
  // 印は出陣（`scripts/shutsujin.sh`）が陣を立てた折に付ける。外側の shell は
  // 既にこの印で芯・耳・窓を接ぐか決めている。**芯だけが見ていなかった。**
  //
  // 印がどこにも無ければ `-a` へ戻す。印は honden が立てた陣にしか付かず、
  // 手で立てた陣で使っている者を締め出さぬため——ただしその時は絞れていない。
  const argsets =
    scopes.length > 0
      ? scopes.map((t) => ['list-panes', '-s', '-t', t])
      : ownSessions(run).map((t) => ['list-panes', '-s', '-t', t]);
  if (argsets.length === 0) argsets.push(['list-panes', '-a']);

  for (const args of argsets) {
    const text = run([...args, '-F', '#{pane_id}\t#{session_name}:#{window_name}.#{pane_index}\t#{@agent_id}']);
    if (text === null) continue; // その陣が引けずとも、他の陣は見る

    for (const line of text.split('\n')) {
      const [id, label, agent] = line.split('\t');
      if (!id || !label || !agent || agent.trim() === '') continue;
      out.set(agent.trim(), { id, label });
    }
  }
  return out;
}
