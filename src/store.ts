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
import { mkdirSync, writeFileSync } from 'node:fs';
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
/**
 * 開いた正本の場所。合図の口を作るために覚えておく。
 *
 * WeakMap ゆえ、Database が落ちれば一緒に消える。
 */
const dbPathOf = new WeakMap<Database, string>();

/**
 * 合図の口。
 *
 * 常駐する監視の芯 (core/watch) はこの一点だけを見張る。
 *
 * ## なぜ正本そのものを見張らぬか
 *
 * 手 (nudge を飛ばす側) は正本を読み、届けたら台帳へ書く。
 * 正本を見張ると、その書き込みで芯がまた手を呼び、手がまた書く。
 * 実測で確かめた——見張り先へ書く手を置いたところ、6 秒で 27 回回った
 * (2026-08-26)。歯止め (floor) は回転の速さを抑えるだけで、止められない。
 *
 * 口を分ければ、その筋が構造として消える。合図の口へ触るのは
 * 「誰かの未読が増えた時」だけで、手は決して触らない。
 *
 * ## 取引の外で触る
 *
 * 取引が巻き戻っても、この touch は戻らない。余計な起床が 1 回起きるが、
 * 手は未読を数え直すだけなので害が無い。逆に、取引の中に入れて
 * 「書けたのに合図が出ない」筋を作るほうが重い。
 */
export function signalPathOf(dbPath: string): string {
  return `${dbPath}.signal`;
}

/** 誰かの未読が増えたことを、常駐している芯へ知らせる。 */
export function raiseSignal(db: Database): void {
  const path = dbPathOf.get(db);
  if (!path) return; // :memory: では見張る先が無い
  const sig = signalPathOf(path);
  try {
    // 中身は要らない。触れた事実だけが合図になる。
    writeFileSync(sig, `${Date.now()}\n`);
  } catch {
    // 合図が出せずとも、正本には入っている。芯は既定の網で起きる。
    // ここで投げると、届いた報せを書けたのに失敗として返すことになる。
  }
}

