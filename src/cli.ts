/**
 * honden の唯一の書き口。
 *
 * ## 入口は 2 つ、検査は 1 つ
 *
 * 各項を旗で渡してもよいし、その節の YAML を標準入力へ流してもよい。
 * どちらで入っても同じ検査を通る。通らなければ EOF 側が型の抜け道になる。
 *
 *   honden inbox write --to karo --type cmd_new --from shogun --body "短い用件"
 *
 *   honden inbox write <<'EOF'
 *   to: karo
 *   type: cmd_new
 *   from: shogun
 *   body: |
 *     長い本文。バックスラッシュも ''' も $ もそのまま通る。
 *   EOF
 *
 * EOF を引用符で囲めばシェルが一切手を触れない。旧 inbox_write.sh は本文を
 * Python のソースへ直に展開していたので、\n が黙って実改行に化け、Windows パスや
 * ''' を含む本文は送信そのものが失敗した。この形にすればその筋が消える。
 *
 * ## 終了コード
 *
 *   0  通った
 *   2  入力が受け付けられぬ (何が駄目かは stderr に全件出る。書き込みはしていない)
 *   1  それ以外の失敗
 */

import { openStore, tx, journal } from './store';
import { validate, explain, type Schema } from './validate';

export const EXIT_OK = 0;
export const EXIT_SYSTEM = 1;
export const EXIT_INVALID = 2;

const AGENTS = [
  'shogun', 'karo', 'gunshi',
  'ashigaru1', 'ashigaru2', 'ashigaru3', 'ashigaru4',
  'ashigaru5', 'ashigaru6', 'ashigaru7',
] as const;

/**
 * 相手が処理を知っている type だけ。新しい文字列を発明すると相手が黙り込む。
 * `clear_command` は相手のセッションを消すので、布陣外からは撃たせない。
 */
const TYPES = ['report_received', 'task_assigned', 'cmd_new', 'cmd_update', 'clear_command'] as const;

const INBOX_SCHEMA: Schema = {
  to: { required: true, oneOf: AGENTS, about: '宛先の agent' },
  // from は agent 名に縛らない。布陣外 (standalone) から送るときは、
  // 役職を騙らず review_session / external_audit のような名を使うのが正しい。
  // 縛ると、その正しい使い方を弾いてしまう。
  from: { required: true, about: '差出人。布陣外なら review_session など、役職を騙らぬ名' },
  type: { required: true, oneOf: TYPES, about: '相手が処理を知っている種別' },
  body: { required: true, about: '本文。長いものは EOF 側で渡すとよい' },
};

/** 差出人名として許す形。空白や制御文字を弾く。 */
const FROM_SHAPE = /^[A-Za-z0-9_-]{2,40}$/;

/** 旗を解く。`--k v` と `--k=v` の両方を受ける。 */
export function parseFlags(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[body] = 'true'; continue; }
    flags[body] = next;
    i++;
  }
  return { flags, rest };
}

export interface InputSource {
  /** 旗。--dry-run のような制御旗は除いてある。 */
  flags: Record<string, string>;
  /** 標準入力の中身。端末なら undefined。 */
  stdin?: string;
}

/**
 * 旗と EOF のどちらか一方を採る。
 *
 * 両方来たら弾く。黙って片方を優先すると、どちらが効いたのか撃った側に分からない。
 */
export function pickInput(src: InputSource): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const hasFlags = Object.keys(src.flags).length > 0;
  const hasStdin = src.stdin !== undefined && src.stdin.trim() !== '';

  if (hasFlags && hasStdin) {
    return {
      ok: false,
      message:
        '旗と標準入力の両方が来ておる。どちらが効いたのか分からなくなるゆえ、片方にされよ。\n' +
        '  長い本文なら EOF 側、短い更新なら旗が向いておる。',
    };
  }
  if (!hasFlags && !hasStdin) {
    return {
      ok: false,
      message:
        '入力が無い。旗で渡すか、その節の YAML を標準入力へ流されよ。\n' +
        "  例: honden inbox write --to karo --type cmd_new --from shogun --body '用件'\n" +
        "      honden inbox write <<'EOF'\n" +
        '        to: karo\n' +
        '        …\n' +
        '      EOF',
    };
  }
  if (hasStdin) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(src.stdin!);
    } catch (e) {
      return {
        ok: false,
        message:
          `標準入力が YAML として読めぬ: ${String(e).slice(0, 160)}\n` +
          "  EOF は引用符で囲まれておるか確かめられよ (<<'EOF')。囲まぬとシェルが本文へ手を入れる。",
      };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '標準入力は「鍵: 値」の形で書かれよ。一覧や素の値は受けられぬ。' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  }
  return { ok: true, value: { ...src.flags } };
}

