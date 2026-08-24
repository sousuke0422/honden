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

-- 顔ぶれ。
--
-- 名簿を固定で持ってはならない。布陣は環境ごとに大きさが違う。
-- 例えば投資分析用の環境 (fshogun) は足軽 7 体を要さない。2 体で足りる。
--
-- 役職の名は変わらない (shogun / karo / gunshi と ashigaruN)。変わるのは
-- 足軽の頭数だけで、上限が 7。fshogun のような名は環境そのものの名であって、
-- 役職名ではない。
--
-- 出所は環境の settings.yaml の cli.agents。鍵がそのまま顔ぶれになる。
--
-- 名簿が空のときは書かせない。「たぶんこの名だろう」で通すと、
-- 2 体しか居ない環境で ashigaru5 が通ってしまう。
-- 一覧に無いものを既定へ落とすと、正しく書かれた検査が死ぬ
-- (docs/decisions.md の cursor の件と同じ型)。
CREATE TABLE IF NOT EXISTS roster (
  id    TEXT PRIMARY KEY,
  role  TEXT NOT NULL CHECK (role IN ('commander','worker')),
  cli   TEXT,
  model TEXT
);

-- 各エージェントの持ち場。
--
-- ## なぜ貸与 (lease) を持つか
--
-- YAML 直書きの造りでは status: assigned が一度書かれるだけで更新されない。
-- だから「今も持ち主が居るのか」を直に問えず、周辺の痕跡から推し量るしかない。
--
-- shogun 側の沈黙検知 (lib/stale_task_detect.sh) は、こう推し量っている。
--
--   最終活動 = max(assigned_at, report の mtime, task YAML の mtime)
--
-- そのために 4 層 (死署名 / 沈黙30分 / 再通知90分 / pane 不在) と 500 行余りが要る。
-- しかも死署名の層には「新しい壊れ方は未知の文字列。一覧に無ければ原理的に
-- 取りこぼす」と実装者自身の但し書きがある。
--
-- mtime は嘘をつく。関係ない者がファイルを触れば動くし (2026-08-24 に将軍が
-- 実演した)、足軽が黙って考えていれば生きていても沈黙と判ぜられる。
-- 痕跡は活動そのものではない。
--
-- 期限を持てば、期限切れは推定ではなく事実になる。pane を覗く必要も、
-- 死署名の一覧を育てる必要も無くなる。
--
-- ## DHCP から借りるもの・借りないもの
--
-- 借りる: 更新は期限の前に仕事のついでに行う (T1 更新) / 台帳が正であって
-- 持ち主の自己申告ではない / 再起動時は前の貸与を確かめてから使う (INIT-REBOOT。
-- /clear 復帰がこれに当たる)。
--
-- 借りない: 期限切れで自動的に池へ返すこと。IP は誰に渡っても同じだが、
-- 半分やりかけた仕事は他の足軽に渡しても続かない。文脈が消えているため。
-- 期限切れは「空き」ではなく「要報告」として扱う。
-- shogun 側の実装も既に「自動振り直しなし」と明記していて、そこは正しい。
CREATE TABLE IF NOT EXISTS task (
  agent       TEXT PRIMARY KEY,
  task_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  cmd_id      TEXT,
  updated_at  TEXT NOT NULL,
  raw         TEXT NOT NULL,
  holder      TEXT,          -- 誰が握っているか。null なら空き
  leased_at   TEXT,
  lease_until TEXT           -- ここを過ぎたら期限切れ。ただし自動返却はしない
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

-- 全文検索。
--
-- 日本語は unicode61 のままだと漢字の連なりが 1 語になる。Bun には ICU が
-- 積まれているが FTS5 の tokenizer としては出ていないので、Intl.Segmenter
-- で切ってから unicode61 に渡す。拡張 (.so) は要らない。
--
-- ## 書く側と引く側で同じ関数を通すこと
--
-- これが唯一かつ最大の要点になる。文書を切って索引に入れたなら、問いも同じく
-- 切らなければ当たらない。複合語が割れても、問いが同じ割れ方をすれば AND で
-- 当たる。
--
--   監視役 → 監視 | 役      文書も問いも同じに割れるので当たる
--
-- 索引だけ切って問いを切らないと、複合語が全滅する。
-- 2026-08-24 にその形で測って「複合語が引けない」と誤って結論した。
-- 索引の穴ではなく、測り方の穴だった。
--
-- ## trigram を張らない理由
--
-- 実データ 825 本 7.1MB での実測:
--
--   方式        索引     構築    検証  実装  監視役 回帰試験 権限境界 SQLite  gram
--   segmented  10.2MB   504ms   398  413    3     27     18      3      0
--   trigram    26.2MB   696ms     0    0     0      7      2      3     10
--
-- trigram が勝つのは gram のような「語の途中から打った時」だけで、索引は
-- 2.6 倍になる。その引き方が要るようになったら、doc.body への LIKE で足りる
-- (825 本 7MB なら全走査でも一瞬)。索引を 2 本抱えるより安い。
CREATE TABLE IF NOT EXISTS doc (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,          -- cmd / report / inbox / task / saytask / archive
  ref    TEXT,                   -- cmd_704 など。追える先があれば入れる
  source TEXT,                   -- 取り込み元のファイル
  at     TEXT,
  body   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_doc_kind ON doc(kind, at);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  body, doc_id UNINDEXED, tokenize = 'unicode61'
);

-- 取り込み元のファイル。
--
-- honden が単体で動くまで、shogun 側の YAML からの取り込みは何度も走る。
-- 二度目で重複が積もらないよう、ファイルを識別子にして冪等に入れ替える。
-- sha256 が変わっていなければ触らない。
CREATE TABLE IF NOT EXISTS source (
  path        TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  doc_count   INTEGER NOT NULL DEFAULT 0
);

-- 取り込めなかったものの記録。
--
-- 読めないファイルを黙って飛ばしてはならない。飛ばしたことが残らなければ、
-- 取り込みが「全部入った」ように見える。だが 1 本読めないだけで全体を止めると、
-- 繰り返しの取り込みが成立しない。なので「記録して続け、最後に非ゼロで終わる」。
CREATE TABLE IF NOT EXISTS import_issue (
  path       TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- parse / encoding / shape
  detail     TEXT NOT NULL
);
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

/**
 * 日本語を語に切って空白で繋ぐ。
 *
 * Bun には ICU が積まれているが FTS5 の tokenizer としては出ていない。
 * `Intl.Segmenter` からなら使えるので、書き込みの時に切ってしまう。
 * 拡張 (.so) を読み込む必要が無いので、外から取ってきた実行物も要らない。
 */
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
export function segment(text: string): string {
  const out: string[] = [];
  for (const s of segmenter.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out.join(' ');
}

export interface DocInput {
  kind: string;
  ref?: string;
  source?: string;
  at?: string;
  body: string;
}

/**
 * 資料を 1 件積み、索引を張る。取引の中から呼ぶこと。
 *
 * 索引に入れる前に必ず [`segment`] を通す。引く側 ([`search`]) も同じ関数を
 * 通す。この一致が崩れると複合語が全滅するので、両方をこの 1 ファイルに
 * 閉じてある。
 */
export function indexDoc(db: Database, doc: DocInput): number {
  db.prepare('INSERT INTO doc(kind, ref, source, at, body) VALUES (?,?,?,?,?)').run(
    doc.kind,
    doc.ref ?? null,
    doc.source ?? null,
    doc.at ?? null,
    doc.body,
  );
  const id = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  db.prepare('INSERT INTO doc_fts(body, doc_id) VALUES (?,?)').run(segment(doc.body), id);
  return id;
}

export interface Hit {
  id: number;
  kind: string;
  ref: string | null;
  source: string | null;
}

/**
 * 全文検索。問いも [`segment`] を通してから当てる。
 *
 * 語の途中から打ちたい場合 (`gram` で `trigram` を出したい等) はここでは当たらない。
 * その用が出たら doc.body への LIKE を足すこと。索引をもう 1 本張るより安い。
 */
export function search(db: Database, query: string, limit = 50): Hit[] {
  let ids: number[];
  try {
    ids = (
      db.query('SELECT doc_id FROM doc_fts WHERE doc_fts MATCH ? LIMIT ?').all(
        segment(query),
        limit,
      ) as { doc_id: number }[]
    ).map((r) => r.doc_id);
  } catch {
    // 検索語が FTS5 の構文として成立しない場合 (記号だけ等)。0 件で返す。
    return [];
  }
  if (ids.length === 0) return [];
  return db
    .query(`SELECT id, kind, ref, source FROM doc WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Hit[];
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