export function openStore(opts: OpenOptions = {}): Database {
  const path = opts.path ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH;

  if (path !== ':memory:') {
    // 相対パスは実体へ解決してから検める。文字列先頭だけ見ると
    // `$HOME/…` のような迷子の相対パスが 9p の上に落ちても素通りする
    // （2026-08-27 実測: hook の env 誤りで実際に起きた）。
    if (!opts.allowSlowFs && resolve(path).startsWith('/mnt/')) {
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
  if (path !== ':memory:') dbPathOf.set(db, path);
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
--
-- changed_at は、その条件の文言が最後に変わった時刻。
-- **文言が変わる前に集めた証拠は、変わった後の条件を覆っていない。**
-- 覆いを数える所でここを見る (src/report.ts)。
CREATE TABLE IF NOT EXISTS cmd_acceptance (
  cmd_id     TEXT NOT NULL REFERENCES cmd(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  changed_at TEXT,
  PRIMARY KEY (cmd_id, idx)
);

-- 殿の裁定を仰ぐもの。
--
-- 現行は dashboard.md の 🚨要対応 節に散文で積む。実測（2026-08-26）:
--
--   352 項目のうち  未決 57 / 済んだまま残存 95 / 決裁でない覚え書き 83 / 印なし 117
--   節そのものが 2 つに増えていた（手で書き換えて重複した）
--
-- **本物の決裁が 16% しかない。** 散文には状態が無いので、消すには判断が要り、
-- 誰も消さない。積むだけで判定に使わぬ型がここにも出ている。
--
-- 状態を持たせれば、絞り込みで消える。
CREATE TABLE IF NOT EXISTS decision (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cmd_id      TEXT,
  raised_by   TEXT NOT NULL,
  at          TEXT NOT NULL,
  question    TEXT NOT NULL,
  choices     TEXT NOT NULL,          -- JSON の一覧。自由文は決裁の問いではない
  fallback    TEXT,                   -- 何も決まらぬ時に採るもの。null なら止まる
  expires_at  TEXT,                   -- fallback を採る時刻
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','decided','expired','withdrawn')),
  chose       TEXT,
  decided_by  TEXT,
  decided_at  TEXT,
  note        TEXT                    -- 殿の言葉をそのまま置く所
);
CREATE INDEX IF NOT EXISTS ix_decision_open ON decision(status, id);

-- 司令の書き換えの跡。追記専用。
--
-- 現行はこれを散文で守っている——instructions/shogun_at.md の
-- 「cmd 修正後は必ず inbox_write で家老に通知せよ」。守られねば、
-- 足軽が旧版の指示で動き続ける。実際に一巡無駄になっている
-- (memory: 完了 cmd は編集で届かない・2026-07-14)。
CREATE TABLE IF NOT EXISTS cmd_revision (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  cmd_id  TEXT NOT NULL REFERENCES cmd(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL,
  field   TEXT NOT NULL,
  before  TEXT,
  after   TEXT,
  reason  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cmd_revision ON cmd_revision(cmd_id, id);

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

-- モデルの能力制限。
--
-- これは「使ってよいモデルの一覧」ではなく「能力に制限があるモデルの一覧」。
-- 表に無いモデルは制限なし (max_bloom 6) として扱う。
--
-- 許可制にすると、新しいモデルが出た日に表へ載るまで使えない。載せ忘れが
-- そのまま封鎖になる。この領域では「新しいものは古いものより強い」がほぼ
-- 当たるので、未知を通す向きが正しい。
--
-- 素性 (provider) はこの表では縛らない。能力と素性は既定の向きが逆で、
-- 素性は「未知は止める」でなければならない (src/routing.ts の providerOf)。
CREATE TABLE IF NOT EXISTS model_limit (
  model      TEXT PRIMARY KEY,
  max_bloom  INTEGER NOT NULL CHECK (max_bloom BETWEEN 1 AND 6),
  cost_group TEXT
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
  read       INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  -- report と同じ理由。影が実運用の報せを上書きせぬため。
  origin     TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native','import'))
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
  cmd_id     TEXT,                     -- どの司令の下の報告か。門はここで引く
  -- native: honden が受けた報告 / import: shogun 側 YAML から写したもの
  --
  -- 影が実運用の行を上書きすると、raw が YAML 原文に化けて
  -- coverageOf の json_extract が倒れ、**その司令の門が丸ごと止まる**
  -- （外部レビューで再現・2026-08-27）。影は影の行だけを触る。
  origin     TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native','import')),
  raw        TEXT NOT NULL,
  legacy     TEXT                      -- 型に収まらなかったものの JSON。null なら無し
);
CREATE INDEX IF NOT EXISTS ix_report_agent ON report(agent, created_at);

-- 受け入れ条件ごとの証拠。
--
-- 現行では足軽の報告 YAML に acceptance_check: として並んでいる
-- （queue/reports/ashigaru1_report.yaml に実在する）。だが並べるだけで、
-- 全条件を覆っているかを検める者が居らず、家老の指示書に
-- 「未達の条件があるなら done にするな」と散文で書いてあるだけになっている。
--
-- 条件は cmd_acceptance の idx で引く。文言で照合すると、
-- 写し間違いや言い換えで別物になり、覆っていないのに覆ったことになる。
CREATE TABLE IF NOT EXISTS report_acceptance (
  report_id INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,      -- cmd_acceptance.idx と同じ番号
  evidence  TEXT NOT NULL,
  PRIMARY KEY (report_id, idx)
);

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

-- 案件の所在。現行 config/projects.yaml を写す。
--
-- 場所が書かれずに振られた時、ここから補う。無ければ補わない——
-- 「無いなら無いでよい」（殿下知 2026-08-26）。
--
-- 罠がある。work_location: coder の案件は path (WSL) が参照専用で、
-- 実体は Coder の中にある。素直に path を補うと、押せぬ場所を握らせる。
-- 現行でも足軽が二度これで失敗しておる (cmd_266, cmd_273)。
CREATE TABLE IF NOT EXISTS project (
  id              TEXT PRIMARY KEY,
  path            TEXT,
  work_location   TEXT,     -- coder / null(=path が実体)
  coder_workspace TEXT,
  coder_workdir   TEXT,
  status          TEXT,
  raw             TEXT NOT NULL
);

-- 場所の取り置き。
--
-- 貸与 (task.holder) が答えるのは「その足軽が塞がっておるか」であって、
-- 「その worktree を誰が握っておるか」ではない。別の足軽が同じ木を触れる。
--
-- 現行はこれを散文で守っている。だが守れない。
--   instructions/ashigaru.md:168  他の足軽のファイルを絶対に読むな
--   instructions/ashigaru.md RACE-001  衝突の恐れがあれば家老へ伺え
-- 足軽は他人の持ち場を見られぬので、恐れに気づけない。見えるのは家老だけで、
-- その拠り所は記憶しかない。実際に merge commit を生んだ (2026-08-25)。
--
-- 取り置きは重なりで判ずる。path は前置きの一致まで見る——
-- .worktrees/x を握っておる者が居れば .worktrees/x/apps も重なる。
CREATE TABLE IF NOT EXISTS claim (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('path','branch')),
  value       TEXT NOT NULL,
  agent       TEXT NOT NULL,
  task_id     TEXT,
  cmd_id      TEXT,
  at          TEXT NOT NULL,
  released_at TEXT,             -- null なら握っておる
  -- declared: 振る時に明示された。約束ゆえ、重なれば断る
  -- inferred: 案件の所在から補った。ただの見立てゆえ、断らずに知らせるだけ
  source      TEXT NOT NULL DEFAULT 'declared' CHECK (source IN ('declared','inferred'))
);
CREATE INDEX IF NOT EXISTS ix_claim_live ON claim(released_at, kind);

-- 環境そのものの決め事。いまのところ運用の様態だけ。
--
-- 正本に置くのは、芯も手も家老も同じものを見る必要があるゆえ。
-- 設定ファイルへ置くと、書き換えても走っておるものが拾わない。
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL,
  by    TEXT,
  until TEXT          -- この時刻を過ぎたら既定へ戻る。null なら戻らぬ
);

-- 合図の段の覚え。
--
-- 「いつから未読が続いておるか」「最後にいつ撃ったか」を持つ。
-- 段 (escalation) は時刻の差から毎回計算する。段そのものを持つと、
-- 覚えと実際がずれた時にどちらが正しいか決まらない。
--
-- 常駐する芯 (core/watch) は状態を持たない。持たせると、芯が落ちた時に
-- 段が巻き戻る。正本に置けば、芯は何度落ちても続きから拾える。
CREATE TABLE IF NOT EXISTS nudge (
  agent         TEXT PRIMARY KEY,
  since         TEXT,   -- 未読が 0 から増えた時刻。0 に戻れば消す
  last_at       TEXT,   -- 最後に合図を撃った時刻
  last_level    INTEGER,
  last_reset_at TEXT,   -- 最後に文脈を消させた時刻。連発を防ぐ
  -- 何度文脈を消させたか。未読が片付けば 0 へ戻る。
  --
  -- 段梯子には終わりが無かった: L2 → 消し → L2 → 消し を永久に繰り返す。
  -- 応えぬ相手（受け手が死んでおる・CLI が落ちておる）に二時間半で
  -- 150 回の合図と 30 回の文脈消しを撃ち続けた（2026-08-28 一巡試験・実測）。
  -- 実機であれば五分ごとに文脈を焼かれ続ける。**諦める段が要る。**
  reset_count   INTEGER NOT NULL DEFAULT 0
);

-- 禁じ手の門の通行手形（OTP）。
--
-- 機械層（guard）が止めたコマンドを、将軍の裁定で一度だけ通すための札。
-- 平文の札は発行の瞬間に一度だけ表示され、ここには写しのハッシュしか
-- 残らない。cmd_hash に紐づくゆえ、無害な件で札を取り危険な件に流用する
-- 手は通らない。
CREATE TABLE IF NOT EXISTS guard_otp (
  code_hash  TEXT PRIMARY KEY,          -- sha256(平文の札)
  cmd_hash   TEXT NOT NULL,             -- sha256(正規化したコマンド)
  agent      TEXT NOT NULL,             -- 使ってよい者
  issuer     TEXT NOT NULL,             -- 発行した者（将軍のみ）
  reason     TEXT NOT NULL,             -- なぜ通すのか
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,             -- 既定 10 分
  used_at    TEXT                       -- 一度使えば刻まれ、二度目は無い
);

-- 許状。手形（guard_otp・一つのコマンドに一回）と違い、cmd に縛られた多回券。
-- honden-bot 専用。的（repo・verb）と回数と刻で縛る。cmd が閉じれば即死ぬ。
CREATE TABLE IF NOT EXISTS guard_charter (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent      TEXT NOT NULL,             -- 使ってよい者
  cmd_id     TEXT NOT NULL,             -- この cmd の間だけ生きる
  repo       TEXT NOT NULL,             -- OWNER/REPO を名指し
  verb       TEXT NOT NULL CHECK (verb IN ('create','comment')),
  uses_left  INTEGER NOT NULL,          -- 残回数。尽きれば音を立てて落ちる
  issuer     TEXT NOT NULL,             -- 発行した者（将軍のみ）
  reason     TEXT NOT NULL,
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT                       -- 取り消し。刻まれれば以後使えぬ
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

/**
 * 既にある表へ列を足す。既にあれば何もしない。
 *
 * SQLite の ALTER に IF NOT EXISTS は無いので、table_info を引いてから足す。
 * 例外を握り潰す形にすると、別の理由で落ちたときに気づけない。
 */
function addColumn(db: Database, table: string, column: string, decl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(db: Database): void {
  db.run(SCHEMA);
  // 既に走っている正本のための追い足し。新しい正本は SCHEMA 側で足りている。
  addColumn(db, 'report', 'cmd_id', 'TEXT');
  addColumn(db, 'claim', 'source', "TEXT NOT NULL DEFAULT 'declared'");
  addColumn(db, 'cmd_acceptance', 'changed_at', 'TEXT');
  addColumn(db, 'report', 'origin', "TEXT NOT NULL DEFAULT 'native'");
  addColumn(db, 'inbox', 'origin', "TEXT NOT NULL DEFAULT 'native'");
  addColumn(db, 'nudge', 'reset_count', 'INTEGER NOT NULL DEFAULT 0');
  // 貸与の三欄。型へ足した折に**移行を書き忘れ**、先に建った正本では
  // `honden status` が「no such column: holder」で倒れておった
  // （本番の正本で実見・2026-08-29）。`CREATE TABLE IF NOT EXISTS` は
  // 既にある表を変えぬ——**型に足したら、ここにも足す。**
  // 抜けは test/store.test.ts が機械で数える。
  addColumn(db, 'task', 'holder', 'TEXT');
  addColumn(db, 'task', 'leased_at', 'TEXT');
  addColumn(db, 'task', 'lease_until', 'TEXT');

  // 受け入れ条件の番号を 1 始まりへ揃える。
  // 初期は配列の添字をそのまま入れており「条件 0」という言い方になっていた。
  // 主キーが (cmd_id, idx) ゆえ、その場で +1 すると途中で衝突する。
  // 読み出してから入れ直す。0 が一つも無ければ何もしない（何度走らせても同じ）。
  const zero = db.query('SELECT count(*) c FROM cmd_acceptance WHERE idx = 0').get() as { c: number };
  if (zero.c > 0) {
    const rows = db.query('SELECT cmd_id, idx, text FROM cmd_acceptance ORDER BY cmd_id, idx').all() as {
      cmd_id: string;
      idx: number;
      text: string;
    }[];
    db.run('DELETE FROM cmd_acceptance');
    const ins = db.prepare('INSERT INTO cmd_acceptance(cmd_id, idx, text) VALUES (?,?,?)');
    for (const r of rows) ins.run(r.cmd_id, r.idx + 1, r.text);
  }
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
/**
 * 引けなかったこと。
 *
 * 「0 件だった」と「引けなかった」を同じ形で返してはならない。
 * 記号だけの語で FTS5 の構文が壊れた時も、本当に何も無い時も 0 件では、
 * **探し方が悪いのか、無いのかが分からぬ**。
 */
export class SearchError extends Error {}

export function search(db: Database, query: string, limit = 50): Hit[] {
  let ids: number[];
  try {
    ids = (
      db.query('SELECT doc_id FROM doc_fts WHERE doc_fts MATCH ? LIMIT ?').all(
        segment(query),
        limit,
      ) as { doc_id: number }[]
    ).map((r) => r.doc_id);
  } catch (e) {
    // 検索語が FTS5 の構文として成立しない（記号だけ等）。
    // 0 件では返さない——無いことと引けぬことは違う。
    throw new SearchError(
      `検索語が引けぬ: ${JSON.stringify(query)}\n` +
        `  ${String(e).slice(0, 120)}\n` +
        '  記号だけの語や、FTS5 の演算子（AND OR NOT NEAR " * ^）が\n' +
        '  中途半端に混ざっておらぬか確かめられよ。',
    );
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