/**
 * 旧 `inbox_write.sh` と同じ並び順の引数を受ける。
 *
 *   inbox_write.sh <target> <content> <type> <from>
 *   honden inbox write <target> <content> <type> <from>
 *
 * 既存の呼び出しと指示書がそのまま生きるように残す。ただし本文をシェルの
 * 引数に載せる形なので、引用符との戦いは残る。長い本文は EOF 側が向いている。
 *
 * 並び順の取り違えは、`to` と `from` が agent 名かどうかで拾える
 * (旧版は 4 つとも空でないかしか見ていなかった)。
 * `content` と `type` の入れ替わりまでは拾えないので、`--dry-run` で
 * 読み取り結果を見てから撃つのが確実になる。
 */
export function fromPositional(args: string[]): Record<string, string> | undefined {
  if (args.length !== 4) return undefined;
  const [to, body, type, from] = args as [string, string, string, string];
  return { to, body, type, from };
}

export interface RunResult {
  code: number;
  out?: string;
  err?: string;
}

export interface WriteContext {
  /** 布陣の中から呼ばれているか。tmux の外なら false。 */
  insideFormation: boolean;
}

/** `honden inbox write` の中身。 */
export function inboxWrite(
  dbPath: string | undefined,
  src: InputSource,
  dryRun: boolean,
  ctx: WriteContext = { insideFormation: true },
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };

  const problems = validate(INBOX_SCHEMA, picked.value);
  if (problems.length > 0) {
    return {
      code: EXIT_INVALID,
      err: explain(problems, "本文が長いなら <<'EOF' で流すと引用符に悩まされぬ。"),
    };
  }

  const v = picked.value as { to: string; from: string; type: string; body: string };

  if (!FROM_SHAPE.test(v.from)) {
    return {
      code: EXIT_INVALID,
      err:
        `差出人の名が使えぬ: ${JSON.stringify(v.from)}\n` +
        '  英数字・_・- で 2〜40 文字にされよ。\n' +
        '  布陣内なら agent 名、布陣外なら review_session のような名。\n' +
        '  書き込みは行っておらぬ。',
    };
  }

  // 布陣外から役職を騙るのを止める。
  //
  // 「騙るな」と書いておくだけでは止まらない。tmux の外にいるかどうかは
  // 機械で見えるので、見えるものは機械で止める。
  if (!ctx.insideFormation && (AGENTS as readonly string[]).includes(v.from)) {
    return {
      code: EXIT_INVALID,
      err:
        `布陣の外から ${v.from} を名乗ることはできぬ。\n` +
        '  布陣外だと分かる名を使われよ (review_session / external_audit / probe_session など)。\n' +
        '  受け取った側が、誰からの報せか判ずるために要る。\n' +
        '  書き込みは行っておらぬ。',
    };
  }

  // 布陣外から相手のセッションを消させない。
  if (!ctx.insideFormation && v.type === 'clear_command') {
    return {
      code: EXIT_INVALID,
      err:
        'clear_command は布陣の外から撃てぬ。相手のセッションを消すゆえ。\n' +
        '  用向きがあるなら家老へ report_received で伝え、判断を委ねられよ。\n' +
        '  書き込みは行っておらぬ。',
    };
  }

  // 自分宛は弾く。旧 inbox_write.sh も同じ guard を持っていた。
  // 項ごとの検査では拾えない (どちらの欄も単体では正しい) ので、ここで見る。
  if (v.to === v.from) {
    return {
      code: EXIT_INVALID,
      err:
        `自分宛には送れぬ (to と from がどちらも ${v.to})。\n` +
        '  宛先か差出人のどちらかが違っておらぬか。\n' +
        '  書き込みは行っておらぬ。',
    };
  }

  const at = new Date().toISOString();
  const id = `msg_${at.replace(/[-:.TZ]/g, '')}_${Bun.hash(v.body + at).toString(16).slice(0, 8)}`;
  const summary =
    `  宛: ${v.to}  差出: ${v.from}  種: ${v.type}\n` +
    `  本文 ${[...v.body].length} 文字 / ${v.body.replace(/\n$/, '').split('\n').length} 行\n` +
    `  ${v.body.split('\n')[0]?.slice(0, 60) ?? ''}`;

  if (dryRun) return { code: EXIT_OK, out: `${summary}\n  → 書き込んでおらぬ (--dry-run)` };

  const db = openStore({ path: dbPath });
  tx(db, () => {
    db.prepare(
      'INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)',
    ).run(id, v.to, at, v.type, v.from, v.body);
    journal(db, { actor: v.from, action: 'inbox.write', target: v.to, detail: v.type });
  });

  // 読み戻して見せる。
  //
  // 「送ったつもり」を潰すため。ここで出すのは渡した値ではなく、
  // 正本に入っている値そのもの。渡した値を出しても、化けていたら気づけない。
  //
  // ただし断っておくと、`intact` が false になる筋は試験で再現できていない。
  // bun:sqlite は NUL を含む文字列も往復で保つことを実測したので、
  // 「格納が意図と食い違う」場面を作れなかった。
  // これは検証済みの守りではなく、鳴らない前提の鳴子として置いてある。
  // 鳴ったらそれ自体が新しい発見になる。
  const back = db
    .query('SELECT agent, sender, msg_type, body, read FROM inbox WHERE id = ?')
    .get(id) as { agent: string; sender: string; msg_type: string; body: string; read: number } | null;
  if (!back) {
    return { code: EXIT_SYSTEM, err: `書き込んだはずの ${id} が読み戻せぬ。正本を確かめられよ。` };
  }
  const unread = (
    db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(v.to) as { c: number }
  ).c;
  const intact = back.body === v.body;
  return {
    code: EXIT_OK,
    out:
      `  宛: ${back.agent}  差出: ${back.sender}  種: ${back.msg_type}  未読: ${back.read === 0 ? 'はい' : 'いいえ'}\n` +
      `  本文 ${[...back.body].length} 文字 / ${back.body.replace(/\n$/, '').split('\n').length} 行` +
      `${intact ? '（渡した本文と一致）' : '  ★渡した本文と食い違う'}\n` +
      `  ${back.body.split('\n')[0]?.slice(0, 60) ?? ''}\n` +
      `  → ${id}\n` +
      `  ${v.to} の未読は ${unread} 件。反応が無ければ ${v.to} のペインで inbox${unread} と手打ちされよ。`,
  };
}

