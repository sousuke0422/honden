/**
 * 禁じ手の門 — コマンドを実行の前に機械的に検める。
 *
 * 現行 CLAUDE.md の Destructive Operation Safety（D001〜D011）のうち、
 * 紋様で判定できるものをここへ昇格させる。訓戒（プロンプト層）は読んで
 * 守るものだが、門は破れない——「鍵であってプロンプトでない」の実装。
 *
 * 三層の裁き:
 *   allow          — 通す
 *   deny + 昇格可  — 止める。だが正当な理由があるなら将軍へ直訴できる
 *                    （guard appeal → 将軍レビュー → OTP 発行 → 一度だけ通る）
 *   deny + 絶対域  — 止める。OTP でも通さない。D001（rm -rf /）・
 *                    D007（mkfs/dd）・D008（pipe-to-shell）は、将軍すら
 *                    注入で誤る日の保険として、誰にも開けられない
 *
 * D011（意図ベース判定・分解や難読化）は紋様では捕まらない。それは
 * プロンプト層（訓戒）と将軍レビューの受け持ちであり、この門は
 * 「明白な違反を確実に止める」ことだけを引き受ける。多層防御の一枚。
 *
 * OTP の紐付け: sha256(正規化コマンド) + 発行先 agent + 期限 + 一回性。
 * 札の平文は発行の瞬間に一度だけ返り、正本にはハッシュしか残らない。
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { journal } from './store';

export interface Verdict {
  permission: 'allow' | 'deny';
  /** 引っかかった掟の札（D003 など）。allow なら無い。 */
  rule?: string;
  /** 何が悪いか。エージェントに返る文。 */
  reason?: string;
  /** 将軍への直訴（appeal → OTP）で通せるか。絶対域は false。 */
  appealable?: boolean;
}

/** 空白を潰して大文字小文字はそのまま。OTP の紐付けと判定の土台。 */
export function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

/**
 * 頭の環境変数代入（FOO=bar …）を剥がした本体。
 *
 * 判定も手形の束縛もこの本体に対して行う。さもなくば `X=1 pkill …` の
 * 前置一つで行頭アンカーが外れ、門が素通しになる（2026-08-27 実弾試験が
 * 釣った穴）。引用符で空白を含む代入（FOO="a b"）までは追わぬ——
 * 凝った形は D011 と同じく上の層の受け持ちである。
 */
export function stripEnvPrefix(cmd: string): string {
  return cmd.replace(/^(?:\w+=\S*\s+)+/, '');
}

/**
 * コマンドから手形（HONDEN_OTP=札）を抜き取る。頭の env 代入の群れの
 * 中ならどこにあってもよい——cursor は HONDEN_DB= を先に置く癖がある。
 */
