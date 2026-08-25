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
import { roster, isEmpty } from './roster';
import { validate, explain, type Schema } from './validate';

export const EXIT_OK = 0;
export const EXIT_SYSTEM = 1;
export const EXIT_INVALID = 2;

// 名簿は固定で持たない。環境ごとに足軽の頭数が違う (src/roster.ts)。

/**
 * 相手が処理を知っている type だけ。新しい文字列を発明すると相手が黙り込む。
 * `clear_command` は相手のセッションを消すので、布陣外からは撃たせない。
 *
 * skills/external-to-shogun は「実在する type は 5 種類のみ」と書いているが、
 * 実データには report_completed が 5 件ある（2026-08-25 実測・全 145 件を集計）。
 * 文書ではなくデータに合わせる。
 */
const TYPES = [
  'report_received',
  'report_completed',
  'task_assigned',
  'cmd_new',
  'cmd_update',
  'clear_command',
] as const;

const inboxSchema = (known: readonly string[]): Schema => ({
  to: { required: true, oneOf: known, about: '宛先の agent' },
  // from は agent 名に縛らない。布陣外 (standalone) から送るときは、
  // 役職を騙らず review_session / external_audit のような名を使うのが正しい。
  // 縛ると、その正しい使い方を弾いてしまう。
  from: { required: true, about: '差出人。布陣外なら review_session など、役職を騙らぬ名' },
  type: { required: true, oneOf: TYPES, about: '相手が処理を知っている種別' },
  body: { required: true, about: '本文。長いものは EOF 側で渡すとよい' },
});

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
  // 断っておくと、main.ts は旗が来ているとき標準入力を読まない
  // （端末でない環境で永久に待つのを避けるため）。ゆえに実運用で
  // 「両方来た」が起きるのは、旗が無く標準入力だけがある筋に限られる。
  // ここの検査は、関数を直に呼ぶ場合と将来のために残してある。
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
  /**
   * 呼び出し元が誰であるか。引数ではなく環境から取った値を渡すこと。
   *
   * `.opencode/tools/mark-as-read.ts` の assertCurrentAgent と同じ考え。
   * あちらは `OPENCODE_AGENT_ID` を読み、他人の inbox を触ろうとしたら拒む。
   * 名乗りを引数に任せると、名乗りは検査にならない。
   *
   * 布陣の中に居るのに誰か分からないときは undefined。そのときは書かせない。
   */
  selfId?: string;
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

  const db = openStore({ path: dbPath });
  if (isEmpty(db)) {
    return {
      code: EXIT_INVALID,
      err:
        '名簿が空である。誰が居るのか分からぬまま送ることはできぬ。\n' +
        '  honden roster sync --settings <settings.yaml> で入れられよ。\n' +
        '  書き込みは行っておらぬ。',
    };
  }
  const known = roster(db).map((e) => e.id);

  const problems = validate(inboxSchema(known), picked.value);
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

  // 布陣の中では、名乗りが環境と一致していること。
  //
  // 名乗りを引数に任せると、名乗りは検査にならない。足軽3号が karo を名乗れる。
  // 環境から取った値と突き合わせて初めて、名乗りが証しになる。
  if (ctx.insideFormation) {
    if (!ctx.selfId) {
      return {
        code: EXIT_INVALID,
        err:
          '布陣の中に居るが、誰であるか確かめられぬ。\n' +
          '  HONDEN_AGENT_ID を置くか、pane の @agent_id を設定されよ。\n' +
          '  名乗りを引数だけに任せると、名乗りが検査にならぬ。\n' +
          '  書き込みは行っておらぬ。',
      };
    }
    if (ctx.selfId !== v.from) {
      return {
        code: EXIT_INVALID,
        err:
          `${ctx.selfId} が ${v.from} を名乗ることはできぬ。\n` +
          `  この pane の主は ${ctx.selfId} である。\n` +
          '  他人の名で送ると、受け取った側が誰からの報せか判じられぬ。\n' +
          '  書き込みは行っておらぬ。',
      };
    }
  }

  // 布陣外から役職を騙るのを止める。
  //
  // 「騙るな」と書いておくだけでは止まらない。tmux の外にいるかどうかは
  // 機械で見えるので、見えるものは機械で止める。
  if (!ctx.insideFormation && known.includes(v.from)) {
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
  const db = openStore({ path: dbPath });
  const known = roster(db).map((e) => e.id);
  if (known.length === 0) {
    return { code: EXIT_INVALID, err: '名簿が空である。honden roster sync で入れられよ。' };
  }
  if (!known.includes(agent)) {
    return {
      code: EXIT_INVALID,
      err: `名簿に無い agent: ${JSON.stringify(agent)}\n  いま居るのは ${known.join(' / ')}。`,
    };
  }
  const n = (
    db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(agent) as { c: number }
  ).c;
  return {
    code: EXIT_OK,
    out: `  ${agent} の未読 ${n} 件${n > 0 ? ` → 手動 nudge は inbox${n}` : ''}`,
  };
}
