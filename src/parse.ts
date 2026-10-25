/**
 * 命を構文で解いた形を受け取る。芯は `core/guard`（Rust・brush-parser）。
 *
 * # なぜ紋様から離れるか
 *
 * 門は生の文字列を紋様で当てておった。四度継ぎを当てて限界が見えた
 * （`docs/decisions.md` 十八）。最後の一枚が最も雄弁である——
 * **引用の中の字面が、命と区別できなんだ**。決め書きを書く手が、その中の
 * 危うい字面に当たって己の門に弾かれた（将軍が二度）。
 *
 * 構文を解けば一目で分かる。`echo "rm -rf /"` の `rm` は命令位置に居らぬ。
 *
 * # ここは**必ず拒みへ倒れる**
 *
 * 解けぬ・畳めぬ・道具が無い・落ちた・返事が読めぬ——**全て同じ一つの型**
 * （`ok: false` と理由）に畳んである。呼ぶ側が「この場合は通してよいか」と
 * 迷う余地を残さぬため。
 *
 * 迷う余地があれば、いつか誰かが通す。**新しい層は fail-open として生まれる**
 * ——本日そう四度書いた。型で塞ぐのが最も確かである。
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** 語ひとつの素性。**引用されておるか**が最も重い。 */
export interface Word {
  /** 書かれたままの姿（引用も含む） */
  text: string;
  /**
   * **引用を剥いだ値。掟はこちらに照らす。**
   *
   * `rm -rf "/"` は `rm -rf /` と同じ害であり、引用したからとて赦されぬ。
   * 展開（`$X` / `$(…)`）は走らせるまで判らぬゆえ、書かれたまま残る。
   */
  value: string;
  /** 語の全体が引用に包まれておる。引用の中の `rm` は命ではない */
  quoted: boolean;
  /** 引用の外に `*` `?` `[` がある */
  glob: boolean;
  /** 引用の外に変数展開がある（中身は走らせるまで判らぬ） */
  var: boolean;
  /** 命令置換を含む */
  cmdsubst: boolean;
}

/** 単純命令ひとつ。`argv[0]` が命令位置である。 */
export interface Cmd {
  argv: Word[];
  assigns: string[];
  /** 標準入力の出所（解き手が返す）。無ければ端末か、何も繋がっておらぬ */
  stdin?: Stdin;
  /**
   * この命が script として走らせる file（`bash x.sh`・`source x.sh`・`. x.sh`・`bash <(cat x.sh)`）。
   * 道に展開が在れば dynamic。門が読んで、中身を命として判ずる
   */
  script?: { path: string; dynamic: boolean; sourced: boolean; proc: boolean; posix: boolean };
}

/** 標準入力の出所。`< file`・`cat file |` は file、heredoc や字どおりの管は text。 */
export type Stdin = { file: string } | { text: string } | { opaque: true };

export type Parsed =
  | {
      ok: true;
      commands: Cmd[];
      /** heredoc の中身。**命令位置には決して入らぬ** */
      heredocs: string[];
      /** 命令置換の中身。要れば再帰して解ける */
      substitutions: string[];
      /**
       * shell が標準入力から命として読むのに、その字が観測できぬ物
       * （`… | base64 -d | sh`・`sh < file`・`sh <<<"$X"`）。**在れば拒む**
       */
      opaque: string[];
      /** 向き替えで書く先（`>`・`>>`）。同じ命の中で作られる file を見分けるため */
      writes: string[];
      /**
       * shell が標準入力から命として読む file の道（`bash < f`・`cat f | sh`・
       * `ssh h 'bash -s' < f`）。門が読んで、中身を命として判ずる
       */
      shellFiles: string[];
      /** `cat > f <<'EOF' … EOF` で書く file と本文。書いてから走らせる script を、門が本文で判ずる */
      writtenTexts: { path: string; text: string }[];
    }
  | { ok: false; reason: string };

/** 解く手。試験では贋物を注ぐ（`identity.ts` の lookup と同じ流儀）。 */
export type Runner = (input: string) => { ok: boolean; stdout: string };

export function parserPath(root: string): string {
  return join(root, 'bin', 'honden-parse');
}

/**
 * 実物の手。**道具が無ければ拒みへ倒れる**——「無いから素通し」は
 * 見張りが黙って消える型そのもの。
 */
export function realRunner(root: string): Runner {
  return (input: string) => {
    const bin = parserPath(root);
    if (!existsSync(bin)) return { ok: false, stdout: '' };
    try {
      const p = Bun.spawnSync([bin], { stdin: Buffer.from(input) });
      return { ok: p.success, stdout: new TextDecoder().decode(p.stdout) };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
}

/** 芯が返す生の形。ここでしか使わぬ。 */
interface Raw {
  ok: boolean;
  error?: string;
  complete?: boolean;
  commands?: { argv?: Partial<Word>[]; assigns?: string[]; stdin?: unknown; script?: unknown }[];
  heredocs?: string[];
  substitutions?: string[];
  unhandled?: string[];
  opaque?: string[];
  writes?: string[];
  shell_files?: string[];
  written_texts?: { path?: unknown; text?: unknown }[];
}

/** 語の素性は**欠けたら真**に倒す——「印が無い」を「安全」と読まぬため。 */
function word(w: Partial<Word> | undefined): Word {
  const text = typeof w?.text === 'string' ? w.text : '';
  return {
    text,
    // 値が無ければ書かれたままを使う。**掟が何も見ぬ状態にはせぬ。**
    value: typeof w?.value === 'string' ? w.value : text,
    quoted: w?.quoted !== false,
    glob: w?.glob !== false,
    var: w?.var !== false,
    cmdsubst: w?.cmdsubst !== false,
  };
}

/**
 * 芯の返事を型へ畳む。**読めぬ返事は拒み。**
 *
 * `complete: false`（畳めぬ部分がある）も拒みに落とす。中途半端な argv を
 * 全体と思うて掟に照らせば、隠れた命が門の外を素通りする——
 * 成功の顔をした fail-open になる。
 */
export function interpret(ok: boolean, stdout: string): Parsed {
  if (!ok) return { ok: false, reason: '構文の解き手が応えぬ（bin/honden-parse が無いか落ちた）' };
  let raw: Raw;
  try {
    raw = JSON.parse(stdout) as Raw;
  } catch {
    return { ok: false, reason: '構文の解き手の返事を読めぬ' };
  }
  if (raw.ok !== true) {
    return { ok: false, reason: `命を構文で解けぬ: ${raw.error ?? '（理由不明）'}` };
  }
  if (raw.complete !== true) {
    const why = (raw.unhandled ?? []).join(' / ') || '（内訳不明）';
    return { ok: false, reason: `解けたが畳めぬ部分がある: ${why}` };
  }
  return {
    ok: true,
    commands: (raw.commands ?? []).map((c) => ({
      argv: (c.argv ?? []).map(word),
      assigns: Array.isArray(c.assigns) ? c.assigns : [],
      stdin: stdinOf(c.stdin),
      script: scriptOf(c.script),
    })),
    heredocs: Array.isArray(raw.heredocs) ? raw.heredocs : [],
    substitutions: Array.isArray(raw.substitutions) ? raw.substitutions : [],
    opaque: Array.isArray(raw.opaque) ? raw.opaque : [],
    writes: Array.isArray(raw.writes) ? raw.writes : [],
    shellFiles: Array.isArray(raw.shell_files) ? raw.shell_files : [],
    writtenTexts: Array.isArray(raw.written_texts)
      ? raw.written_texts.flatMap((w) =>
          typeof w?.path === 'string' && typeof w?.text === 'string' ? [{ path: w.path, text: w.text }] : [],
        )
      : [],
  };
}

/** 返事の script を型へ畳む。道が字でなければ無いと読まず、展開に依ると倒す。 */
function scriptOf(v: unknown): Cmd['script'] {
  if (v === null || v === undefined || typeof v !== 'object') return undefined;
  const o = v as { path?: unknown; dynamic?: unknown; sourced?: unknown; proc?: unknown; posix?: unknown };
  if (typeof o.path !== 'string') return { path: '', dynamic: true, sourced: false, proc: false, posix: false };
  return {
    path: o.path,
    dynamic: o.dynamic !== false,
    sourced: o.sourced === true,
    proc: o.proc === true,
    posix: o.posix !== false,
  };
}

/** 返事の stdin を型へ畳む。**読めぬ形は opaque に倒す**——「無い」と読まぬため。 */
function stdinOf(v: unknown): Stdin | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.file === 'string') return { file: o.file };
    if (typeof o.text === 'string') return { text: o.text };
  }
  return { opaque: true };
}

export function parseCommand(cmd: string, run: Runner): Parsed {
  const r = run(cmd);
  return interpret(r.ok, r.stdout);
}

/**
 * 命令位置に立つ語だけを返す。掟の多くはここだけ見れば足りる。
 *
 * 引用された語は**命ではない**ゆえ除く——`echo "rm -rf /"` の `rm` を
 * 命と数えたのが、これまでの誤検知の源であった。
 */
export function commandNames(p: Parsed): string[] {
  if (!p.ok) return [];
  const out: string[] = [];
  for (const c of p.commands) {
    const head = c.argv[0];
    if (head && !head.quoted && head.text !== '') out.push(head.text);
  }
  return out;
}

