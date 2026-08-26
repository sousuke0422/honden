/**
 * 誰であるかを決める。
 *
 * ## 出所は pane である。環境変数ではない
 *
 * 現行 (`scripts/session_start_hook.sh`) は `@agent_id` だけを見て、
 * 取れなければ「布陣の外」として何もしない。環境変数の名乗りは持たない。
 *
 * honden が `HONDEN_AGENT_ID` を足したのは、布陣の外から叩く筋
 * （試験・素振り・外部セッション）で誰かを名乗る要があったため。
 * だが**環境変数を pane より先に見ておった**——布陣の中でも、
 * env 一つで他人を名乗れた。名乗りが検めにならぬ。
 *
 * ## 食い違いは黙って解かない
 *
 * pane が言う名と env が言う名が違うなら、**どちらかが誤っている**。
 * 片方を静かに採ると、誤りが誤りのまま通る。断って人に見せる。
 *
 * ## TMUX_PANE が空のとき display-message を打たない
 *
 * 空のまま打つと、tmux は**アクティブな pane の @agent_id** を返す。
 * 2026-07-06 に実際に起きている——将軍が別陣営の pane を自分と誤認し、
 * その tty へ書き込んだ (memory: pane_identity_verification)。
 */

export type Source = 'pane' | 'env' | 'none';

export interface Identity {
  id?: string;
  source: Source;
  /** 布陣の中に居るか。TMUX_PANE があるかで決まる。 */
  insideFormation: boolean;
  /** 食い違いがあれば、その旨。 */
  conflict?: string;
}

export interface Env {
  tmuxPane?: string;
  agentIdEnv?: string;
  /** pane から @agent_id を引く。空文字なら未設定。 */
  lookup: (pane: string) => string;
}

export function resolve(env: Env): Identity {
  const pane = (env.tmuxPane ?? '').trim();
  const fromEnv = env.agentIdEnv?.trim() || undefined;
  const insideFormation = pane !== '';

  if (!insideFormation) {
    // 布陣の外。pane は引かない——空のまま引くと他人を名乗る。
    return { id: fromEnv, source: fromEnv ? 'env' : 'none', insideFormation: false };
  }

  const fromPane = env.lookup(pane).trim() || undefined;

  if (fromPane && fromEnv && fromPane !== fromEnv) {
    return {
      id: fromPane,
      source: 'pane',
      insideFormation: true,
      conflict:
        `pane は ${fromPane} と言い、HONDEN_AGENT_ID は ${fromEnv} と言うておる。\n` +
        '  どちらかが誤っておる。pane を採るが、まず食い違いを正されよ。\n' +
        '  布陣の中では pane が正である。環境変数は布陣の外から名乗るためのもの。',
    };
  }

  if (fromPane) return { id: fromPane, source: 'pane', insideFormation: true };

  // pane に @agent_id が付いておらぬ。布陣の中の pane だが持ち場ではない
  // （個人の Claude Code など）。現行はここで黙って何もしない。
  return { id: fromEnv, source: fromEnv ? 'env' : 'none', insideFormation: true };
}
