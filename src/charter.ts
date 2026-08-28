/**
 * 許状 — cmd に縛られた多回券。honden-bot 専用。
 *
 * 手形（guard_otp）との別:
 * - 手形は「一つのコマンド文字列に一回」。禁じ手の個別解錠。
 * - 許状は「この cmd の間・この repo・この verb・N 回まで」。原則は将軍が
 *   自ら建てるが、個数が多い時などに配下へ下賜する（殿裁定 2026-08-29）。
 *
 * 縛りは五重: agent・cmd（閉じれば即死ぬ）・的（repo/verb）・回数・刻。
 * 「モデルの能力が十分か」「明示の指示があったか」は発行判断の訓戒であって、
 * 機構には入れぬ——機構が持つのは縛りと監査だけである。
 */
import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { validRepo } from './bot';

export interface Charter {
  id: number;
  agent: string;
  cmd_id: string;
  repo: string;
  verb: string;
  uses_left: number;
  issuer: string;
  reason: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export const CHARTER_VERBS = ['create', 'comment'] as const;
export const CHARTER_MAX_USES = 200;
export const CHARTER_DEFAULT_TTL_MIN = 60;
export const CHARTER_MAX_TTL_MIN = 480;

/** cmd がまだ開いておるか。閉じた cmd の許状は発行も使用もできぬ。 */
function cmdOpen(db: Database, cmdId: string): boolean {
  const r = db.query('SELECT status FROM cmd WHERE id = ?').get(cmdId) as { status: string } | null;
  return r !== null && (r.status === 'pending' || r.status === 'in_progress');
}

export function issueCharter(
  db: Database,
  input: { agent: string; cmdId: string; repo: string; verb: string; uses: number; issuer: string; reason: string },
  now: Date,
  ttlMs: number,
): { ok: true; id: number; expiresAt: string } | { ok: false; message: string } {
  if (!validRepo(input.repo)) return { ok: false, message: `repo は OWNER/REPO の形で（${input.repo}）` };
  if (!(CHARTER_VERBS as readonly string[]).includes(input.verb)) {
    return { ok: false, message: `verb は ${CHARTER_VERBS.join('/')} のいずれか（${input.verb}）` };
  }
  if (!Number.isInteger(input.uses) || input.uses < 1 || input.uses > CHARTER_MAX_USES) {
    return { ok: false, message: `回数は 1〜${CHARTER_MAX_USES} で` };
  }
  if (!cmdOpen(db, input.cmdId)) {
    return { ok: false, message: `cmd ${input.cmdId} は開いておらぬ（無い・done・failed・cancelled）。閉じた戦への許状は切れぬ` };
  }
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const r = db
    .prepare(
      `INSERT INTO guard_charter(agent, cmd_id, repo, verb, uses_left, issuer, reason, issued_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(input.agent, input.cmdId, input.repo, input.verb, input.uses, input.issuer, input.reason, now.toISOString(), expiresAt);
  const id = Number(r.lastInsertRowid);
  journal(db, {
    actor: input.issuer,
    action: 'charter_issue',
    target: input.agent,
    detail: `#${id} ${input.cmdId} ${input.repo} ${input.verb} x${input.uses}`,
  });
  return { ok: true, id, expiresAt };
}

/**
 * 生きた許状を探す。無ければ null。
 * 生きているとは: 取り消されず・刻が残り・回数が残り・cmd がまだ開いている。
 */
export function findCharter(db: Database, agent: string, repo: string, verb: string, now: Date): Charter | null {
  const rows = db
    .query(
      `SELECT * FROM guard_charter
       WHERE agent = ? AND repo = ? AND verb = ? AND revoked_at IS NULL
         AND uses_left > 0 AND expires_at > ?
       ORDER BY id DESC`,
    )
    .all(agent, repo, verb, now.toISOString()) as Charter[];
  for (const c of rows) {
    if (cmdOpen(db, c.cmd_id)) return c;
  }
  return null;
}

/**
 * 一回使う。減算と記帳は不可分（取引の中で呼ぶこと）。
 * 減算は撃つ前に行う——失敗した弾を無料にすると、失敗し続ける限り
 * 無限に撃てる穴になる。回数は失敗込みで見積もって切る。
 */
export function useCharter(db: Database, c: Charter, detail: string): void {
  const r = db.prepare('UPDATE guard_charter SET uses_left = uses_left - 1 WHERE id = ? AND uses_left > 0').run(c.id);
  if (r.changes !== 1) throw new Error(`許状 #${c.id} は尽きておる`);
  journal(db, { actor: c.agent, action: 'charter_use', target: `#${c.id}`, detail });
}

export function revokeCharter(db: Database, id: number, actor: string, now: Date): { ok: boolean; message: string } {
  const r = db
    .prepare('UPDATE guard_charter SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now.toISOString(), id);
  if (r.changes !== 1) return { ok: false, message: `許状 #${id} は無いか、既に取り消されておる` };
  journal(db, { actor, action: 'charter_revoke', target: `#${id}` });
  return { ok: true, message: `許状 #${id} を取り消した` };
}

/** 一覧（表示用）。死んだものも由とともに出す——監査の目のため。 */
export function listCharters(db: Database, now: Date): (Charter & { state: string })[] {
  const rows = db.query('SELECT * FROM guard_charter ORDER BY id DESC LIMIT 50').all() as Charter[];
  return rows.map((c) => {
    let state = '生';
    if (c.revoked_at) state = '取消';
    else if (c.uses_left <= 0) state = '尽き';
    else if (c.expires_at <= now.toISOString()) state = '期限切れ';
    else if (!cmdOpen(db, c.cmd_id)) state = 'cmd閉';
    return { ...c, state };
  });
}