/**
 * 掟を照らす単位を組む。
 *
 * # なぜ「単位」なのか
 *
 * 紋様の錨 `(?:^|[;&|]\s*)` は命令位置の**近似**にすぎず、実測で六つ破れた
 * （2026-08-30）——改行・`if … then`・`$( )`・`for … do`・`{ … }` の中では
 * 絶対域の D001 すら素通りしておった。
 *
 * 構造なら近似が要らぬ。**単純命令ひとつを一つの単位**として渡せば、
 * その先頭が命令位置そのものである。紋様は書き換えずに済み、
 * 錨がただ本物になる。
 *
 * 値は引用を剥いだもの（`rm -rf "/"` → `rm -rf /`）。
 */
export function units(p: Parsed): string[] {
  if (!p.ok) return [];
  return p.commands
    .map((c) => c.argv.map((w) => w.value).join(' ').trim())
    .filter((u) => u !== '');
}

/**
 * 命令置換の中身は**別の命**である。門は再帰して解く。
 *
 * `x=$(rm -rf /)` が素通りしておった筋がこれ（実測）。深さは限る——
 * 際限なく潜れば、細工された入力で門が止まる。
 */
export function substUnits(p: Parsed, run: Runner, depth = 2): string[] {
  if (!p.ok || depth <= 0) return [];
  const out: string[] = [];
  withCtx(p, () => {
    for (const s of p.substitutions) {
      const inner = parseCommand(s, run);
      out.push(...units(inner), ...looseExecUnits(inner, run), ...substUnits(inner, run, depth - 1));
    }
  });
  return out;
}

/**
 * 解いた中身の、実際に走る命（execUnits）。**解けぬ所があっても拒まぬ。**
 *
 * 置換と heredoc の中身は、これまで argv を繋いだ字（units）だけを掟に照らして
 * おった。門が錨の付く紋様を argv の頭だけに当てるなら、中の `sh -c 'a; …'` や
 * `eval '…'` まで降りねば、偶々止まっておった形が抜ける。展開に依る中身を拒みに
 * 倒すと、今は通る日常の形（`x=$($CMD)` 等）まで止めるゆえ、解けた分だけを足す。
 */
function looseExecUnits(p: Parsed, run: Runner): string[] {
  return execUnits(p, run).units;
}

/**
 * heredoc の中身を掟に照らすか。
 *
 * **貰い手による。** `python3 <<EOF` の中身は python への文字であって命ではない
 * ——将軍が己の門に二度弾かれたのがこの形。だが `bash <<EOF` の中身は**命**で
 * あり、照らさねば素通りする。
 *
 * 構文では見分けられぬ（`docs/decisions.md` 十八の「AST でも買えぬもの」）。
 * ゆえに貰い手の名で決める。名簿は短く、明示で持つ。
 */
export const SHELLS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'source', '.',
  // 名の表の漏れ（`fish -c '…'`・`csh -c '…'` が素通りしておった）
  'ash', 'mksh', 'csh', 'tcsh', 'fish', 'posh', 'yash', 'rbash', 'pdksh', 'oksh',
]);

export function heredocUnits(p: Parsed, run: Runner): string[] {
  if (!p.ok || p.heredocs.length === 0) return [];
  const toShell = p.commands.some((c) => {
    const head = c.argv[0];
    if (!head) return false;
    const base = head.value.split('/').pop() ?? head.value;
    return SHELLS.has(base);
  });
  if (!toShell) return [];
  const out: string[] = [];
  withCtx(p, () => {
    for (const h of p.heredocs) {
      const inner = parseCommand(h, run);
      out.push(...units(inner), ...looseExecUnits(inner, run));
    }
  });
  return out;
}

/**
 * **後で実行される命**を取り出す。
 *
 * # なぜ `units` では足りぬか
 *
 * `units` は解析器が返した単純命令をそのまま並べる。だが命の中には、
 * **別の命を起こすもの**がある。
 *
 * ```
 * sh -c 'rm -rf /'              引用の中は文字ではなく命である
 * find /tmp -exec rm -rf / \;   -exec の後ろは命である
 * env -i rm -rf /               包み。中の命が本体
 * chroot / rm -rf /             同上
 * ```
 *
 * `units` はこれらを一つの命として返し、門は `sh` や `find` を見て通す。
 * 実測（2026-09-01・二度目の監査が釣った）——`sh -c '…'`、`bash -lc '…'`、
 * `chroot / …`、`flock /tmp/x …`、`find -exec …`、`ssh host '…'`、
 * いずれも**素通りしておった**。
 *
 * # 名の一覧で追うのをやめる
 *
 * 一度目の直しでは「包みの名」を数えて剥がした。**筋が違った。**
 * 問いは「これは包みか」ではなく、**「この語は、後で命として実行されるか」**
 * である。名を増やしても追いつかぬ。
 *
 * ゆえに**包みごとに旗を正しく読み**、命の位置に来た語を取り出し、
 * 文字列として渡される命（`-c` の後ろ）は**解き直して再帰する**。
 *
 * # 解けぬなら通さぬ
 *
 * 命の名が変数や命令置換なら（`$SHELL -c …`、`${CMD:-rm} …`）、走らせるまで
 * 判らぬ。**判らぬ物は拒む。** 深さや数の上限に達した時も同じ——
 * 一度目の直しは上限に達したら通しており、無害な候補で枠を食い潰す形で
 * 素通りできた（実測）。
 */
export interface ExecScan {
  /** 実際に走る命（argv を空白で繋いだ形） */
  units: string[];
  /** Shell input that could not be structurally inspected; apply legacy patterns. */
  legacy?: string[];
  /** 解けなんだ理由。**在れば拒む** */
  unresolved?: string;
  /**
   * file（shell へ流す file・当てる patch）を読めなんだ理由。unresolved にも入る。命令置換の
   * 中身は解けぬ所を拒まずに照らすが、file を読めぬ形だけは拒む（execUnitsInner が拾う）
   */
  fileUnresolved?: string;
  /** Opaque shell streams remain unresolved across tolerant wrapper scans. */
  opaqueUnresolved?: string;
  /**
   * 門が読んだ file の中身の命。命の数の上限（MAX_UNITS）に数えぬよう units とは別に積み、
   * execUnits の終わりに units へ足す。大きな script の中身で、後ろの命が「多すぎる」に落ちぬため
   */
  fromFiles?: string[];
}

/** 名から道を落とす。`/bin/rm` → `rm`。 */
export function baseName(w: string): string {
  const i = w.lastIndexOf('/');
  return i < 0 ? w : w.slice(i + 1);
}

/**
 * 包みの仕様。**旗をどう読むかを、包みごとに書く。**
 *
 * `value`: 値を一つ取る旗。`pos`: 命の前に来る位置引数の数。
 *
 * 一度目の直しは「包みの後にある命らしき語すべて」を候補にした。
 * 乱暴すぎた——`env echo rm -rf /` を止めてしまう（`echo` の引数にすぎぬ）。
 * **旗を正しく読めば、命の位置は一つに定まる。**
 */
const WRAP: Record<string, { value?: string[]; pos?: number; scriptFlag?: string; script?: 'rest' }> = {
  env: { value: ['-u', '--unset', '-C', '--chdir', '--argv0', '-S', '--split-string'] },
  command: {},
  builtin: {},
  exec: { value: ['-a'] },
  nohup: {},
  setsid: {},
  doas: { value: ['-u'] },
  stdbuf: { value: ['-i', '-o', '-e'] },
  nice: { value: ['-n'] },
  ionice: { value: ['-c', '-n', '-p', '-P', '-u'] },
  time: { value: ['-f', '--format', '-o', '--output'] },
  watch: { value: ['-n', '--interval'] },
  unshare: {
    value: ['--map-user', '--map-group', '--map-groups', '--map-users', '--setuid', '--setgid',
      '--propagation', '--wd', '-S', '-G', '-R', '--root'],
  },
  xargs: {
    value: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-e', '--eof', '-I', '-i', '--replace',
      '-L', '-l', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars',
      '--process-slot-var'],
  },
  parallel: { value: ['-j', '-N', '--jobs'] },
  // 中身を見られぬまま別の命を起こす物。**値を取る旗を書き漏らせば、
  // 真の命を飛ばして素通りする**（`ssh -J jump host '…'` がそれであった・
  // 三度目の監査 2026-09-01）。man に照らして並べた。
  setarch: { pos: 1 },
  taskset: { value: ['-c', '-p'] },
  // `-m` `-u` `-n` の類は値を**取らぬ**のが常（任意引数）。値を取る側に
  // 入れると次の語を食い、真の命を飛ばす（実測 2026-09-01）
  nsenter: { value: ['-t', '--target', '-S', '--setuid', '-G', '--setgid', '--wd', '--wdns'] },
  'systemd-run': {
    value: ['-p', '--property', '-u', '--unit', '--on-calendar', '--on-active', '--slice',
      '--uid', '--gid', '-E', '--setenv', '--working-directory'],
  },
  strace: { value: ['-o', '-e', '-p', '-s', '-E', '-u'] },
  ltrace: { value: ['-o', '-e', '-p', '-s', '-u'] },
  // busybox は applet 名を位置引数に取る。`busybox sh -c '…'` は shell である
  // ——`pos: 1` で飛ばすと applet ごと見失う。飛ばさず、applet を命として辿る
  busybox: {},
  script: { value: ['-o', '--log-out', '-I', '-B', '-T', '--timing'], scriptFlag: '-c' },
  // 位置引数を一つ食ってから命が来る
  timeout: {
    value: ['-s', '--signal', '-k', '--kill-after'],
    pos: 1,
  },
  chroot: { value: ['--userspec', '--groups'], pos: 1 },
  flock: {
    value: ['-w', '--timeout', '-E', '--conflict-exit-code'],
    pos: 1,
    scriptFlag: '-c',
  },
  runuser: { value: ['-u', '-g', '-G', '-s', '--shell'], scriptFlag: '-c' },
  ssh: {
    // man ssh の値を取る短旗を並べた。**`-J` を落としていて素通りした。**
    value: ['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
      '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'],
    pos: 1,
    script: 'rest',
  },
};

