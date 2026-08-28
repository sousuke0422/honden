/**
 * 副命令ごとの手引き。
 *
 * `--help` はどの副命令でも壊れていた（2026-08-28 実測・殿の申し出で判明）:
 *
 *   honden cmd new --help      → 「help: 知らない項目」と検めに弾かれる
 *   honden task assign --help  → 役の門に弾かれて手引きへ届かぬ
 *   honden brief --help        → **指示書を丸ごと吐く**
 *   honden status --help       → **SQLite ごと落ちる**
 *   honden claim check --help  → `--help` を場所の名として扱う
 *
 * 叩き方が分からねば、読む者は探索で凌ぐ——実際に足軽が `rg --files` や
 * `package.json` を漁って辿り着いた。**凌げた時は誰も気づかぬ**ゆえ、
 * これは静かに時を食う類の欠けである。
 *
 * 手引きは差配へ届く前に返す。役の門も検めも通さぬ——
 * **「どう使うか」を問うのに、使う資格を先に問うのは筋が違う。**
 */

export interface Help {
  /** 一行の要旨。 */
  summary: string;
  /** 使い方の形。 */
  usage: string;
  /** 旗。無ければ省く。 */
  flags?: [string, string][];
  /** 例。動く形で書く——写して叩けるものにする。 */
  examples?: string[];
  /** 但し書き（誰が叩けるか・何を要するか）。 */
  notes?: string[];
}

