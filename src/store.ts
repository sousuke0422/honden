/**
 * 正本の開き口。
 *
 * このファイルが、DB を開く唯一の場所になる。
 * pragma の順序も取引の張り方も、ここ一箇所でしか書かない。
 *
 * ## なぜ順序を一箇所に閉じるか
 *
 * `busy_timeout` は `journal_mode = WAL` より **先** に置かなければならない。
 * 逆にすると、WAL への切り替え自体が待たずに `SQLITE_BUSY_RECOVERY` で落ちる。
 *
 * 2026-08-24 の実測: 8 プロセスで 1600 件を書く試験で、
 * 順序を誤ると 7 プロセスが即死して 200 件しか残らなかった。
 * 順序を直すと同じ試験が 1600/1600・欠損 0 で通った。
 *
 * この一行の順序で 1400 件が消えるか消えないかが決まる。
 * 各呼び出し側に「順序を守れ」と言って回る造りでは、いつか誰かが忘れる。
 *
 * ## なぜ置き場所を ext4 に縛るか
 *
 * 同じ実測で、9p (`/mnt/c`) の上では書き込みが 25 倍・読みが 84 倍遅かった。
 * さらに索引を張り忘れたときの代償が 170 倍に膨らむ。
 * 通りはするが、通ることと使えることは別になる。
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 既定の正本の場所。9p を避けて ext4 側へ置く。 */
export const DEFAULT_DB_PATH = resolve(homedir(), '.honden/honden.db');

/** 錠を待つ上限 (ms)。書き手が重なったときに即死せず待つための値。 */
const BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  /** 正本の場所。省略時は `HONDEN_DB` 環境変数、無ければ既定値。 */
  path?: string;
  /** 9p 上のパスを拒否しない。試験でのみ使う。 */
  allowSlowFs?: boolean;
}

/**
 * 正本を開く。
 *
 * pragma は必ずこの順で流す。順序を変えてはならない (冒頭の理由を参照)。
 */