const MAX_UNITS = 64;

/** 文字列で渡された命を解き直して降りる。 */
function descendScript(w: Word, run: Runner, depth: number, out: ExecScan): void {
  // 字に展開が在っても、書かれた字のまま解いて降りる。命の名そのものが展開に依れば
  // （`sh -c "$X"`・`sh -c "$(…) …"`）、resolveArgv が「命の名が展開に依っておる」として
  // 拒む。引数に変数が在るだけの形（`ssh h "cat > /tmp/$f"`）は、直に打った時と同じ判じに
  // なる。前は字に展開が在るだけで丸ごと拒んでおったが、`ssh -o K=V host …` の `K=V` を
  // 代入と取る読み違いで遠方の命を host と読み、偶々通っておった形が、読み違いを直すと
  // 止まるようになった
  const inner = parseCommand(w.value, run);
  if (!inner.ok) {
    out.unresolved = out.unresolved ?? `走らせる文字列を解けぬ（${inner.reason}）`;
    return;
  }
  // 中で読む file と、中で書く file も見る（`ssh h 'printf … > f.sh; bash < f.sh'`）
  withCtx(inner, () => execUnitsInner(inner, run, depth - 1, out));
}

/**
 * 後で shell に読まれ**うる**字を、緩く解き直して降りる。
 *
 * # なぜ要るか
 *
 * 門は錨の付く紋様を、単純命令ごとの argv の頭に当てる。引用の中の `;` `|` `&` は
 * 命の切れ目ではないゆえ、`grep 'a|kill'` は止めぬ。だが**中身を shell が読む語**
 * （`eval '…'`・`ssh host '…' '…'`・`docker exec c sh -c '…'`・`tmux new-window '…'`・
 * `git -c alias.x='!…'`・`env -S '…'`）の中の `;` は、走る時に命の切れ目になる。
 * 錨が生の字に当たっておった頃は、これらが偶々止まっておった。頭だけに当てるなら、
 * 中身を解いて降りねば穴が開く。
 *
 * # 緩く、とは
 *
 * descendScript と違い、展開に依る字や解けぬ字は legacy へ集め、旧い紋様で照らす。
 * 構造だけを理由には拒まぬ。
 * 中身を shell が読むか判じきれぬ語（`git -c` の値・`tmux` の引数）も通るゆえ、
 * ここで拒めば日常の往来（`eval "$(ssh-agent -s)"` など）を止める。今の門もこれらを
 * 解かずに通しておった——緩く降りるのは、偶々の守りを本物の守りへ移すためである。
 */
function descendLoose(
  text: string,
  run: Runner,
  depth: number,
  out: ExecScan,
  afterFirst = false,
): void {
  if (text.trim() === '') return;
  if (depth <= 0) {
    (out.legacy ??= []).push(text);
    return;
  }
  const inner = parseCommand(text, run);
  if (!inner.ok) {
    (out.legacy ??= []).push(text);
    return;
  }
  const sub: ExecScan = { units: [] };
  checkOpaque(inner, sub);
  if (inner.substitutions.length > 0 || inner.opaque.length > 0) (out.legacy ??= []).push(text);
  // afterFirst: 字の頭の命は照らさず、命の切れ目の後ろの命だけを照らす。中身を shell が
  // 読むか判じきれぬ語（script へ渡す引数・coder ssh の命）に使う。今の門はこれらの字の
  // 頭の命を通し、切れ目の後ろの命だけを（引用の中の `;` に錨が当たって）止めておった。
  // 頭まで照らすと、遠方で打つ `kill` の類が新たに止まり、絶対域ゆえ直訴もできぬ
  withCtx(inner, () => {
    for (const c of afterFirst ? inner.commands.slice(1) : inner.commands) {
      resolveArgv(c.argv, run, depth - 1, sub);
    }
    if (!afterFirst) for (const f of inner.shellFiles) descendShellFile(f, run, depth - 1, sub);
  });
  out.units.push(...sub.units, ...(sub.fromFiles ?? []));
  (out.legacy ??= []).push(...(sub.legacy ?? []));
  propagateOpaque(sub, out);
  if (sub.unresolved) (out.legacy ??= []).push(text);
}

function descendWords(ws: Word[], run: Runner, depth: number, out: ExecScan, afterFirst = false): void {
  const text = ws.map((w) => w.value).join(' ');
  if (literal(ws)) descendLoose(text, run, depth, out, afterFirst);
  else (out.legacy ??= []).push(text);
}

/** 語がすべて字面のままか（変数も命令置換も含まぬ）。 */
function literal(ws: Word[]): boolean {
  return ws.every((w) => !w.var && !w.cmdsubst);
}

/** shell の `-c` の束（`-c` `-lc` 等）か。resolveArgv の SHELLS の判じと同じ。 */
function isShellCFlag(w: Word): boolean {
  return !w.quoted && /^-[a-z]{1,4}$/.test(w.value) && w.value.includes('c');
}

/** 中身を shell が読む tmux の副命令（最後の引数が shell の命）。 */
const TMUX_SHELL_SUB = new Set([
  'new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw', 'display-popup', 'popup',
]);
/** その副命令で値を取る旗。値は命として降りぬ。 */
const TMUX_VALUE_FLAGS = new Set(['-c', '-e', '-F', '-n', '-s', '-t', '-x', '-y', '-l', '-p', '-S', '-T', '-w', '-h']);

/**
 * 命の名だけでは包みと判じられぬが、argv の中に shell の文字列を抱える形を緩く降りる。
 *
 * - argv の中ほどに shell と `-c` の束が並ぶ（`docker exec c sh -c '…'`・
 *   `kubectl exec p -- sh -c '…'`）
 * - `tmux new-window '…'` の類
 * - `git -c key=value` の値（`alias.x=!…`・`core.pager=…` は shell が読む）
 */
function descendEmbedded(name: string, argv: Word[], run: Runner, depth: number, out: ExecScan): void {
  for (let k = 1; k < argv.length; k++) {
    const shell = baseName(argv[k]!.value);
    if (!SHELLS.has(shell) || shell === 'eval' || shell === 'source' || shell === '.') continue;
    const ci = argv.findIndex((w, i) => i > k && isShellCFlag(w));
    const script = ci >= 0 ? argv[ci + 1] : undefined;
    if (script) descendWords([script], run, depth, out);
    break;
  }

  if (name === 'tmux') {
    const s = argv.findIndex((w, i) => i > 0 && TMUX_SHELL_SUB.has(w.value));
    if (s >= 0) {
      for (let i = s + 1; i < argv.length; i++) {
        const v = argv[i]!.value;
        if (v.startsWith('-')) {
          if (TMUX_VALUE_FLAGS.has(v)) i++;
          continue;
        }
        descendWords([argv[i]!], run, depth, out);
      }
    }
  }

  // `coder ssh <workspace> [--] '<命>'` は ssh と同じく、残りを遠方の shell が読む
  if (name === 'coder' && argv[1]?.value === 'ssh') {
    const dd = argv.findIndex((w, i) => i > 1 && w.value === '--');
    let rest: Word[];
    if (dd >= 0) {
      rest = argv.slice(dd + 1);
    } else {
      const ws = argv.findIndex((w, i) => i > 1 && !w.value.startsWith('-'));
      rest = ws >= 0 ? argv.slice(ws + 1) : [];
    }
    if (rest.length > 0) {
      descendWords(rest, run, depth, out, true);
    }
  }

  if (name === 'git') {
    for (let i = 1; i + 1 < argv.length; i++) {
      if (argv[i]!.value !== '-c') continue;
      if (!literal([argv[i + 1]!])) {
        (out.legacy ??= []).push(argv[i + 1]!.value);
        continue;
      }
      const v = argv[i + 1]!.value;
      const eq = v.indexOf('=');
      if (eq >= 0) descendLoose(v.slice(eq + 1).replace(/^!/, ''), run, depth, out);
    }
  }
}

// ── 箱の中の命（docker・podman・kubectl） ──