export function splitOtp(raw: string): { otp?: string; cmd: string } {
  const n = normalize(raw);
  const m = n.match(/^((?:\w+=\S*\s+)*)HONDEN_OTP=(\S+)\s+([\s\S]+)$/);
  if (!m) return { cmd: n };
  return { otp: m[2], cmd: normalize(`${m[1] ?? ''}${m[3]}`) };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface Rule {
  id: string;
  /** 正規化済みコマンドに対する紋様。 */
  pattern: RegExp;
  reason: string;
  /** true なら OTP でも通さない。 */
  absolute?: boolean;
}

/**
 * 掟の表。現行 CLAUDE.md の D 表の機械化できる部分。
 *
 * 紋様は「明白な形」だけを狙う。凝った形（変数展開・分解・難読化）を
 * 追いはじめると false-positive が増え、門が邪魔者になって外される——
 * それが一番の負け筋である。取りこぼしは上の層が拾う。
 */
const RULES: Rule[] = [
  {
    id: 'D001',
    pattern:
      /(?:^|[;&|]\s*)rm\s+(?:-\w*[rR]\w*[fF]\w*|-\w*[fF]\w*[rR]\w*|-[rR]\s+-[fF]|-[fF]\s+-[rR])\s+(?:\/|\/mnt\/\w+|\/home(?:\/\w+)?|~)\s*(?:$|[;&|])/,
    reason: 'OS・ドライブ・ホームを消す形である',
    absolute: true,
  },
  {
    id: 'D001',
    pattern: /(?:^|[;&|]\s*)rm\s+(?:-\w*[rR]\w*[fF]\w*|-\w*[fF]\w*[rR]\w*)\s+(?:\/mnt\/[cd]\/(?:Windows|Users|Program)\b|\/etc\b|\/usr\b|\/var\b)/i,
    reason: 'システム経路を消す形である',
    absolute: true,
  },
  {
    id: 'D003',
    pattern: /git\s+push(?=.*(?:\s--force\b|\s-f\b))(?!.*--force-with-lease)/,
    reason: '共有履歴を壊す。--force-with-lease を使え',
  },
  {
    id: 'D004',
    pattern: /git\s+reset\s+--hard\b|git\s+checkout\s+--\s+\.|git\s+restore\s+\.(?:\s|$)|git\s+clean\s+-\w*f/,
    reason: '未コミットの仕事を消す。stash か dry-run（clean -n）を先に',
  },
  {
    id: 'D005',
    pattern: /(?:^|[;&|]\s*)(?:sudo|su)\b|(?:chmod|chown)\s+-R\s+\S*\s*(?:\/etc|\/usr|\/var|\/bin|\/mnt\/[cd])/,
    reason: '権限昇格・システム経路の一括変更である',
  },
  {
    id: 'D006',
    pattern: /(?:^|[;&|]\s*)(?:kill|killall|pkill)\b|tmux\s+kill-(?:server|session)\b/,
    reason: '他エージェントや土台を殺す形である',
  },
  {
    id: 'D007',
    pattern: /(?:^|[;&|]\s*)(?:mkfs|fdisk)\b|dd\s+if=|(?:^|[;&|]\s*)(?:mount|umount)\b/,
    reason: 'ディスク・区画を壊す形である',
    absolute: true,
  },
  {
    id: 'D008',
    pattern: /(?:curl|wget)\s[^;&|]*\|\s*(?:ba)?sh\b/,
    reason: '外から取った物をそのまま実行する形である',
    absolute: true,
  },
  {
    id: 'D009',
    pattern: /git\s+add\s+(?:-f|--force)\b/,
    reason: 'gitignore には理由がある。秘密が履歴に入れば戻せない',
  },
  {
    // 名乗りの根への細工。
    //
    // honden は布陣内の名乗りを tmux の pane 属性 `@agent_id` から引く。
    // だがそれは pane の属性であり、**その pane に座る当人が書き換えうる**
    // （権限表の突き合わせ 2026-08-28）。書き換えられれば、以後の名乗りは
    // すべて偽となり、台帳の actor まで偽になる——跡が嘘をつく方が、
    // 跡が無いより悪い。
    //
    // 名簿の入れ替え（roster sync）と混同せぬこと。あれは正本の側の話で、
    // これは「自分が誰であるかを自分で書き換える」話である。
    id: 'D013',
    pattern: /tmux\s+(?:set-option|set|setw|set-window-option)\b[^;&|]*@agent_(?:id|cli)\b/,
    reason: '自分の名乗りを自分で書き換える形である。名乗りの根は布陣が持つ',
  },
  {
    // 他者のペインへ手を入れる形。
    //
    // D006 は `kill-server` / `kill-session` だけを塞いでおったが、tmux は
    // 他人のペインを撃つ手を他にも持つ——`respawn-pane -k` は中の CLI を
    // そのまま殺し、`send-keys` は他人の入力欄へ本文を刺す。**塞いだ手と
    // 同じ害の手が、名を変えて素通りしておった**（敵対レビュー 2026-08-29）。
    //
    // 「エージェント同士は正本を経由する」は決めとして書かれておったが、
    // 仕組みでは支えられておらなんだ。ここで支える。honden 自身の合図は
    // 芯（bin/honden nudge）から出ており CLI の hook を通らぬゆえ、
    // 塞いでも配達は止まらぬ。
    //
    // tmux は副命令の**前方一致**を受ける（`send` は `send-keys` の別名でもある）
    // ゆえ、語幹で当てる。`capture-pane` は塞がぬ——将軍が家老の様子を
    // 見るのに要り、他者を動かさぬ。
    id: 'D014',
    // 旗は値を取るものがある（`-L sock`）。旗と値の対を読み飛ばす。
    // 対の値は任意——`-2` のような値を取らぬ旗でも、後戻りで合う。
    pattern: /\btmux\s+(?:-\S+(?:\s+\S+)?\s+)*(?:send|paste|respawn|run-shell|run\b|kill-pane|kill-p\w*|kill-window|kill-w\w*)/,
    reason:
      '他者のペインへ手を入れる形である。合図は正本を経て芯が撃つ——' +
      'honden inbox write を使え。直に刺すと、働いておる者の手が止まる',
  },
  {
    // 門そのものへの細工。
    //
    // 権限表の突き合わせ（2026-08-28）が最も重い穴として挙げた筋である:
    // `.cursor/hooks.json` や `.codex/hooks.json`、hook のスクリプト、
    // 判定器の binary を書き換えれば、門は**その場で外せる**。codex に
    // 至っては書き換えるだけでハッシュが変わり、未信頼の hook は黙って
    // 飛ばされる——**壊すまでもなく、触れば消える**。
    //
    // シェル経由の細工だけを止める。道具（Edit/Write）経由は CLI 側の
    // 権限設定と hook の matcher が受け持つ——ここでは届かぬ。
    // それでも置くのは、届く範囲を空けておく理由が無いからである。
    id: 'D012',
    pattern:
      /(?:>|>>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\bchmod\b|\brm\b|\btruncate\b)[^;&|]*(?:\.cursor\/hooks|\.codex\/hooks|\.claude\/settings\.json|bin\/honden|\bguard\.ts(?![\w.]))/,
    reason: '門そのものを書き換える形である。門は門で守れぬゆえ、ここで止める',
  },
  {
    id: 'D010',
    pattern: /--break-system-packages\b|--trusted-host\b|--ignore-scripts=false\b|minimumReleaseAge=0/,
    reason: '包みの守りを外す旗である。止まったら報告せよ',
  },
];

/** 機械層の裁き。OTP は見ない——それは verify の仕事。 */
export function judge(cmd: string): Verdict {
  const n = stripEnvPrefix(normalize(cmd));
  for (const r of RULES) {
    if (r.pattern.test(n)) {
      return {
        permission: 'deny',
        rule: r.id,
        reason: r.reason,
        appealable: !r.absolute,
      };
    }
  }
  return { permission: 'allow' };
}

export const OTP_DEFAULT_TTL_MS = 10 * 60_000;
/** 掟の門を発行できる者。 */
export const OTP_ISSUERS = new Set(['shogun']);

/**
 * 通行手形を切る。将軍のみ。平文の札はこの戻り値にしか存在しない。
 */
export function issue(
  db: Database,
  issuer: string | undefined,
  cmd: string,
  agent: string,
  reason: string,
  now: Date,
  ttlMs: number = OTP_DEFAULT_TTL_MS,
): { ok: true; code: string; expiresAt: string } | { ok: false; message: string } {
  if (!issuer || !OTP_ISSUERS.has(issuer)) {
    return { ok: false, message: `手形を切れるのは将軍のみである（そなたは ${issuer ?? '名乗り無し'}）` };
  }
  if (!reason.trim()) return { ok: false, message: 'なぜ通すのかを書かねば切れぬ。後から必ず引かれる' };
  const v = judge(cmd);
  if (v.permission === 'deny' && v.appealable === false) {
    return { ok: false, message: `${v.rule} は絶対域である。手形でも通せぬ（${v.reason}）` };
  }
  const code = randomBytes(6).toString('hex'); // 12 桁。打ち写せる長さ
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO guard_otp(code_hash, cmd_hash, agent, issuer, reason, issued_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(sha256(code), sha256(stripEnvPrefix(normalize(cmd))), agent, issuer, reason, now.toISOString(), expiresAt);
  journal(db, {
    actor: issuer,
    action: 'guard.grant',
    target: agent,
    detail: `cmd_hash=${sha256(stripEnvPrefix(normalize(cmd))).slice(0, 12)} reason=${JSON.stringify(reason)} ttl_ms=${ttlMs}`,
  });
  return { ok: true, code, expiresAt };
}

/**
 * 手形を検めて、良ければその場で消す（一回きり）。
 *
 * 消してから通す順である。通してから消すと、同じ札が同時に二度
 * 使われる隙間ができる。
 */
export function verify(db: Database, code: string, cmd: string, agent: string, now: Date): { ok: boolean; message: string } {
  const row = db
    .query('SELECT cmd_hash, agent, expires_at, used_at FROM guard_otp WHERE code_hash = ?')
    .get(sha256(code)) as { cmd_hash: string; agent: string; expires_at: string; used_at: string | null } | null;
  if (!row) return { ok: false, message: 'そのような手形は無い' };
  if (row.used_at) return { ok: false, message: '使用済みの手形である' };
  if (new Date(row.expires_at).getTime() < now.getTime()) return { ok: false, message: '手形の期限が切れておる' };
  if (row.agent !== agent) return { ok: false, message: `その手形は ${row.agent} 宛である（そなたは ${agent}）` };
  if (row.cmd_hash !== sha256(stripEnvPrefix(normalize(cmd)))) {
    return { ok: false, message: '手形とコマンドが一致せぬ。切られた件にしか使えぬ' };
  }
  const r = db
    .prepare('UPDATE guard_otp SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
    .run(now.toISOString(), sha256(code));
  if (r.changes !== 1) return { ok: false, message: '使用済みの手形である' }; // 同時使用の競り負け
  journal(db, {
    actor: agent,
    action: 'guard.pass',
    target: agent,
    detail: `cmd_hash=${row.cmd_hash.slice(0, 12)} code_hash=${sha256(code).slice(0, 12)}`,
  });
  return { ok: true, message: '手形を検めた。この一度だけ通る' };
}

/**
 * 検分のための事実の束。**正本からだけ引く。**
 *
 * 直訴を裁く時、弁明を鵜呑みにせず系譜を突き合わせよ——という作法を、
 * 心得ではなく手続きにする。将軍が自分で裁く時も、別の器（十四・十五）に
 * 渡す時も、同じ束を見る。
 *
 * 別の器へ渡す時が肝要である: 検分者は Bash を持たぬ（持たせれば同じ pane
 * ゆえ「将軍」として手形を切れてしまう）。ゆえに**自分では調べられぬ**。
 * この束が検分者の見る世界のすべてになる——だからこそ、集める側が
 * 機械でなければならない。
 *
 * 弁明（appeal_reason）は入れてよいが、必ず「申し立て」として畳んで渡す。
 * 検分者への指示として読ませてはならぬ。
 */
export interface Facts {
  command: string;
  verdict: Verdict;
  agent: string;
  appeal_reason: string | null;
  task: { task_id: string | null; status: string; cmd_id: string | null; updated_at: string } | null;
  cmd: { id: string; purpose: string | null; north_star: string | null; status: string; project: string | null } | null;
  claims: { kind: string; value: string; source: string; at: string }[];
  recent_reports: { at: string; summary: string }[];
  recent_guard: { at: string; action: string; detail: string }[];
}

export function facts(db: Database, agent: string, cmd: string, appealReason?: string): Facts {
  const body = stripEnvPrefix(normalize(cmd));
  const task = db
    .query('SELECT task_id, status, cmd_id, updated_at FROM task WHERE agent = ?')
    .get(agent) as Facts['task'];
  const cmdRow = task?.cmd_id
    ? (db
        .query('SELECT id, purpose, north_star, status, project FROM cmd WHERE id = ?')
        .get(task.cmd_id) as Facts['cmd'])
    : null;
  const claims = db
    .query(
      'SELECT kind, value, source, at FROM claim WHERE agent = ? AND released_at IS NULL ORDER BY at DESC LIMIT 20',
    )
    .all(agent) as Facts['claims'];
  const recent_reports = db
    .query(
      `SELECT COALESCE(created_at, '') at, substr(raw, 1, 200) summary FROM report
       WHERE agent = ? ORDER BY created_at DESC LIMIT 3`,
    )
    .all(agent) as Facts['recent_reports'];
  const recent_guard = db
    .query(
      `SELECT at, action, detail FROM ledger
       WHERE action LIKE 'guard%' AND (actor = ? OR target = ?) ORDER BY at DESC LIMIT 5`,
    )
    .all(agent, agent) as Facts['recent_guard'];

  return {
    command: body,
    verdict: judge(body),
    agent,
    appeal_reason: appealReason ?? null,
    task,
    cmd: cmdRow,
    claims,
    recent_reports,
    recent_guard,
  };
}

/** 門が生きておるかの検め。一つの CLI につき一行。 */
export interface GateCheck {
  cli: string;
  /** 設定が据わっておるか。 */
  configured: boolean;
  /** 実際に禁じ手を差し出して deny が返るか。 */
  denies: boolean;
  /** 据わっておるのに効かぬ、等の但し書き。 */
  note?: string;
}

/**
 * 門が生きておるかを、実際に禁じ手を差し出して確かめる。
 *
 * **据えただけでは効かぬ**——本日だけで三度これに遭った:
 *   一、codex は未信頼の hook を黙って飛ばす（`codex exec` に信頼の出口が無い）
 *   二、hooks.json を書き換えるとハッシュが変わり、再信頼まで門が飛ぶ
 *   三、agent の名簿はセッション開始時に読まれ、据えた後は呼べぬ
 * いずれも **静かに** 門が消える形である。静かに消えるものは、
 * 定期的に叩いて確かめるほかない。
 *
 * 設定の中身を読んで「据わっておる」と判ずるだけでは足りぬ。
 * 皮を実際に走らせ、deny が返ることまで見る——それが陽性対照である。
 */
export function selftest(opts: {
  root: string;
  exists: (p: string) => boolean;
  run: (script: string, input: string) => string | null;
  /** codex の信頼記録があるか。無ければ黙って飛ばされる。 */
  codexTrusted?: (hooksPath: string) => boolean;
}): GateCheck[] {
  const probe = 'rm -rf /'; // 絶対域。どの門でも必ず deny になる形
  const out: GateCheck[] = [];

  const cursorCfg = `${opts.root}/.cursor/hooks.json`;
  const cursorSh = `${opts.root}/.cursor/hooks/guard-shell.sh`;
  {
    const configured = opts.exists(cursorCfg) && opts.exists(cursorSh);
    const res = configured ? opts.run(cursorSh, JSON.stringify({ command: probe })) : null;
    out.push({
      cli: 'cursor',
      configured,
      denies: !!res && res.includes('"permission":"deny"'),
      note: configured ? undefined : '設定か皮が無い',
    });
  }

  for (const [cli, sh, cfg] of [
    ['codex', `${opts.root}/.codex/hooks/guard.sh`, `${opts.root}/.codex/hooks.json`],
    ['claude', `${opts.root}/.claude/hooks/guard.sh`, `${opts.root}/.claude/settings.json`],
  ] as const) {
    const configured = opts.exists(cfg) && opts.exists(sh);
    const res = configured ? opts.run(sh, JSON.stringify({ tool_name: 'Bash', tool_input: { command: probe } })) : null;
    const denies = !!res && res.includes('"permissionDecision":"deny"');
    let note: string | undefined = configured ? undefined : '設定か皮が無い';
    if (cli === 'codex' && configured && opts.codexTrusted && !opts.codexTrusted(cfg)) {
      note = '**信頼の記録が無い。codex は未信頼の hook を黙って飛ばす**——対話で起こして /hooks で信頼を与えよ';
    }
    out.push({ cli, configured, denies, note });
  }
  return out;
}
