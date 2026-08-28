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
 * 片方を静かに採ると、誤りが誤りのまま通る。
 * **pane を採ったうえで、断りを出す**（拒みはせぬ。拒むと仕事が止まる）。
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
  /**
   * 名乗りが**系譜**から出ておるか（src/anchor.ts）。
   * true なら環境変数では偽れぬ。秘密を扱う口（honden-bot）はこれを要求する。
   */
  anchored?: boolean;
  /** 布陣の中に居るか。TMUX_PANE があるかで決まる。 */
  insideFormation: boolean;
  /** 食い違いがあれば、その旨。 */
  conflict?: string;
}

export interface Env {
  tmuxPane?: string;
  agentIdEnv?: string;
  /**
   * pane から @agent_id を引く。
   *
   *   文字列  引けた（空文字 = pane に @agent_id が付いておらぬ）
   *   null    **引けなかった**（tmux が答えぬ・pane が無い）
   *
   * この二つを分けねばならぬ。一緒くたにすると、引けなかった時に
   * 環境変数の名乗りへ落ち、**布陣の中で他人を騙れる**——
   * `TMUX_PANE=%9999 HONDEN_AGENT_ID=karo` で karo になれてしまう
   * （外部レビューで再現・2026-08-27）。
   */
  lookup: (pane: string) => string | null;
  /**
   * 系譜から我が pane を割り出す（src/anchor.ts）。**環境変数では偽れぬ。**
   * 渡さねば従前どおり TMUX_PANE を信じる（試験・非 Linux のため）。
   * null = 布陣の外か、系譜を切った者。
   */
  anchor?: () => { pane: string; agentId?: string } | null;
}

export function resolve(env: Env): Identity {
  const pane = (env.tmuxPane ?? '').trim();
  const fromEnv = env.agentIdEnv?.trim() || undefined;
  const insideFormation = pane !== '';

  // 系譜が語るなら、それが正である。TMUX_PANE は参考にしかならぬ
  // ——子は自分の環境を書き換えられるが、親は選べぬ。
  const anchored = env.anchor?.() ?? null;
  if (anchored) {
    const conflict =
      pane !== '' && pane !== anchored.pane
        ? `TMUX_PANE は ${pane} と言うが、系譜は ${anchored.pane} を指しておる。\n` +
          '  系譜を採る。環境変数の名乗りは偽れるゆえ、これは騙りの跡かもしれぬ。'
        : undefined;
    return {
      id: anchored.agentId,
      source: anchored.agentId ? 'pane' : 'none',
      insideFormation: true,
      anchored: true,
      ...(conflict ? { conflict } : {}),
    };
  }

  if (!insideFormation) {
    // 布陣の外。pane は引かない——空のまま引くと他人を名乗る。
    return { id: fromEnv, source: fromEnv ? 'env' : 'none', insideFormation: false };
  }

  const looked = env.lookup(pane);
  if (looked === null) {
    // 引けなかった。**環境変数へ落ちてはならぬ。**
    // 落ちると、pane を偽って他人を名乗る道が開く。
    return {
      source: 'none',
      insideFormation: true,
      conflict:
        `pane ${pane} に問うたが答えが返らぬ。誰であるか確かめられぬ。\n` +
        '  pane の名が正しいか確かめられよ。\n' +
        '  引けなかった時に環境変数の名乗りを採ると、布陣の中で他人を騙れる。',
    };
  }
  const fromPane = looked.trim() || undefined;

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


/**
 * 役職を名乗って権を振るえるか。
 *
 * 布陣の外（tmux の pane が無い）で環境変数の名乗りを採るのは、
 * 「誰も居らぬ場から役職を名乗る」ことに等しい。inbox write は既に
 * これを塞いでいた（cli.ts）が、**同じ防御が task assign / cmd new /
 * report qc へ配線されておらず**、外から karo を名乗れば足軽へ振れた
 * ——しかも振られた報せの差出人は 'karo' として受け箱に載る。
 * inbox write が塞いだ当のものが、別の戸から入っていた
 * （権限表の突き合わせで発覚・2026-08-28）。
 *
 * 布陣外の名乗りを一律に禁じるのではない。読む分には要らぬ縛りである。
 * **権を振るう副命令だけ**が、この検めを通る。
 *
 * ## これは役職の検めではない（名に騙されるな）
 *
 * 名が「may act as」ゆえ「その役を名乗ってよいか」を判ずるように見えるが、
 * **布陣の中では無条件で通す**。止めるのは布陣**外**からの騙りだけである。
 *
 * ゆえに `actingAs('shogun')` を入口に置いても、**布陣内の足軽は素通りする**。
 * 役職そのものの検めは、必ず**芯の側**（createCmd の CMD_AUTHOR、
 * guard.issue の OTP_ISSUERS、charter の CHARTER_ISSUERS…）で行え。
 *
 * これを怠って足軽が自らに許状を切れた（2026-08-29・門を叩いて発覚）。
 * 入口の検めは入口が増えるたびに漏れる。芯に置けば入口が幾つあっても漏れぬ。
 */
export function mayActAs(id: Identity, role: string): { ok: true } | { ok: false; message: string } {
  if (id.insideFormation) return { ok: true };
  if (id.id !== role) return { ok: true }; // その役を名乗っておらぬなら、別の門が弾く
  return {
    ok: false,
    message:
      `布陣の外から ${role} として振る舞うことはできぬ。\n` +
      '  tmux の pane から名乗りが引ける場（布陣の中）で行われよ。\n' +
      '  外から検めるだけなら読む副命令を使われよ。書き込みは行っておらぬ。',
  };
}