/** 値を取る旗。命の位置を一つに定めるため（WRAP と同じ流儀）。 */
const BOX_VALUES: Record<string, string[]> = {
  exec: ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys'],
  run: [
    '-e', '--env', '-u', '--user', '-w', '--workdir', '-v', '--volume', '-p', '--publish', '--name',
    '--network', '--net', '--entrypoint', '--mount', '-m', '--memory', '--env-file', '-l', '--label',
    '-h', '--hostname', '--add-host', '--cpus', '--gpus', '--platform', '--pull', '--restart', '--device',
    '--ulimit', '--log-driver', '--tmpfs', '--cap-add', '--cap-drop', '--security-opt', '--ipc', '--pid',
    '--shm-size', '--workdir', '--cidfile', '--dns', '--group-add', '--expose', '--link',
  ],
  kubectl: ['-c', '--container', '-n', '--namespace', '--context', '--kubeconfig', '-f', '--filename'],
};

/**
 * 箱の中で走る命の argv。`docker exec c kill 1` の `kill 1`。
 *
 * **ssh と同じく、中の命を照らす。** 箱の中の命は手元の同じ機で走り、箱が陣の土台
 * （共有の db など）であることも在る。coder ssh の命は字の頭を照らさぬ（遠方の kill が
 * 絶対域で止まり、直訴もできぬゆえ）が、箱は ssh の側に揃える。手元の命の履歴で、
 * これで新たに止まる無害な命は 0 件だった（2026-10-20 に測った）。
 */
function boxInner(name: string, argv: Word[]): Word[] | undefined {
  let sub: 'exec' | 'run' | 'kubectl';
  let i: number;
  if ((name === 'docker' || name === 'podman') && (argv[1]?.value === 'exec' || argv[1]?.value === 'run')) {
    sub = argv[1].value as 'exec' | 'run';
    i = 2;
  } else if ((name === 'docker' || name === 'podman') && argv[1]?.value === 'container' && (argv[2]?.value === 'exec' || argv[2]?.value === 'run')) {
    sub = argv[2].value as 'exec' | 'run';
    i = 3;
  } else if (name === 'kubectl' && argv[1]?.value === 'exec') {
    sub = 'kubectl';
    i = 2;
  } else {
    return undefined;
  }
  const values = BOX_VALUES[sub]!;
  while (i < argv.length) {
    const v = argv[i]!.value;
    if (v === '--') break;
    if (v.startsWith('-') && v.length > 1) {
      i += values.includes(v) ? 2 : 1;
      continue;
    }
    break;
  }
  if (argv[i]?.value !== '--') i += 1; // 箱・image・pod の名
  if (argv[i]?.value === '--') i += 1;
  return argv.slice(i);
}

/** 展開に依る字があっても拒まず、解けた分の命だけを足す（箱の中の環境は見えぬ）。 */
function resolveLoose(argv: Word[], run: Runner, depth: number, out: ExecScan): void {
  if (argv.length === 0) return;
  const sub: ExecScan = { units: [] };
  resolveArgv(argv, run, depth, sub);
  out.units.push(...sub.units);
  (out.legacy ??= []).push(...(sub.legacy ?? []));
  propagateOpaque(sub, out);
}

// ── 他の言語の源の中の、shell を呼ぶ口 ──

/** 源を渡す旗。`perl -le` のように束の末尾が e の物も在る。 */
function sourceArg(name: string, argv: Word[]): string | undefined {
  const lang = /^python[0-9.]*$/.test(name) ? 'python' : name === 'nodejs' ? 'node' : name;
  for (let i = 1; i + 1 < argv.length; i++) {
    const v = argv[i]!.value;
    const hit =
      (lang === 'python' && v === '-c') ||
      (lang === 'node' && (v === '-e' || v === '--eval' || v === '-p' || v === '--print')) ||
      ((lang === 'perl' || lang === 'ruby') && /^-[a-zA-Z]*[eE]$/.test(v));
    if (hit) return argv[i + 1]!.value;
    if (lang === 'python' && !v.startsWith('-')) return undefined; // script の file
  }
  return undefined;
}

/** 字の列の頭の字どおりの文字列を読む。読めねば undefined。 */
function readString(src: string, at: number, quotes: string): { text: string; end: number } | undefined {
  let i = at;
  while (i < src.length && /[rRbBuU]/.test(src[i]!) && i - at < 2) i++;
  const q = src[i];
  if (q === undefined || !quotes.includes(q)) return undefined;
  if (src.startsWith(q.repeat(3), i)) return undefined; // 三重の引用は読まぬ
  let text = '';
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === '\\') {
      const nx = src[j + 1];
      text += nx === 'n' ? '\n' : nx === 't' ? '\t' : (nx ?? '');
      j++;
      continue;
    }
    if (ch === q) return { text, end: j + 1 };
    text += ch;
  }
  return undefined;
}