export function openStore(opts: OpenOptions = {}): Database {
  const path = opts.path ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH;

  if (path !== ':memory:') {
    if (!opts.allowSlowFs && path.startsWith('/mnt/')) {
      throw new Error(
        `正本を 9p の上に置こうとしている: ${path}\n` +
          'ext4 側 (~/.honden など) を使うこと。9p では書き込みが 25 倍・読みが 84 倍遅い。',
      );
    }
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true, strict: true });

  // 1. 錠を待つ設定を最初に入れる。これより後に他の pragma を置いてはならない。
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // 2. WAL。書き手 1 人・読み手多数を成立させる。
  db.run('PRAGMA journal_mode = WAL');
  // 3. 外部キーは既定で無効なので明示的に入れる。
  db.run('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

/** 開いた直後の pragma を読み出す。試験が「効いているか」を確かめるために使う。 */
export function pragmas(db: Database): { busyTimeout: number; journalMode: string; foreignKeys: number } {
  const bt = db.query('PRAGMA busy_timeout').get() as { timeout: number };
  const jm = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
  const fk = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
  return { busyTimeout: bt.timeout, journalMode: jm.journal_mode, foreignKeys: fk.foreign_keys };
}

const SCHEMA = `
-- 司令。shogun が書き、karo が状態を進める。
CREATE TABLE IF NOT EXISTS cmd (
  id           TEXT PRIMARY KEY,          -- cmd_704 など。重複は主キーが弾く
  created_at   TEXT NOT NULL,
  north_star   TEXT,
  purpose      TEXT,
  body         TEXT,                      -- command 本文
  project      TEXT,
  priority     TEXT NOT NULL DEFAULT 'medium'
               CHECK (priority IN ('high','medium','low')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','in_progress','done','failed','cancelled')),
  assigned_to  TEXT,
  completed_at TEXT,
  raw          TEXT NOT NULL,             -- 取り込み元の YAML 原文。欠落を出さないため
  legacy       TEXT                       -- 型に収まらなかったものの JSON。null なら無し
);

-- 受け入れ条件。cmd 1 件に対して順序つきで並ぶ。
CREATE TABLE IF NOT EXISTS cmd_acceptance (
  cmd_id  TEXT NOT NULL REFERENCES cmd(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (cmd_id, idx)
);

-- 各エージェントの持ち場。
CREATE TABLE IF NOT EXISTS task (
  agent      TEXT PRIMARY KEY,
  task_id    TEXT,
  status     TEXT NOT NULL DEFAULT 'idle',
  cmd_id     TEXT,
  updated_at TEXT NOT NULL,
  raw        TEXT NOT NULL
);

-- 受け渡し。read は既定で 0 (未読)。
CREATE TABLE IF NOT EXISTS inbox (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  msg_type   TEXT NOT NULL,
  sender     TEXT NOT NULL,
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1))
);
CREATE INDEX IF NOT EXISTS ix_inbox_unread ON inbox(agent, read, created_at);

-- 報告。
--
-- verdict は instructions/gunshi_at.md が定める 4 値だけを受ける。
-- 実データには PASS (90) / CONDITIONAL_PASS (6) / BLOCKED (1) という規定外の値が
-- 混じっており、規定内 85 件に対して規定外が 97 件と過半を占めていた。
-- PASS は廃止された qa_decision の値が欄の名だけ変わって残ったものと見える。
--
-- これらを推測で写してはならない。gunshi_at.md が明記している。
--
--   qa_decision: pass → verdict: APPROVED または APPROVED_WITH_CONCERNS
--   fail を REJECTED と同義に扱うのは誤り
--
-- 一対一ではないので、本文を読まないと写し先が決まらない。
-- 規定外の値は verdict を空にして legacy へ丸ごと落とす。
CREATE TABLE IF NOT EXISTS report (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,
  task_id    TEXT,
  created_at TEXT,
  verdict    TEXT CHECK (verdict IS NULL OR verdict IN
               ('APPROVED','APPROVED_WITH_CONCERNS','CHANGES_REQUESTED','REJECTED')),
  raw        TEXT NOT NULL,
  legacy     TEXT                      -- 型に収まらなかったものの JSON。null なら無し
);
CREATE INDEX IF NOT EXISTS ix_report_agent ON report(agent, created_at);

-- 報告の中の個別の検査項目。verdict とは別の enum を持つ。
-- 実データは PASS 474 / PLAUSIBLE 4 / FAIL 2 / PARTIAL 2 / WARNING 1 で、
-- PLAUSIBLE は外部レビューの verdict がこの欄へ紛れ込んだものと見える。
CREATE TABLE IF NOT EXISTS report_check (
  report_id INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  name      TEXT NOT NULL,
  result    TEXT CHECK (result IS NULL OR result IN ('PASS','FAIL','WARNING')),
  note      TEXT,
  legacy    TEXT,
  PRIMARY KEY (report_id, idx)
);

-- 追記専用の台帳。書き込みは全部ここにも落ちる。
-- kagemusha の decisions_journal に相当する層。上書きも削除もしない。
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger_at ON ledger(at);
`;

function migrate(db: Database): void {
  db.run(SCHEMA);
}

/**
 * 取引で包む。
 *
 * 包まないと 1 件ごとに fsync が走る。実測で 5000 件が 3114ms 対 8.3ms
 * (約 375 倍) になった。速さの話に見えるが、包まないと途中で落ちたときに
 * 半端な状態が残るという点のほうが重い。
 */
export function tx<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

/**
 * 型に収まらなかったものを 1 つの JSON にまとめる。
 *
 * 欄を増やして受け止めると、規定と規定外の境目が schema から読めなくなる。
 * 収まらなかったものは、収まらなかったという事実ごと 1 箇所へ置く。
 *
 * 中身が空なら null を返す。null と `'{}'` を区別して、
 * 「legacy が無い」と「legacy が空だった」を取り違えないため。
 */
export function legacy(obj: Record<string, unknown>): string | null {
  const kept = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
  return kept.length === 0 ? null : JSON.stringify(Object.fromEntries(kept));
}

/** 台帳へ 1 行落とす。取引の中から呼ぶこと。 */
export function journal(
  db: Database,
  entry: { actor: string; action: string; target?: string; detail?: string },
): void {
  db.prepare(
    'INSERT INTO ledger(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), entry.actor, entry.action, entry.target ?? null, entry.detail ?? null);
}