/** `honden inbox unread <agent>` — 手動 nudge のための未読数。 */
export function inboxUnread(dbPath: string | undefined, agent: string): RunResult {
  if (!(AGENTS as readonly string[]).includes(agent)) {
    return {
      code: EXIT_INVALID,
      err: `知らぬ agent: ${JSON.stringify(agent)}\n  ${AGENTS.join(' / ')} のいずれか。`,
    };
  }
  const db = openStore({ path: dbPath });
  const n = (
    db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(agent) as { c: number }
  ).c;
  return {
    code: EXIT_OK,
    out: `  ${agent} の未読 ${n} 件${n > 0 ? ` → 手動 nudge は inbox${n}` : ''}`,
  };
}

const USAGE = `honden — 多エージェント運用の差配層

  honden inbox write <宛先> <本文> <種別> <差出人>          旧 inbox_write.sh と同じ並び
  honden inbox write --to A --from B --type T --body 本文
  honden inbox write <<'EOF'
    to: karo
    from: shogun
    type: cmd_new
    body: |
      本文
  EOF

  honden inbox unread <agent>                              手動 nudge 用の未読数

  --dry-run  読み取り結果だけ見せて書き込まない
  --db PATH  正本の場所 (既定 ~/.honden/honden.db)

並び順・旗・標準入力は、どれか一つを使う。二つ以上渡すと弾かれる。
長い本文は EOF が向いておる。シェルが引用符に手を入れぬゆえ。

布陣の外 (TMUX_PANE が無い) から送るときは、役職を騙れぬ。
review_session / external_audit のような、外だと分かる名を from に使うこと。
`;

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  const dryRun = flags['dry-run'] === 'true';
  delete flags['dry-run'];
  const dbPath = flags['db'];
  delete flags['db'];

  const stdin = process.stdin.isTTY ? undefined : await Bun.stdin.text();

  if (rest[0] === 'inbox' && rest[1] === 'write') {
    // 旧 inbox_write.sh と同じ並びで来た場合は旗へ寄せる。
    const positional = fromPositional(rest.slice(2));
    if (positional && Object.keys(flags).length > 0) {
      console.error(
        '並び順の引数と旗の両方が来ておる。どちらが効いたのか分からなくなるゆえ、片方にされよ。',
      );
      return EXIT_INVALID;
    }
    if (rest.length > 2 && !positional) {
      console.error(
        `並び順で渡すなら 4 つ要る (受け取ったのは ${rest.length - 2} つ)。\n` +
          '  honden inbox write <宛先> <本文> <種別> <差出人>\n' +
          '  旗や EOF でも渡せる。書き込みは行っておらぬ。',
      );
      return EXIT_INVALID;
    }
    const insideFormation = (process.env.TMUX_PANE ?? '') !== '';
    const r = inboxWrite(dbPath, { flags: positional ?? flags, stdin }, dryRun, { insideFormation });
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.code;
  }

  if (rest[0] === 'inbox' && rest[1] === 'unread') {
    const r = inboxUnread(dbPath, rest[2] ?? '');
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.code;
  }

  console.error(USAGE);
  return EXIT_INVALID;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