/** `'a'` か `['a', 'b']`。字どおりなら空白で繋いだ字を返す。 */
function readArg(src: string, at: number, quotes: string): string | undefined {
  let i = at;
  while (/\s/.test(src[i] ?? '')) i++;
  if (src[i] === '[') {
    const parts: string[] = [];
    let j = i + 1;
    for (;;) {
      while (/[\s,]/.test(src[j] ?? '')) j++;
      if (src[j] === ']') return parts.join(' ');
      const r = readString(src, j, quotes);
      if (!r) return undefined;
      parts.push(r.text);
      j = r.end;
    }
  }
  const first = readString(src, i, quotes);
  if (!first) return undefined;
  // `system("kill", "1")`・`spawn('kill', ['1'])` の残りの字どおりの引数も繋ぐ
  const parts = [first.text];
  let j = first.end;
  for (;;) {
    while (/\s/.test(src[j] ?? '')) j++;
    if (src[j] !== ',') break;
    j++;
    while (/\s/.test(src[j] ?? '')) j++;
    const more = src[j] === '[' ? readArg(src, j, quotes) : readString(src, j, quotes)?.text;
    if (more === undefined) break;
    parts.push(more);
    j = src[j] === '[' ? src.indexOf(']', j) + 1 : (readString(src, j, quotes)?.end ?? j + 1);
  }
  // 字の後ろに足し算や書式が続けば、渡る字は組み立てられる（`'rm' + ' -rf /'`・
  // `'%s' % x`・`'{}'.format(x)`）。頭の字だけを命と読むと取りこぼすゆえ、字どおりでないとする
  while (/\s/.test(src[j] ?? '')) j++;
  if (/[+%.*\[]/.test(src[j] ?? '')) return undefined;
  return parts.join(' ');
}

/**
 * 他の言語の源の中で、shell を呼ぶ口に渡る命の字を取り出す。
 *
 * **源を完全には解かぬ。** 口の名の後ろに、字どおりの文字列（か、字どおりの文字列の列）が
 * 来る時だけ、その字を命として返す。字どおりでない（変数・式・字の中の展開）時は opaque。
 * 取りこぼす形: 口を別の名で呼ぶ（`from os import system as s`）、源を file や heredoc から
 * 読む、字を組み立てる（`'ki' + 'll'`）、eval や exec で源を作る。
 */
function shellCallsIn(lang: string, src: string): { cmds: string[]; opaque: number } {
  const cmds: string[] = [];
  let opaque = 0;
  const take = (re: RegExp, quotes: string) => {
    for (const m of src.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].length;
      const a = readArg(src, at, quotes);
      if (a === undefined) opaque++;
      else if (/\$\{|#\{|\{[a-zA-Z_]/.test(a) || (lang === 'perl' && /[$@][a-zA-Z_{]/.test(a))) opaque++;
      else cmds.push(a);
    }
  };
  const ticks = (re: RegExp) => {
    for (const m of src.matchAll(re)) {
      const t = m[1] ?? '';
      if (/\$\{|#\{|[$@][a-zA-Z_{]/.test(t)) opaque++;
      else cmds.push(t);
    }
  };
  if (lang === 'python') {
    take(/\b(?:os\.(?:system|popen|exec[lv]p?e?)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))\s*\(/g, '\'"');
  } else if (lang === 'node') {
    if (/child_process/.test(src)) take(/\b(?:execSync|execFileSync|spawnSync|execFile|spawn|exec)\s*\(/g, '\'"`');
  } else if (lang === 'perl') {
    take(/\b(?:system|exec)\b\s*\(?/g, '\'"');
    ticks(/`([^`]*)`/g);
    ticks(/\bqx\s*[({\[/|]([^)}\]/|]*)[)}\]/|]/g);
  } else if (lang === 'ruby') {
    take(/\b(?:system|exec|spawn|IO\.popen|Open3\.(?:capture2e?|capture3|popen3))\b\s*\(?/g, '\'"');
    ticks(/`([^`]*)`/g);
    ticks(/%x\s*[({\[|]([^)}\]|]*)[)}\]|]/g);
  }
  return { cmds, opaque };
}

// ── patch を当てる命（git apply・git am・patch） ──

/**
 * 門が読む file（patch と、shell へ流す file）の大きさの上限。超えれば読まずに「解けぬ」へ倒す。
 *
 * patch と同じ 1 MiB にしてある。shell へ流す file は手で書く短い手順が常で、patch より
 * 大きくなる筋は薄い。門は命ごとに file を読むゆえ、上限は待ちの長さの上限でもある。
 * 二つに分けると、片方だけを大きな file で溢れさせる道が残るゆえ、一つの値で持つ
 */
const MAX_READ_BYTES = 1 << 20;

/** patch が書き換える file の道。`--- a/x`・`+++ b/x`・`diff --git a/x b/y`・rename・copy。 */
export function patchTargets(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    let m = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
    if (m && m[1] !== '/dev/null') out.add(m[1]!);
    m = /^diff --git (\S+) (\S+)/.exec(line);
    if (m) {
      out.add(m[1]!);
      out.add(m[2]!);
    }
    m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (m) out.add(m[1]!.trim());
  }
  return [...out];
}

/**
 * 門が中身を判ずる file を読む。**辿らず、待たず、溢れさせぬ。**
 *
 * - 在らぬ: missing（読む命も落ちる。ただし同じ命の中で作られうるかは readSource が見る）
 * - symlink・並の file でない（FIFO や dev）・上限を超える・読めぬ: unreadable（拒む）。
 *   lstat で見るゆえ symlink を辿らず、FIFO を開かぬ（開けば門が待ちに落ちる）
 */
function readGuarded(path: string, full: string): { text: string } | { missing: true } | { unreadable: string } {
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { missing: true };
  }
  if (st.isSymbolicLink()) return { unreadable: `${path} は symlink` };
  if (!st.isFile()) return { unreadable: `${path} は並の file でない` };
  if (st.size > MAX_READ_BYTES) return { unreadable: `${path} が大きすぎる（${st.size} byte）` };
  try {
    return { text: readFileSync(full, 'utf8') };
  } catch {
    return { unreadable: `${path} を読めぬ` };
  }
}

/**
 * 命が読む file の中身を、門が判ずる時の姿で返す。
 *
 * **判ずる時の姿と、走る時の姿が割れる形を拒む。** 門は命が走る前に file を読む。同じ命の
 * 中で file を作る・書き換える・link を張る命が在れば、走る時の中身は門が読んだ物と違う。
 *
 * - 同じ命の中で書かれうる（向き替えの先・`tee`・`cp` の類の行き先・読むだけでない命の語に
 *   その道が出る）: 拒む。在っても在らずとも拒む——在る file に書き足してから流す形も同じ罪である
 * - 在らぬ: 命が一つだけなら通す（読む命が落ちるだけ。打ち間違いを止めぬ）。書かぬ命
 *   （`ls`・`test`・`cd` の類）は数えぬ。他に命が在れば拒む。`curl -o`・`tar -x`・`git checkout` の類まで書く命の名を数え切れぬゆえ、名ではなく
 *   「他に命が在るか」で決める
 * - 相対の道は、`cd` の先の候補の全てで読む。一つでも読めねば拒み、在る物は全て判ずる。
 *   `cd` の先が字面で決まらぬ（`cd "$D"`・`cd -`）なら拒む
 *
 * `self` は file を読む命そのもの（`git apply x.diff` の `x.diff` は、書く語ではない）。
 */
function readSource(
  path: string,
  self: Cmd | undefined,
  extraBase?: string,
  searchPath = false,
): { texts: string[] } | { unreadable: string } {
  // `~` は shell が家に替える（`source ~/.bashrc`・`bash < ~/x.sh`）
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
  let fulls: string[];
  if (isAbsolute(path)) fulls = [path];
  else if (extraBase && isAbsolute(extraBase)) fulls = [join(extraBase, path)];
  else if (ctx.bases === undefined) return { unreadable: `${path} は cd の先が字面で決まらぬ道にある` };
  else fulls = [...new Set(ctx.bases.map((b) => join(extraBase ? join(b, extraBase) : b, path)))];
  // `source f` の f に `/` が無ければ、bash は PATH の上から先に探す。PATH の上の物も読む
  if (searchPath && !path.includes('/')) {
    for (const d of (process.env.PATH ?? '').split(':')) if (d !== '' && isAbsolute(d)) fulls.push(join(d, path));
  }
  // `cat > f <<'EOF' … EOF` で書き、他に書く命も道の名を持つ命も無ければ、本文がその file の中身である
  const written = writtenText(path, fulls, self);
  if (written !== undefined) return { texts: [written] };
  if (touchedInCommand(path, fulls, self)) return { unreadable: `${path} は同じ命の中で書かれうる` };
  const texts: string[] = [];
  for (const full of fulls) {
    const r = readGuarded(path, full);
    if ('unreadable' in r) return r;
    if ('text' in r) texts.push(r.text);
  }
  if (texts.length === 0 && ctx.commands > 1 && !ctx.inFile) {
    return { unreadable: `${path} は門が読む時に無く、同じ命の中で作られうる` };
  }
  return { texts };
}

/**
 * patch を当てる命なら、patch が書き換える file の道を返す（門の D012 が当たるよう、
 * emit の字に足す）。patch の出所は引数の file か、標準入力。
 */
function patchCommand(name: string, argv: Word[], stdin: Stdin | undefined): { targets: string[] } | { unreadable: string } | undefined {
  // `git -C <dir>`・`patch -d <dir>` の道。cd の先の候補の下に足す
  let base = '';
  const files: string[] = [];
  // 道が展開に依る patch（`git apply "$P"`）は、門には何を当てるか読めぬ。前は在らぬ道と読んで
  // 通しておった——中身が門の本体を書き換える patch でも素通りする
  let dynamic: string | undefined;
  const take = (w: Word | undefined) => {
    if (!w) return;
    if (w.var || w.cmdsubst) dynamic = dynamic ?? w.text;
    files.push(w.value);
  };
  let fromStdin = false;
  if (name === 'git') {
    let i = 1;
    while (i < argv.length && argv[i]!.value.startsWith('-')) {
      const v = argv[i]!.value;
      if (v === '-C' && argv[i + 1]) {
        base = join(base, argv[i + 1]!.value);
        i += 2;
      } else if (v === '-c' || v === '--git-dir' || v === '--work-tree') i += 2;
      else i += 1;
    }
    const subc = argv[i]?.value;
    if (subc !== 'apply' && subc !== 'am') return undefined;
    // `--check`・`--stat`・`--numstat`・`--summary` は当てずに見るだけ（`--apply` が付けば当てる）。
    // 門の本体への直しの手順は、patch の道で `git apply --check` を打つ。これを止めぬ
    const opts = argv.slice(i + 1).map((w) => w.value);
    if (subc === 'apply' && opts.some((v) => ['--check', '--stat', '--numstat', '--summary'].includes(v)) && !opts.includes('--apply')) {
      return { targets: [] };
    }
    for (const w of argv.slice(i + 1)) if (!w.value.startsWith('-')) take(w);
    fromStdin = files.length === 0;
  } else if (name === 'patch') {
    const pos: Word[] = [];
    const VALUES = ['-p', '-d', '-o', '-r', '-B', '-V', '-z', '-D', '-F', '-g', '-Y', '--directory', '--output', '--reject-file'];
    // `--dry-run` は当てずに見るだけ
    if (argv.some((w) => w.value === '--dry-run')) return { targets: [] };
    for (let i = 1; i < argv.length; i++) {
      const v = argv[i]!.value;
      if (v === '-i' || v === '--input') {
        take(argv[i + 1]);
        i++;
      } else if (v.startsWith('--input=')) {
        if (argv[i]!.var || argv[i]!.cmdsubst) dynamic = dynamic ?? argv[i]!.text;
        files.push(v.slice('--input='.length));
      }
      else if (v === '-d' || v === '--directory') {
        if (argv[i + 1]) base = join(base, argv[i + 1]!.value);
        i++;
      } else if (VALUES.includes(v)) i++;
      else if (!v.startsWith('-')) pos.push(argv[i]!);
    }
    if (files.length === 0 && pos.length >= 2) take(pos[1]);
    fromStdin = files.length === 0;
  } else {
    return undefined;
  }
  if (dynamic !== undefined) return { unreadable: `${dynamic} は道が展開に依る` };
  const targets: string[] = [];
  // 同じ命の中で作ってから当てる形（`printf … > late.diff; git apply late.diff`）は、
  // 門が読む時にはまだ無いか、読んだ物と当てる物が違う。readSource が拒む
  const add = (f: string) => {
    const r = readSource(f, ctx.current, base || undefined);
    if ('unreadable' in r) return r.unreadable;
    for (const t of r.texts) targets.push(...patchTargets(t));
    return undefined;
  };
  for (const f of files) {
    const bad = add(f);
    if (bad) return { unreadable: bad };
  }
  if (fromStdin && stdin) {
    if ('opaque' in stdin) return { unreadable: '標準入力から読む patch の中身が見えぬ' };
    if ('text' in stdin) targets.push(...patchTargets(stdin.text));
    if ('file' in stdin) {
      const bad = add(stdin.file);
      if (bad) return { unreadable: bad };
    }
  }
  return { targets };
}

/** 一つの argv を辿り、実際に走る命へ降りる。 */
function resolveArgv(argv: Word[], run: Runner, depth: number, out: ExecScan, stdin?: Stdin): void {
  if (depth <= 0 || out.units.length >= MAX_UNITS) {
    out.unresolved = out.unresolved ?? '入れ子が深すぎる、または命が多すぎる';
    return;
  }
  if (argv.length === 0) return;

  const head = argv[0]!;
  // **命の名が判らぬなら拒む。** `$SHELL -c …` や `${CMD:-rm} …` は
  // 走らせるまで何が起きるか判らぬ
  if (head.var || head.cmdsubst) {
    out.unresolved = out.unresolved ?? `命の名が展開に依っておる（${head.text}）`;
    return;
  }
  const name = baseName(head.value);
  // **名から道を落として出す。** `/bin/rm -rf /` を書かれたまま渡すと、
  // 紋様の行頭アンカーが外れて素通りする（実測 2026-09-01）。
  // 判ずるのは「何が走るか」であって、どう書かれたかではない。
  const emit = () => out.units.push([name, ...argv.slice(1).map((w) => w.value)].join(' '));

  // ── shell へ文字列で渡された命は、解き直す ──
  if (SHELLS.has(name)) {
    // **短旗の束は一字ずつ。** `-lc` は `-l -c` の束であり、`c` を含む。
    // だが `-color` や `-check` は一字の束ではない——緩く見ると、その次の語を
    // 命の文字列と誤読する（自分で気づいた・2026-09-01）。
    // 長い旗（`--command`）は shell には無いので見ぬ。
    const ci = argv.findIndex(
      (w, i) => i > 0 && !w.quoted && /^-[a-z]{1,4}$/.test(w.value) && w.value.includes('c'),
    );
    if (ci >= 0 && ci + 1 < argv.length) {
      descendScript(argv[ci + 1]!, run, depth, out);
      return;
    }
    // `eval` は引数を空白で繋いで shell が読む。`eval 'x; rm -rf /'` の中の `;` は
    // 命の切れ目である
    if (name === 'eval') {
      descendWords(argv.slice(1), run, depth, out);
    } else if (name !== 'eval') {
      // script の file に渡す引数は、script がそのまま走らせることが多い
      // （`bash coder_mount.sh exec ws 'a; sudo …'` は遠方で走る）。命の切れ目を
      // 含む字面の引数だけを緩く降りる
      for (const w of argv.slice(1)) {
        if (/[;&|\n]/.test(w.value)) descendWords([w], run, depth, out, true);
      }
    }
    emit();
    return;
  }

  // ── find の -exec / -execdir ──
  if (name === 'find') {
    // **命を起こす述語は四つあり、しかも一つとは限らぬ。**
    // `-ok` は訊いてから走らせるだけで、走らせることに変わりはない。
    // 二つ目の `-exec` を見落として素通りした（三度目の監査 2026-09-01）。
    const RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
    // 終端は `;` `\;` `+`。**書かれ方が幾通りもある**——shell に食われぬよう
    // 逃がすのが常で、解析器は `\;` をそのまま値に持つ（実測 2026-09-01）
    const END = new Set([';', '\\;', '+']);
    let found = false;
    for (let k = 1; k < argv.length; k++) {
      if (!RUNS.has(argv[k]!.value)) continue;
      found = true;
      const rest = argv.slice(k + 1);
      const e = rest.findIndex((w) => END.has(w.value));
      resolveArgv(e >= 0 ? rest.slice(0, e) : rest, run, depth, out);
      if (e >= 0) k += e + 1;
      else break;
    }
    if (!found) emit();
    return;
  }

  // ── trap の命の字は、後で走る命である ──
  // `trap 'cmd' EXIT`・`trap -- 'cmd' INT`。`trap - EXIT`（戻す）・`trap -p`・`trap -l` は走らせぬ
  if (name === 'trap') {
    let i = 1;
    if (argv[i]?.value === '--') i++;
    const arg = argv[i];
    if (arg && i + 1 < argv.length && arg.value !== '-' && !/^-[lp]$/.test(arg.value)) {
      descendWords([arg], run, depth, out);
    }
    emit();
    return;
  }

  // ── 箱の中の命。ssh と同じく照らす ──
  const box = boxInner(name, argv);
  if (box !== undefined) {
    resolveLoose(box, run, depth, out);
    emit();
    return;
  }

  // ── 他の言語の源の中の、shell を呼ぶ口 ──
  if (/^(?:python[0-9.]*|node|nodejs|perl|ruby)$/.test(name)) {
    const src = sourceArg(name, argv);
    if (src !== undefined) {
      const lang = /^python/.test(name) ? 'python' : name === 'nodejs' ? 'node' : name;
      const calls = shellCallsIn(lang, src);
      for (const c of calls.cmds) descendLoose(c, run, depth, out);
      if (calls.opaque > 0) {
        out.unresolved = out.unresolved ?? `${name} の源の中で shell を呼ぶ口に渡る字が見えぬ`;
      }
    }
    emit();
    return;
  }

  // ── patch を当てる命。patch が書き換える file の道を字に足す（門の D012 が当たる） ──
  if (name === 'git' || name === 'patch') {
    const pc = patchCommand(name, argv, stdin);
    if (pc && 'unreadable' in pc) {
      out.unresolved = out.unresolved ?? `当てる patch を読めぬ（${pc.unreadable}）`;
      out.fileUnresolved = out.fileUnresolved ?? out.unresolved;
      return;
    }
    if (pc && pc.targets.length > 0) {
      out.units.push([name, ...argv.slice(1).map((w) => w.value), ...pc.targets].join(' '));
      return;
    }
  }

  // ── 包み。旗を読んで、命の位置まで進む ──
  const spec = WRAP[name];
  if (!spec) {
    if (/\.(?:sh|bash|zsh|ksh)$/.test(name)) {
      for (const w of argv.slice(1)) {
        if (/[;&|\n]/.test(w.value)) descendWords([w], run, depth, out, true);
      }
    }
    descendEmbedded(name, argv, run, depth, out);
    emit();
    return;
  }
  let i = 1;
  let pos = spec.pos ?? 0;
  while (i < argv.length) {
    const v = argv[i]!.value;
    if (spec.scriptFlag && v === spec.scriptFlag && i + 1 < argv.length) {
      descendScript(argv[i + 1]!, run, depth, out);
      return;
    }
    // `env -S '…'` は値を分けて命の行にする。中の命へ緩く降りる
    if (name === 'env' && (v === '-S' || v === '--split-string') && i + 1 < argv.length) {
      descendWords([argv[i + 1]!], run, depth, out);
    }
    if (/^\w+=/.test(v)) { i++; continue; }
    if (v === '--') { i++; break; }
    if (v.startsWith('-')) {
      i += spec.value?.includes(v) ? 2 : 1;
      continue;
    }
    if (pos > 0) { pos--; i++; continue; }
    break;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) {
    // 包みだけで命が無い（`env` 単体など）。害は無い
    emit();
    return;
  }
  // ssh（二語以上）・watch・parallel は残りを空白で繋いで shell に読ませる。
  // 繋いだ字の中の `;` は命の切れ目ゆえ、緩く降りる（下の resolveArgv も残す）
  if ((spec.script === 'rest' && rest.length > 1) || name === 'watch' || name === 'parallel') {
    descendWords(rest, run, depth, out);
  }
  // 残りが「一つの文字列としての命」なら、解き直す（ssh の類）
  if (spec.script === 'rest' && rest.length === 1) {
    descendScript(rest[0]!, run, depth, out);
    return;
  }
  // 包みを剥がす降り方は argv が必ず縮むゆえ、深さを使わぬ。深さを使うのは、文字列を
  // 解き直して降りる時（descendScript・descendLoose）だけ。`timeout 5 ssh -o K=V h '…
  // setsid nohup …'` のように包みが重なると、深さの上限で「解けぬ」に落ちておった
  resolveArgv(rest, run, depth, out);
}

/**
 * いま辿っておる命の、file を読む時に要る周り。execUnits が入れ子で呼ばれる（`sh -c '…'`・
 * 流す file の中身）ゆえ、外の命の分を引き継いで積み、出る時に戻す。
 *
 * - writes: 書く先。向き替えの先（解き手が返す）と、`tee` の引数、`cp`・`mv`・`install`・`ln` の行き先
 * - mentions: 読むだけでない命の語。`curl -o x`・`sed -i … x` のように、書く命の名と旗を
 *   数え切れぬゆえ、語にその道が出れば書かれうると見る
 * - commands: 書かぬ命（READERS）を除いた命の数。在らぬ file を、他に命が在る時は作られうると見る
 * - bases: 相対の道を読む先の候補。`cd` の先を足す。字面で決まらぬ cd が在れば undefined
 * - current: いま辿っておる命（file を読む命そのものの語は、書く語に数えぬ）
 * - ancestors: いま辿っておる字を中に持つ外の命（`sh -c '…'` の sh）。外の命の字には中の命の字が
 *   丸ごと在り、道の名も出る。中身は内の解きが一つずつ検めるゆえ、書く語に数えぬ
 */
interface ReadCtx {
  writes: string[];
  mentions: { cmd: Cmd; words: Word[] }[];
  commands: number;
  bases: string[] | undefined;
  current: Cmd | undefined;
  ancestors: Cmd[];
  /**
   * 門が読んだ file の中身を辿っておる。rc の類は在らぬ file を条件つきで読む
   * （`[ -f ~/.bash_aliases ] && . ~/.bash_aliases`）。中身の中では、在らず書かれもせぬ file を通す
   */
  inFile: boolean;
  /** `cat > f <<'EOF' … EOF` で書く file と本文 */
  writtenTexts: { path: string; text: string }[];
  /** 字どおりの代入（`S=/tmp/x` だけの命）。`bash $S/run.sh` の道を解くため */
  vars: Map<string, string>;
}

let ctx: ReadCtx = {
  writes: [],
  mentions: [],
  commands: 0,
  bases: undefined,
  current: undefined,
  ancestors: [],
  inFile: false,
  writtenTexts: [],
  vars: new Map(),
};

/** 書かぬ命。語に道が出ても、その file を書き換えぬ */
const READERS = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'test', '[', 'ls', 'stat', 'file',
  'sha256sum', 'sha1sum', 'md5sum', 'diff', 'cmp', 'echo', 'printf', 'cd', 'pushd',
]);

