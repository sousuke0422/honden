/**
 * 上がったまま検められておらぬ報告を見つける。
 *
 * ## 定め
 *
 * 次の五つが揃った報告を「検められておらぬ」と呼ぶ。
 *
 *   一、その task の**最新の報告行**である —— 検め（QC）は元の行の verdict を
 *       書き換えず、軍師の名で**新しい行**を挿す（src/report.ts の submitQc）。
 *       ゆえに『verdict が NULL の行』はほぼ全ての足軽報告に当てはまり、
 *       そのままでは検め済みの物まで数えてしまう。task ごとに最新の一行だけを
 *       見れば、検めが出た task は最新行に verdict が立ち、自然に外れる。
 *       後から差し替わった古い報告も、最新でないゆえ同じ理屈で外れる
 *   二、その最新行の verdict が NULL —— 検めがまだ出ておらぬ
 *   三、cmd_id があり、その司令が閉じておらぬ —— status が pending / in_progress。
 *       cmd_id の無い旧報告は司令の状態を判じられず、閉じた司令に残った
 *       報告も、もう誰の検めも待っておらぬ
 *   四、origin が native —— import は旧陣の YAML の写しで、検めの流れの外に居る
 *   五、上がってから閾値を過ぎておる
 *
 * ## 閾値
 *
 * 既にある三つの検知（見捨て・止まった持ち場・未差配）はいずれも
 * 既定貸与一巡（DEFAULT_LEASE_MINUTES = 30 分）を閾値に採る。ここも揃える。
 * 上がった直後に鳴らせば軍師が読む前の催促になる。三十分は「生きて動いて
 * おれば検めに掛かっておる」と見てよい長さで、実際に起きた詰まり
 * （一時間十五分）は確実に網に掛かる。
 *
 * ## 知らせる先
 *
 * 検めるのは軍師の役ゆえ、まず軍師へ報せる。未読が残る限り、芯の合図の
 * 梯子（src/nudge.ts）が軍師を段階的に起こし続ける——ここまでは既存の
 * 機構の役である。だが軍師が三度促されて動かなんだ形が現に起きておる。
 * 同じ報告が閾値の三倍を過ぎてなお検められておらねば、**家老へも一度**
 * 報せる。家老は報告の路（足軽 → 軍師 → 家老）の下流に居て止まりに
 * 気づける位置であり、軍師を立て直すか検めの運びを差配できる。
 * 将軍へは回さぬ——殿の在席中は将軍への路が塞がっており、差配も二重になる。
 */

import type { Database } from 'bun:sqlite';
import { journal, tx } from './store';
import { deliver } from './inbox';
import { DEFAULT_LEASE_MINUTES } from './lease';
import { ASSIGNER } from './dispatch';
import { QC_AUTHOR } from './report';

/** 上がってからこれだけ経つまでは詰まりと判じない。 */
export const UNREVIEWED_AFTER_MS = DEFAULT_LEASE_MINUTES * 60_000;
/** これを過ぎてなお検められておらねば、家老へも一度報せる。 */
export const UNREVIEWED_ESCALATE_MS = UNREVIEWED_AFTER_MS * 3;

export interface Unreviewed {
  reportId: number;
  taskId: string;
  cmdId: string | null;
  agent: string;
  createdAt: string;
}

const BASE_WHERE = `
       WHERE r.verdict IS NULL
         AND r.origin = 'native'
         AND r.task_id IS NOT NULL
         AND r.id = (SELECT MAX(r2.id) FROM report r2 WHERE r2.task_id = r.task_id)
         AND r.cmd_id IS NOT NULL
         AND EXISTS (
               SELECT 1 FROM cmd c WHERE c.id = r.cmd_id AND c.status IN ('pending','in_progress'))`;

export function findUnreviewed(db: Database, now: Date = new Date()): Unreviewed[] {
  // 検め済みの task への直しの報告は数えぬ——軍師は同じ task を二度検められぬ
  // （src/report.ts submitQc の門）。軍師へ報せても果たせぬ命になる。
  // その形は findRereported が拾い、家老へ別の言葉で届く。
  const rows = db
    .query(
      `SELECT r.id reportId, r.task_id taskId, r.cmd_id cmdId, r.agent agent, r.created_at createdAt
       FROM report r
       ${BASE_WHERE}
         AND NOT EXISTS (SELECT 1 FROM report q
               WHERE q.task_id = r.task_id AND q.agent = ? AND q.verdict IS NOT NULL)
       ORDER BY r.created_at`,
    )
    .all(QC_AUTHOR) as Unreviewed[];
  return rows.filter((r) => now.getTime() - Date.parse(r.createdAt) >= UNREVIEWED_AFTER_MS);
}

/**
 * 検め済みの task へ上がった直しの報告。
 *
 * 軍師はこれを検められぬ（submitQc が拒む）ゆえ、放っておけば誰にも
 * 読まれぬまま朽ちる——それ自体が「振り直しが要る」印である。
 * 黙って捨てず、差配できる家老へ届ける。
 */
