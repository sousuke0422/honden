/**
 * 見捨てられた司令を見つける。
 *
 * ## 定め
 *
 * 次の四つが揃った司令を「見捨てられた」と呼ぶ。
 *
 *   一、振られた跡がある —— claim に cmd_id 付きの行が残っておる。
 *       振る時に取り置きが切られる（src/dispatch.ts）ゆえ、これが跡になる
 *   二、いま誰も握っておらぬ —— 生きた claim が無く、task の貸与（holder）も無い
 *   三、報告が一つも無い —— report に cmd_id の行が無い
 *   四、閉じてもおらぬ —— status が pending / in_progress
 *
 * 振られる前の pending は含めぬ——claim の跡が無いゆえ一で落ちる。
 * それは差配待ちであって、見捨てられたのではない。
 *
 * いまの定めには限界がある。報告が一つでも上がった司令は三で除くため、
 * その後の別の割り当てが報告を残さず見捨てられても検知できぬ。この司令では
 * 挙動を変えず、将来「最後の割り当て以後の報告」を見る時の宿題として残す。
 *
 * ## ★期限切れとの違い
 *
 * 期限切れ（lease の expired・status 表示は ★期限切）は**握ったまま**時が
 * 過ぎたもので、働いておる者がまだ居るかもしれぬ（自動返却はせぬ決まり）。
 * 見捨てられたのは**握っておらぬのに**残っておるもの。ゆえに二で
 * holder が立っておる行（期限切れ含む）を除いておる。表示の言葉も別にする
 * ——期限切れは「★期限切」、こちらは「⚠見捨てられ」。
 *
 * ## 閾値
 *
 * 最後の跡（claim の at / released_at の新しい方）から既定の貸与一巡
 * （DEFAULT_LEASE_MINUTES = 30 分）を過ぎるまでは判じない。
 * 振り直しの途中——家老が取り置きを解いてすぐ別の者へ振る——は
 * 「誰も握っておらぬ」瞬間を必ず通る。そこで鳴らすと差配のたびに
 * 偽陽性が出る。一巡待って誰も戻らぬなら、もう誰も来ぬ。
 */

import type { Database } from 'bun:sqlite';
import { journal, tx } from './store';
import { deliver } from './inbox';
import { DEFAULT_LEASE_MINUTES } from './lease';
import { ASSIGNER } from './dispatch';

/** 最後の跡からこれだけ経つまでは見捨てられたと判じない。 */
export const ABANDONED_AFTER_MS = DEFAULT_LEASE_MINUTES * 60_000;

export interface Abandoned {
  cmdId: string;
  purpose: string | null;
  /** 最後の跡（claim の at / released_at の新しい方）。ISO。 */
  lastTraceAt: string;
  /**
   * 最後の跡の行番号（claim.id の最大）。重複抑止の鍵はこちらを使う。
   * 刻（lastTraceAt）を鍵にすると、二度目の見捨てが同じ ms に落ちた時に
   * id が衝突して**黙って skip される**（実測で赤を確認）。行番号は
   * AUTOINCREMENT ゆえ、新しい見捨ては必ず新しい claim 行を持つ。
   */
  lastClaimId: number;
  /** 振られた跡のある相手。読み手（家老）が経緯を辿る取っ掛かり。 */
  agents: string;
}

export function findAbandoned(db: Database, now: Date = new Date()): Abandoned[] {
  const rows = db
    .query(
      `SELECT c.id cmdId, c.purpose purpose,
              MAX(MAX(cl.at), COALESCE(MAX(cl.released_at), '')) lastTraceAt,
              MAX(cl.id) lastClaimId,
              GROUP_CONCAT(DISTINCT cl.agent) agents
       FROM cmd c
       JOIN claim cl ON cl.cmd_id = c.id
       WHERE c.status IN ('pending','in_progress')
         AND NOT EXISTS (SELECT 1 FROM claim l WHERE l.cmd_id = c.id AND l.released_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM task t WHERE t.cmd_id = c.id AND t.holder IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM report r WHERE r.cmd_id = c.id)
       GROUP BY c.id
       ORDER BY lastTraceAt`,
    )
    .all() as Abandoned[];
  return rows.filter((r) => now.getTime() - Date.parse(r.lastTraceAt) >= ABANDONED_AFTER_MS);
}

/**
 * 見つけた分を差配する者（家老）の受け箱へ報せる。
 *
 * 知らせる先が家老なのは、振り直しが家老の役ゆえ。将軍へは回さぬ——
 * 差配が二重になる。家老が動かぬまま時が経った時も段は上げぬ。
 * 理由は二つ。一つ、この報せは未読として残り、芯の合図の梯子
 * （src/nudge.ts）が未読の残る家老を段階的に起こし続ける——放置は
 * 既存の機構が既に扱う。二つ、cmd list の印は振り直すか閉じるまで
 * 消えぬゆえ、同じ一覧を見る将軍の目にも自然に入る。
 *
 * 同じ見捨てに二度は鳴らさぬ。報せの id を cmd と最後の跡の行番号
 * （claim.id の最大）から決めて引く——同じ跡なら同じ id ゆえ、二度目は
 * 挿さらぬ。振り直されて再び見捨てられれば必ず新しい claim 行が増え、
 * 新しい報せが出る。刻を鍵にせぬのは、二度目が同じ ms に落ちると
 * 衝突して黙るゆえ（Abandoned.lastClaimId の注を見よ）。
 */
export function notifyAbandoned(db: Database, now: Date = new Date()): Abandoned[] {
  const found = findAbandoned(db, now);
  const sent: Abandoned[] = [];
  for (const a of found) {
    const id = `msg_abandoned_${a.cmdId}_c${a.lastClaimId}`;
    // 在るかの確かめ・報せ・台帳を一つの取引で確定する。台帳だけが落ちて
    // inbox が残ると、重複抑止の鍵が既に在ることになり二度と鳴らぬ。
    const delivered = tx(db, () => {
      if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(id)) return false;
      deliver(db, {
      id,
      agent: ASSIGNER,
      at: now.toISOString(),
      type: 'cmd_abandoned',
      sender: 'core',
      body:
        `見捨てられた司令: ${a.cmdId} ${(a.purpose ?? '').split('\n')[0]}\n\n` +
        `${a.agents} へ振られた跡があるが、いま誰も握っておらず、報告も一つも無い\n` +
        `（最後の跡から ${Math.round((now.getTime() - Date.parse(a.lastTraceAt)) / 60_000)} 分）。\n` +
        `振り直すか、閉じるか、差配されよ。経緯は honden history と honden cmd show ${a.cmdId} で辿れる。`,
    });
      journal(db, {
        actor: 'core',
        action: 'cmd.abandoned.notice',
        target: a.cmdId,
        detail: `跡=${a.agents} 最後の跡=${a.lastTraceAt}`,
      });
      return true;
    });
    if (delivered) sent.push(a);
  }
  return sent;
}