/**
 * 語に道が出ても、その file の中身を書かぬ命。READERS に、読み込むだけの `source`・`.` と、中身を
 * 変えぬ `chmod`・`chown`・`touch`、消すだけの `rm` の類を足す（cmd_305 の手元の履歴で、走らせた後に
 * 片付ける `rm … x.sh` と、`chmod +x x.sh && bash x.sh` が止まっておった）。
 * 読み込む file の中で書く命は、門がその file を辿る時に見る。命の数（READERS で数える）には
 * 足さぬ——読み込む script が file を作りうるゆえ
 */
const MENTION_READERS = new Set([...READERS, 'source', '.', 'chmod', 'chown', 'touch', 'rm', 'rmdir', 'unlink']);

function writesOf(p: Parsed & { ok: true }): string[] {
  const out = [...p.writes];
  for (const c of p.commands) {
    const name = c.argv[0] ? baseName(c.argv[0].value) : '';
    const args = c.argv.slice(1).map((w) => w.value).filter((v) => !v.startsWith('-'));
    if (name === 'tee') out.push(...args);
    if (['cp', 'mv', 'install', 'ln'].includes(name) && args.length >= 2) out.push(args[args.length - 1]!);
  }
  return out;
}

/** cd の先の候補。字面で決まらぬ cd（`cd "$D"`・`cd -`・置換）が在れば undefined。 */
function basesOf(p: Parsed & { ok: true }, inherited: string[] | undefined): string[] | undefined {
  if (inherited === undefined) return undefined;
  const out = [...inherited];
  let cur = out[out.length - 1]!;
  for (const c of p.commands) {
    const name = c.argv[0] ? baseName(c.argv[0].value) : '';
    if (name !== 'cd' && name !== 'pushd' && name !== 'popd') continue;
    const args = c.argv.slice(1).filter((w) => w.value !== '--' && !/^-[LPe@]+$/.test(w.value));
    if (name === 'popd' || args.length > 1) return undefined;
    const a = args[0];
    if (a === undefined) cur = homedir();
    else if (a.var || a.cmdsubst || a.value === '-') return undefined;
    else if (a.value === '~' || a.value.startsWith('~/')) cur = join(homedir(), a.value.slice(1));
    else cur = isAbsolute(a.value) ? a.value : join(cur, a.value);
    out.push(cur);
  }
  return [...new Set(out)];
}