export const HELP: Record<string, Help> = {
  'cmd new': {
    summary: '司令を書く。将軍のみ。',
    usage: 'honden cmd new <<\'EOF\'  （標準入力へ YAML）',
    notes: [
      '将軍のみ。布陣の中から叩くこと（外から役職は名乗れぬ）',
      '要る項目: north_star / purpose / acceptance_criteria / command',
      'acceptance_criteria は検証できる形で並べよ。「良くする」は条件にならぬ',
    ],
    examples: [
      `honden cmd new <<'EOF'
north_star: なぜこの司令が事業を進めるか。1〜2 文
purpose: 何をもって完了とするか。1 文
acceptance_criteria:
  - 検証できる条件を並べる
command: |
  家老への指示本文
project: honden
EOF`,
    ],
  },
  'cmd list': {
    summary: '司令を並べる。既定は動いておるものだけ。',
    usage: 'honden cmd list [--all]',
    flags: [['--all', '済んだ司令も出す']],
  },
  'cmd show': {
    summary: '司令の中身と、受け入れ条件の覆い具合を見る。',
    usage: 'honden cmd show <番号>',
    examples: ['honden cmd show cmd_2'],
  },
  'cmd amend': {
    summary: '司令を書き換える。家老と、その司令の下で働く者全員へ自ずと知らせが飛ぶ。',
    usage: 'honden cmd amend <番号> <<\'EOF\'   /   honden cmd amend <番号> --diff <差分>',
    notes: [
      '将軍のみ。閉じた司令（done / cancelled）は書き換えられぬ——やり直させるなら新しく書け',
      '受け入れ条件を変えると、変わる前に集めた証拠は覆いに数えられなくなる',
    ],
  },
  'task assign': {
    summary: '任を振る。家老のみ（将軍は --bypass で迂回できるが跡が残る）。',
    usage: 'honden task assign --agent <名> --cmd_id <番号> --title <題>',
    flags: [
      ['--agent', '振る相手'],
      ['--cmd_id', 'どの司令の下か'],
      ['--title', '任の題（本文は EOF で流せる）'],
      ['--workspace', '持ち場（明示すれば重なりを型が弾く）'],
      ['--branch', '枝（同上）'],
      ['--bloom', '難度 L1〜L6'],
      ['--bypass --reason', '将軍が家老を通さず振る。理由が要り、別の名で台帳に残る'],
    ],
    notes: [
      '家老のみ。布陣の中から叩くこと（外から役職は名乗れぬ）',
      '**明示した持ち場（--workspace / --branch）が重なれば振れぬ。** 見立ての重なりは報せるだけ',
      '振れば task_assigned が相手へ飛び、持ち場の取り置きと貸与が同時に立つ',
      '将軍の --bypass は「名の無い抜け道はいずれ常道になる」ゆえ、別の名で台帳に残す',
    ],
    examples: [
      'honden task assign --agent ashigaru1 --cmd_id cmd_2 --title "部品を数えよ"',
      'honden task assign --agent ashigaru3 --cmd_id cmd_2 --title "直せ" --workspace /path/to/repo --branch feat/x',
    ],
  },
  'inbox write': {
    summary: '報せを送る。旗でも、標準入力の YAML でも。',
    usage: 'honden inbox write --to <名> --type <種別> --from <名> --body <本文>',
    flags: [
      ['--to', '宛先（名簿に在る名）'],
      ['--type', '種別（下記のいずれか）'],
      ['--from', '差出人。布陣の外からは役職を名乗れぬ'],
      ['--body', '本文。長ければ EOF で流せ'],
      ['--dry-run', '書かずに読み戻しだけ見る'],
    ],
    notes: [
      '種別: report_received / report_completed / task_assigned / cmd_new / cmd_update / clear_command / guard_appeal / guard_grant',
      'このうち cmd_new / cmd_update / clear_command / guard_appeal / guard_grant は「急ぎ」として扱われ、相手の副命令の出力に一行載る',
      'clear_command は布陣の外から撃てぬ（相手の文脈を消すゆえ）',
    ],
    examples: [
      'honden inbox write --to karo --type cmd_new --from shogun --body "cmd_2 を書いた。実行せよ"',
      `honden inbox write <<'EOF'
to: karo
from: review_session
type: report_received
body: |
  長い本文。C:\\Users\\… も ''' も $HOME も、そのまま通る。
EOF`,
    ],
  },
  'inbox read': {
    summary: '己に届いておる報せを読む。',
    usage: 'honden inbox read [--agent <名>] [--all]',
    flags: [
      ['--agent', '他人の分を覗く（既読にはできぬ。覗いた跡が台帳に残る）'],
      ['--all', '既読のものも出す'],
    ],
  },
  'inbox ack': {
    summary: '処理した報せを既読にする。**己の分だけ。**',
    usage: 'honden inbox ack --all   /   honden inbox ack <id> [<id>…]',
    notes: ['他人の分は既読にできぬ——相手が永久に気づけなくなるゆえ'],
  },
  'inbox unread': {
    summary: '未読の数と内訳を引く。',
    usage: 'honden inbox unread [<名>]',
  },
  'report submit': {
    summary: '任の報告を出す。足軽と軍師。',
    usage: 'honden report submit <<\'EOF\'',
    notes: ['握っておる任の分しか出せぬ', '要る項目: task_id / status / summary'],
  },
  'report qc': {
    summary: '報告を検める。軍師のみ。判定は家老へ自ずと届く。',
    usage: 'honden report qc <<\'EOF\'',
    notes: [
      '判定: APPROVED / APPROVED_WITH_CONCERNS / CHANGES_REQUESTED / REJECTED',
      'checks に FAIL が一つでもあれば通す判定は弾かれる',
      '己の報告は検められぬ',
    ],
  },
  brief: {
    summary: '己の指示書を組み立てて出す。**生成物は無い**——出す時に組む。',
    usage: 'honden brief [--role <役>] [--cli <CLI>]',
    flags: [
      ['--role', '役を明示（省けば名乗りから引く。ashigaru3 は ashigaru として扱う）'],
      ['--cli', 'CLI を明示（省けば名簿から引く）'],
    ],
  },
  status: {
    summary: '布陣の様子を一枚に並べる。',
    usage: 'honden status [--json]',
    flags: [['--json', '機械へ渡す形で出す']],
    notes: ['「不在」と「待機」は別物である——pane が無い者を待機と書かぬ'],
  },
  'guard check': {
    summary: '命が禁じ手に触れるかを、実行せずに問う。',
    usage: 'honden guard check --cmd "<命>"',
    examples: ['honden guard check --cmd "git push --force origin main"'],
  },
  'guard appeal': {
    summary: '止められた命に理由があるなら、将軍へ直訴する。',
    usage: 'honden guard appeal --cmd "<命>" --reason "<なぜ要るか>"',
    notes: ['絶対域（rm -rf / ・mkfs/dd・pipe-to-shell）は直訴しても通らぬ'],
  },
  'guard grant': {
    summary: '手形を切る。将軍のみ。一度きり・期限つき・その命にしか使えぬ。',
    usage: 'honden guard grant --cmd "<命>" --agent <名> --reason "<裁定の理由>"',
    flags: [['--ttl-min', '期限（分・既定 10・上限 60）']],
    notes: ['理由が要る。後から必ず引かれるゆえ', '受けた者は HONDEN_OTP=<札> を命の頭に付けて叩く'],
  },
  'guard facts': {
    summary: '直訴を裁くための事実を、正本から集めて出す。',
    usage: 'honden guard facts --agent <名> --cmd "<命>" [--reason "<弁明>"]',
    notes: ['弁明は申し立てとして畳んで入る。指示として読ませぬため'],
  },
  'guard selftest': {
    summary: '禁じ手の門が生きておるかを、実際に叩いて確かめる。',
    usage: 'honden guard selftest [--root <場所>]',
    notes: ['**据えただけでは効かぬ**——hook の中身が変われば信頼が切れ、黙って飛ぶ'],
  },
  'claim check': {
    summary: 'その場所が空いておるかを、他人の持ち場を読まずに問う。',
    usage: 'honden claim check [path|branch] <場所>',
    examples: ['honden claim check src/nudge.ts', 'honden claim check branch feat/x'],
  },
  'decision raise': {
    summary: '殿の裁可を要する事を積む。差配役のみ。',
    usage: 'honden decision raise <<\'EOF\'',
    notes: ['選択肢が要る。「どうしましょう」は裁定にならぬ', '既定と期限を添えれば、答が無くとも倒れる先が決まる'],
  },
  decide: {
    summary: '裁可を下ろす。将軍のみ。',
    usage: 'honden decide <番号> <選び> [--note "<添え書き>"]',
  },
  peek: {
    summary: '他人の持ち場を覗く。理由が要り、台帳に残り、家老へ報せが行く。',
    usage: 'honden peek <相手> --reason "<なぜ見るか>"',
  },
  nudge: {
    summary: '未読を抱えた者へ合図を撃つ。芯が呼ぶ。',
    usage: 'honden nudge [--dry-run] [--wake-shogun --reason "<なぜ起こすか>"]',
    notes: [
      '殿が在席の間は将軍へ撃たぬ。一度きりの例外が --wake-shogun',
      '三度文脈を消させても応えぬ相手には撃つのをやめる（人の手へ回す）',
    ],
  },
  patch: {
    summary: '差分をファイルへ当てる。',
    usage: 'honden patch [--root <場所>] [--dry-run] < 差分',
    notes: ['当てた跡は台帳に残る'],
  },
  import: {
    summary: '旧環境の YAML を影として取り込む。実運用の行は上書きせぬ。',
    usage: 'honden import [--root <場所>] [--sub queue,saytask]',
  },
  log: {
    summary: '台帳を窓で読む。全件は舐めぬ——追記表は読み口で絞る。',
    usage: 'honden log [--limit 30] [--before <時刻>] [--actor <名>]',
    flags: [
      ['--limit', '何件見るか（既定 30・上限 200）'],
      ['--before', 'この時刻より前の窓を見る（出力末尾の値を渡して遡る）'],
      ['--actor', 'その者が関わった跡だけ'],
    ],
  },
  dashboard: {
    summary: '戦況を正本から組んで出す。要対応・進行中・戦果・滞り。',
    usage: 'honden dashboard',
    notes: ['生成物は作らぬ。旧 dashboard.md は肥大して書き換えが怪しくなった——読む時に組めば育たぬ'],
  },
  backup: {
    summary: '正本の写しを焼く。生きたまま・錠を止めずに。',
    usage: 'honden backup [--out <場所>] [--keep <世代数>]',
    flags: [
      ['--out', '写しの置き場（既定 ~/.honden/backups）'],
      ['--keep', '残す世代数（既定 10。溢れた古いものは刈る）'],
    ],
    notes: ['正本は一つ壊れれば全てを失う。出陣のたびに一枚焼かれる'],
  },
  export: {
    summary: '切り戻しの綱。正本を旧環境の YAML へ一度だけ吐く。',
    usage: 'honden export --out <新しい場所>',
    notes: ['生きた queue/ へ直接は書かぬ——配置は人の手で（先に退避してから写せ）'],
  },
  'roster sync': {
    summary: '顔ぶれを settings.yaml から入れ替える。',
    usage: 'honden roster sync --settings <settings.yaml>',
  },
  mode: {
    summary: '殿が在席かどうか。将軍へ合図を撃つかがこれで決まる。',
    usage: 'honden mode [attended|autonomous] [--until <時刻>]',
  },
};

/** 引数の並びから、手引きの鍵を探す。長い方を先に見る（`cmd new` が `cmd` に勝つ）。 */
export function lookup(rest: string[]): Help | null {
  const two = rest.slice(0, 2).join(' ');
  const one = rest[0] ?? '';
  return HELP[two] ?? HELP[one] ?? null;
}

export function render(key: string, h: Help): string {
  const out = [`  ${key} — ${h.summary}`, '', `  ${h.usage}`];
  if (h.flags?.length) {
    out.push('', '  旗:');
    const w = Math.max(...h.flags.map(([f]) => f.length));
    for (const [f, d] of h.flags) out.push(`    ${f.padEnd(w)}  ${d}`);
  }
  if (h.notes?.length) {
    out.push('', '  心得:');
    for (const n of h.notes) out.push(`    ・${n}`);
  }
  if (h.examples?.length) {
    out.push('', '  例:');
    for (const e of h.examples) out.push(...e.split('\n').map((l) => `    ${l}`));
  }
  return out.join('\n');
}