export function findRereported(db: Database, now: Date = new Date()): Unreviewed[] {
  const rows = db
    .query(
      `SELECT r.id reportId, r.task_id taskId, r.cmd_id cmdId, r.agent agent, r.created_at createdAt
       FROM report r
       ${BASE_WHERE}
         AND r.agent != ?
         AND EXISTS (SELECT 1 FROM report q
               WHERE q.task_id = r.task_id AND q.agent = ? AND q.verdict IS NOT NULL)
       ORDER BY r.created_at`,
    )
    .all(QC_AUTHOR, QC_AUTHOR) as Unreviewed[];
  return rows.filter((r) => now.getTime() - Date.parse(r.createdAt) >= UNREVIEWED_AFTER_MS);
}

/**
 * 見つけた分を軍師へ、長引けば家老へも報せる。
 *
 * 同じ詰まりに二度は鳴らさぬ。報せの id を task と**報告の行番号**から
 * 決めて引く——検めが出た後に直しの報告が上がって再び詰まれば、必ず
 * 新しい行番号を持つゆえ、改めて鳴る（見捨ての lastClaimId と同じ理屈。
 * 刻を鍵にすると同じ ms で衝突して黙る）。家老への報せは別の id を持ち、
 * 同じ報告につき一度だけ出る。
 */
export function notifyUnreviewed(db: Database, now: Date = new Date()): Unreviewed[] {
  const found = findUnreviewed(db, now);
  const sent: Unreviewed[] = [];
  for (const u of found) {
    const waitedMin = Math.round((now.getTime() - Date.parse(u.createdAt)) / 60_000);
    const head =
      `検められておらぬ報告: #${u.reportId} ${u.agent} / ${u.taskId}${u.cmdId ? ` / ${u.cmdId}` : ''}\n\n` +
      `上がってから ${waitedMin} 分、検めが出ておらぬ。司令は閉じておらず、` +
      `これより新しい報告も無い。\n`;
    const id = `msg_unreviewed_${u.taskId}_r${u.reportId}`;
    // 在るかの確かめ・報せ・台帳を一つの取引で確定する。台帳が落ちれば
    // 報せも巻き戻り、次の周で改めて試みられる——inbox だけが残ると
    // 重複抑止の鍵が既に在ることになり、二度と鳴らぬ。
    const delivered = tx(db, () => {
      if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(id)) return false;
      deliver(db, {
        id,
        agent: QC_AUTHOR,
        at: now.toISOString(),
        type: 'report_unreviewed',
        sender: 'core',
        body: head + `honden report qc で検められよ。中身は正本の report #${u.reportId} に在る。`,
      });
      journal(db, {
        actor: 'core',
        action: 'report.unreviewed.notice',
        target: u.taskId,
        detail: `report=#${u.reportId} agent=${u.agent} waited_min=${waitedMin}`,
      });
      return true;
    });
    if (delivered) sent.push(u);
    if (now.getTime() - Date.parse(u.createdAt) >= UNREVIEWED_ESCALATE_MS) {
      const kid = `msg_unreviewed_${u.taskId}_r${u.reportId}_karo`;
      tx(db, () => {
        if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(kid)) return;
        deliver(db, {
          id: kid,
          agent: ASSIGNER,
          at: now.toISOString(),
          type: 'report_unreviewed',
          sender: 'core',
          body:
            head +
            `軍師へは報せてあるが、閾値の三倍を過ぎても検めが出ぬ。\n` +
            `軍師を立て直すか、検めの運びを差配されよ。`,
        });
        journal(db, {
          actor: 'core',
          action: 'report.unreviewed.escalate',
          target: u.taskId,
          detail: `report=#${u.reportId} waited_min=${waitedMin}`,
        });
      });
    }
  }

  // 検め済みの task への直しの報告——軍師には果たせぬゆえ、家老へ別の言葉で。
  // 案内は submitQc の門と同じ言葉に揃える（読む者が同じ手順へ辿り着くように）。
  for (const u of findRereported(db, now)) {
    const rid = `msg_requeue_${u.taskId}_r${u.reportId}`;
    tx(db, () => {
      if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(rid)) return;
      deliver(db, {
      id: rid,
      agent: ASSIGNER,
      at: now.toISOString(),
      type: 'report_requeue',
      sender: 'core',
      body:
        `振り直しが要る報告: #${u.reportId} ${u.agent} / ${u.taskId}${u.cmdId ? ` / ${u.cmdId}` : ''}\n\n` +
        `${u.taskId} は既に検めてあり、軍師は同じ仕事を二度検められぬ。\n` +
        `直しの報告が上がったままでは誰にも読まれぬ。\n` +
        `やり直させるなら新しい仕事として振り直されよ（現行の Redo Protocol と同じ）。`,
    });
      journal(db, {
        actor: 'core',
        action: 'report.requeue.notice',
        target: u.taskId,
        detail: `report=#${u.reportId} agent=${u.agent}`,
      });
    });
  }
  return sent;
}