function touchedInCommand(path: string, fulls: string[], self: Cmd | undefined): boolean {
  const same = (w: string) => {
    if (w === path) return true;
    const bases = ctx.bases ?? [process.cwd()];
    return bases.some((b) => fulls.includes(isAbsolute(w) ? w : join(b, w)));
  };
  if (ctx.writes.some(same)) return true;
  return mentionedInCommand(path, fulls, self);
}

/** 道が、その道を指す語か。相対の道は cd の先の候補で解く。 */
function samePath(w: string, path: string, fulls: string[]): boolean {
  if (w === path) return true;
  const bases = ctx.bases ?? [process.cwd()];
  return bases.some((b) => fulls.includes(isAbsolute(w) ? w : join(b, w)));
}

/**
 * `cat > f <<'EOF' … EOF` で書く本文。書く命がそれ一つだけで（向き替えの先にも一度だけ出る）、
 * 読むだけでない命の語に道の名が出ぬ時に限り返す。他に書く命が在れば、走る時の中身は本文と違いうる
 */
function writtenText(path: string, fulls: string[], self: Cmd | undefined): string | undefined {
  const hits = ctx.writtenTexts.filter((w) => samePath(w.path, path, fulls));
  if (hits.length !== 1) return undefined;
  if (ctx.writes.filter((w) => samePath(w, path, fulls)).length !== 1) return undefined;
  if (mentionedInCommand(path, fulls, self)) return undefined;
  return hits[0]!.text;
}

/**
 * 字どおりの代入だけの命（`S=/tmp/x`・`S="/tmp/x"`）を集める。値に展開が在る物と、後で別の値を
 * 置く物は解かぬ（どちらが効くか、門には決められぬ）
 */
function varsOf(p: Parsed & { ok: true }, inherited: Map<string, string>): Map<string, string> {
  const out = new Map(inherited);
  const seen = new Set<string>();
  for (const c of p.commands) {
    if (c.argv.length > 0) continue;
    for (const a of c.assigns) {
      const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(a);
      if (!m) continue;
      const [, name, raw] = m as unknown as [string, string, string];
      const v = /^"([^"$`\\]*)"$|^'([^']*)'$|^([^"'$`\\\s;&|<>()]*)$/.exec(raw);
      if (!v || seen.has(name)) {
        out.delete(name);
        seen.add(name);
        continue;
      }
      seen.add(name);
      out.set(name, v[1] ?? v[2] ?? v[3] ?? '');
    }
  }
  return out;
}

function mentionedInCommand(path: string, fulls: string[], self: Cmd | undefined): boolean {
  const same = (w: string) => samePath(w, path, fulls);
  // 語の一語が道そのものでなくとも、字の中に道の末の名を持てば書かれうると見る。
  // `python3 -c "open('f.sh','a')…"`・`sh -c 'echo … >> f.sh'`・`awk '{ print … >> "f.sh" }'` の
  // 類は、書く先を引用の中の字に持つ（軍師の検め #1205 が見つけた穴）。道そのものでなく末の名で
  // 当てるのは、`os.path.join('d', 'f.sh')` のように道を組む形と、cd の後に名だけで書く形も
  // 拾うためである。誤って止めるのは、同じ命の中で読むだけでない命がその名を字に持つ形に限られ、
  // 拒みに倒す側で直訴もできる
  const name = baseName(path);
  return ctx.mentions.some(
    (m) =>
      m.cmd !== self &&
      !ctx.ancestors.includes(m.cmd) &&
      // 同じ file を script として走らせる命（一つの行で `bash x.sh a; bash x.sh b`）は、その file を
      // 書く命に数えぬ。走らせる script の中で書く命は、門がその中身を辿る時に見る
      !(m.cmd.script && !m.cmd.script.dynamic && same(m.cmd.script.path)) &&
      // 命令置換を持つ語の中の字は、置換の中身として別に辿る（`gh -R "$(bash x.sh …)"` の x.sh は
      // 書く先ではない）。部分文字列で当てるのは、置換を持たぬ語だけにする
      m.words.some((w) => same(w.value) || (name !== '' && !w.cmdsubst && w.value.includes(name))),
  );
}

/**
 * p の命の周りを積んで fn を走らせ、出る時に戻す。execUnits と、門が後で別に解く命令置換と
 * heredoc の中身（substUnits・heredocUnits）が通る。後者が外の命の周りを引き継がねば、
 * `printf … > f.sh; echo "$(bash < f.sh)"` の中の `bash < f.sh` を、命が一つだけの形と読む
 */
function withCtx<T>(p: Parsed & { ok: true }, fn: () => T): T {
  const saved = ctx;
  const outer = saved.bases === undefined && saved.commands === 0;
  ctx = {
    writes: [...saved.writes, ...writesOf(p)],
    mentions: [
      ...saved.mentions,
      ...p.commands
        .filter((c) => !MENTION_READERS.has(c.argv[0] ? baseName(c.argv[0].value) : ''))
        .map((cmd) => ({ cmd, words: cmd.argv.slice(1) })),
    ],
    // 書かぬ命（READERS）は数えぬ。命令置換の中身は命である（shell へ流す heredoc と字も、解き手が
    // 置換と同じ群れへ渡す）。外で一つと数えると、中で作る形を見落とす
    commands:
      saved.commands +
      p.commands.filter((c) => !READERS.has(c.argv[0] ? baseName(c.argv[0].value) : '')).length +
      p.substitutions.length,
    bases: basesOf(p, outer ? [process.cwd()] : saved.bases),
    current: saved.current,
    ancestors: saved.current ? [...saved.ancestors, saved.current] : saved.ancestors,
    inFile: saved.inFile,
    writtenTexts: [...saved.writtenTexts, ...p.writtenTexts],
    vars: varsOf(p, saved.vars),
  };
  try {
    return fn();
  } finally {
    ctx = saved;
  }
}

/** 実際に走る命を、包みと文字列越しの入れ子まで辿って集める。 */
export function execUnits(p: Parsed, run: Runner, depth = 4): ExecScan {
  const out: ExecScan = { units: [] };
  if (!p.ok) return { units: [], unresolved: p.reason };
  return withCtx(p, () => execUnitsInner(p, run, depth, out));
}

/**
 * shell が標準入力から読む file の中身を、命として辿る。heredoc で同じ中身を流した時と同じく、
 * 中身の命・命令置換・heredoc を集める。
 *
 * **中身の解けぬ所は拒む**（heredoc と違う所）。heredoc の中身は命の生の字に含まれ、門の
 * 紋様の層（`curl … | sh` の D008 など）が字面で照らす。file の中身は生の字に無いゆえ、
 * 紋様の層が見ぬ。解けた命だけを照らして通すと、管で shell へ流す形が抜ける
 */
function descendShellFile(f: string, run: Runner, depth: number, out: ExecScan, self?: Cmd, searchPath = false): void {
  const r = readSource(f, self, undefined, searchPath);
  if ('unreadable' in r) {
    out.unresolved = out.unresolved ?? `shell へ流す file を読めぬ（${r.unreadable}）`;
    out.fileUnresolved = out.fileUnresolved ?? out.unresolved;
    return;
  }
  judgeTexts(f, r.texts, run, depth, out);
}

/** 門が読んだ file の中身（または書いた本文）を、命として辿る。解けぬ所は拒む。 */
function judgeTexts(f: string, texts: string[], run: Runner, depth: number, out: ExecScan): void {
  for (const text of texts) {
    if (depth - 1 <= 0) {
      out.unresolved = out.unresolved ?? '入れ子が深すぎる、または命が多すぎる';
      return;
    }
    const inner = parseCommand(text, run);
    if (!inner.ok) {
      out.unresolved = out.unresolved ?? `shell へ流す file を解けぬ（${f}: ${inner.reason}）`;
      return;
    }
    const savedIn = ctx.inFile;
    ctx.inFile = true;
    let scan: ExecScan;
    try {
      scan = execUnits(inner, run, depth - 1);
    } finally {
      ctx.inFile = savedIn;
    }
    (out.legacy ??= []).push(...(scan.legacy ?? []));
    if (scan.unresolved !== undefined) {
      out.unresolved = out.unresolved ?? `shell へ流す file の中身（${f}）: ${scan.unresolved}`;
    }
    if (scan.fileUnresolved !== undefined) out.fileUnresolved = out.fileUnresolved ?? scan.fileUnresolved;
    (out.fromFiles ??= []).push(...units(inner), ...scan.units, ...substUnits(inner, run), ...heredocUnits(inner, run));
  }
}

/**
 * 引数か source で渡す script の file の、判ずる時の姿。
 *
 * - texts: 同じ命の中で `cat > f <<'EOF'` で書く本文。門はこれを中身として判ずる
 * - unreadable: 判ずる時と走る時の姿が割れる（同じ命の中で書かれうる・在らず他に命が在る）
 * - skip: 既に在り、同じ命の中で書かれもせぬ。**中身は判ぜぬ**（手元の履歴で、日々の基盤の
 *   script の中身が掟に当たる形が 52 件出た。うち 6 件は絶対域で直訴もできぬ。cmd_305 の報告）
 */
function scriptSource(path: string, self: Cmd, searchPath: boolean): { texts: string[] } | { unreadable: string } | 'skip' {
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
  let fulls: string[];
  if (isAbsolute(path)) fulls = [path];
  else if (ctx.bases === undefined) return 'skip';
  else fulls = [...new Set(ctx.bases.map((b) => join(b, path)))];
  if (searchPath && !path.includes('/')) {
    for (const d of (process.env.PATH ?? '').split(':')) if (d !== '' && isAbsolute(d)) fulls.push(join(d, path));
  }
  const written = writtenText(path, fulls, self);
  if (written !== undefined) return { texts: [written] };
  if (touchedInCommand(path, fulls, self)) return { unreadable: `${path} は同じ命の中で書かれうる` };
  for (const full of fulls) {
    try {
      lstatSync(full);
      return 'skip';
    } catch {
      // 在らぬ
    }
  }
  if (ctx.commands > 1 && !ctx.inFile) return { unreadable: `${path} は門が読む時に無く、同じ命の中で作られうる` };
  return 'skip';
}

/**
 * script として走らせる file（`bash x.sh`・`source x.sh`・`. x.sh`・`bash <(cat x.sh)`）を辿る。
 *
 * process 置換で渡す形は、標準入力で流すのと同じく file を読んで中身を判ずる（読む守りも同じ）。
 * 引数か source で渡す形は、判ずる時と走る時の姿が割れる形（同じ命の中で作る・書き換える）だけを
 * 拒み、書いた本文が見えれば本文で判ずる。既に在る file の中身は判ぜぬ（scriptSource）。
 *
 * 道が展開に依れば、頭の一つの変数だけを解く。`$HOME` は家、他は同じ命の中の字どおりの代入
 * （`S=/tmp/x; bash $S/run.sh`）。解けねば、既に在る file と同じく判ぜぬ
 */
function descendScriptFile(c: Cmd, s: NonNullable<Cmd['script']>, run: Runner, depth: number, out: ExecScan): void {
  if (s.proc) {
    descendShellFile(s.path, run, depth, out, c, false);
    return;
  }
  let path = s.path;
  if (s.dynamic) {
    const m = /^\$(?:\{(\w+)\}|(\w+))(\/.*)?$/.exec(path);
    const name = m ? (m[1] ?? m[2])! : '';
    const value = name === 'HOME' && !ctx.vars.has('HOME') ? homedir() : ctx.vars.get(name);
    if (!m || value === undefined || /[$`]/.test(m[3] ?? '')) return;
    path = value + (m[3] ?? '');
  }
  const r = scriptSource(path, c, s.sourced);
  if (r === 'skip') return;
  if ('unreadable' in r) {
    out.unresolved = out.unresolved ?? `走らせる script を判ずる時と走る時の姿が割れる（${r.unreadable}）`;
    out.fileUnresolved = out.fileUnresolved ?? out.unresolved;
    return;
  }
  if (!s.posix) {
    out.unresolved = out.unresolved ?? `${path} の中身は門が解けぬ shell の script である`;
    return;
  }
  judgeTexts(path, r.texts, run, depth, out);
}

function propagateOpaque(scan: ExecScan, out: ExecScan): void {
  if (scan.opaqueUnresolved !== undefined) {
    out.opaqueUnresolved = out.opaqueUnresolved ?? scan.opaqueUnresolved;
    out.unresolved = out.unresolved ?? scan.opaqueUnresolved;
  }
}

function checkOpaque(p: Parsed & { ok: true }, out: ExecScan): void {
  // shell へ流す字が見えねば、何が走るか解けぬ。**拒む**（直訴はできる）。
  // 手元の命の履歴 13,918 件で、これに当たる無害な命は 0 件だった（2026-10-20 に
  // 測った）。字が見える時（echo・printf・here-string）は解き手が置換と同じ
  // 群れへ渡し、門はその字を命として判ずる
  if (p.opaque.length > 0) {
    // Keep policy evidence even when the pipeline cannot be reconstructed.
    if (p.commands.length > 1 && p.commands.some((c) =>
      c.stdin && 'opaque' in c.stdin && !c.script && SHELLS.has(baseName(c.argv[0]?.value ?? '')),
    )) {
      (out.legacy ??= []).push(p.commands.map((c) => c.argv.map((w) => w.value).join(' ')).join(' | '));
    }
    out.opaqueUnresolved = `shell へ流す字が見えぬ（${p.opaque.join(' / ')}）`;
    out.unresolved = out.unresolved ?? out.opaqueUnresolved;
  }
}

function execUnitsInner(p: Parsed & { ok: true }, run: Runner, depth: number, out: ExecScan): ExecScan {
  checkOpaque(p, out);
  for (const c of p.commands) {
    ctx.current = c;
    resolveArgv(c.argv, run, depth, out, c.stdin);
    if (c.script) descendScriptFile(c, c.script, run, depth, out);
  }
  ctx.current = undefined;
  for (const f of p.shellFiles) descendShellFile(f, run, depth, out);
  // 命令置換と、shell へ流す heredoc の中で file を読む形（shell へ流す heredoc と字は、解き手が
  // 置換と同じ群れへ渡す。shell でない命へ渡す heredoc は字であって命ではない）。門はこれらの中身を後で解くが、
  // 展開一般は拒まぬ（substUnits）。opaque な流し込みと読めぬ file はここで拒む
  // （`echo "$(printf … > f.sh; bash < f.sh)"`）
  if (depth - 1 > 0) {
    const shellHeredocs = p.commands.some((c) => SHELLS.has(baseName(c.argv[0]?.value ?? '')))
      ? p.heredocs : [];
    for (const s of [...p.substitutions, ...shellHeredocs]) {
      const inner = parseCommand(s, run);
      if (!inner.ok) continue;
      const scan = execUnits(inner, run, depth - 1);
      propagateOpaque(scan, out);
      (out.legacy ??= []).push(...(scan.legacy ?? []));
      if (scan.fileUnresolved !== undefined) {
        out.unresolved = out.unresolved ?? scan.fileUnresolved;
        out.fileUnresolved = out.fileUnresolved ?? scan.fileUnresolved;
      }
    }
  }
  // 門が読んだ file の中身の命を、ここで足す（命の数の上限は、この命の字の命だけに当てる）
  if (out.fromFiles) {
    out.units.push(...out.fromFiles);
    out.fromFiles = undefined;
  }
  return out;
}
