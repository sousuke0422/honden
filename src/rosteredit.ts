/**
 * 顔ぶれを settings.yaml へ書き戻す。
 *
 * # なぜ YAML を組み直さぬか
 *
 * settings.yaml は注釈で成り立っている。なぜその模型か、なぜ軍師が最後か、
 * 何を試して駄目だったか——**解いて組み直せば全部消える。**
 * ゆえに行のまま扱い、値だけを差し替える。
 *
 * # 書く前に読み返す
 *
 * 行を弄った結果が意図と合っているかを、書く前に YAML として解き直して
 * 確かめる。合わねば書かぬ。**「直したつもり」で壊れた設定を残さぬ。**
 *
 * # 上流の教訓
 *
 * yohey-w/multi-agent-shogun#156 は同じ道具を Python で作り、選べる CLI の
 * 一覧が実態（cursor が居る）と合わず差し戻された。選べる物を並べるのが
 * 役目の道具で、並べ漏れは根の欠陥である。ここでは一覧を一つに置き、
 * 出陣（`scripts/shutsujin.sh`）が起こせる物と揃っていることを試験で見る。
 */

/** 出陣が起こせる CLI。`scripts/shutsujin.sh` の `cli_of` と揃える（試験あり）。 */
export const LAUNCHABLE_CLIS = ['claude', 'cursor', 'codex', 'opencode'] as const;
export type Cli = (typeof LAUNCHABLE_CLIS)[number];

export const isCli = (s: string): s is Cli => (LAUNCHABLE_CLIS as readonly string[]).includes(s);

/** 一人ぶんの差し替え。省いた欄は触らぬ。 */
export interface Change {
  id: string;
  cli?: string;
  model?: string;
}

export interface Plan {
  changes: Change[];
  /** 足軽の頭数。省けば触らぬ。増やす分の cli/model は changes に要る。 */
  workers?: number;
}

export type EditResult =
  | { ok: true; text: string; summary: string[] }
  | { ok: false; message: string };

/** 現状の一人ぶん。 */
export interface Current {
  id: string;
  cli: string | null;
  model: string | null;
}

const AGENT_RE = /^ {4}([A-Za-z0-9_]+):\s*(#.*)?$/;
const ATTR_RE = /^ {6}(type|model):\s*([^#]*?)\s*(#.*)?$/;

interface Block {
  id: string;
  head: number; // 見出し行
  end: number; // 次の見出しの手前（排他的）。空行と注釈は含む
}

/** `cli.agents` の下の、各自の行の範囲。 */
function blocks(lines: string[]): { agentsAt: number; blocks: Block[] } | null {
  let cliAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^cli:\s*(#.*)?$/.test(lines[i]!)) { cliAt = i; break; }
  }
  if (cliAt < 0) return null;
  let agentsAt = -1;
  for (let i = cliAt + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l)) break; // cli: の外へ出た
    if (/^ {2}agents:\s*(#.*)?$/.test(l)) { agentsAt = i; break; }
  }
  if (agentsAt < 0) return null;

  const out: Block[] = [];
  let i = agentsAt + 1;
  let stop = lines.length;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    // 字下げ 2 以下の実体行で agents: が終わる
    if (l.trim() !== '' && !l.trim().startsWith('#') && !/^ {3}/.test(l)) { stop = i; break; }
  }
  for (let k = agentsAt + 1; k < stop; k++) {
    const m = AGENT_RE.exec(lines[k]!);
    if (m) out.push({ id: m[1]!, head: k, end: stop });
  }
  for (let b = 0; b < out.length - 1; b++) out[b]!.end = out[b + 1]!.head;
  // 末尾の空行・注釈は最後の塊に含めぬ（挿す位置がずれる）
  const last = out[out.length - 1];
  if (last) {
    let e = last.end;
    while (e > last.head + 1 && lines[e - 1]!.trim() === '') e--;
    last.end = e;
  }
  return { agentsAt, blocks: out };
}

/** いまの顔ぶれ（行から読む。YAML 解きと同じ答えになるべき——試験で見る）。 */
export function current(text: string): Current[] {
  const lines = text.split('\n');
  const b = blocks(lines);
  if (!b) return [];
  return b.blocks.map((blk) => {
    let cli: string | null = null;
    let model: string | null = null;
    for (let i = blk.head + 1; i < blk.end; i++) {
      const m = ATTR_RE.exec(lines[i]!);
      if (!m) continue;
      const v = m[2]!.trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'type') cli = v;
      else model = v;
    }
    return { id: blk.id, cli, model };
  });
}

/** 属性の値だけを差し替える。末尾の注釈は残す。無ければ見出しの直下へ挿す。 */
function setAttr(lines: string[], blk: Block, key: 'type' | 'model', value: string): number {
  for (let i = blk.head + 1; i < blk.end; i++) {
    const m = ATTR_RE.exec(lines[i]!);
    if (m && m[1] === key) {
      const tail = m[3] ? `   ${m[3]}` : '';
      lines[i] = `      ${key}: ${value}${tail}`;
      return 0;
    }
  }
  // type は model より先に置く
  const at = key === 'type' ? blk.head + 1 : blk.end;
  lines.splice(at, 0, `      ${key}: ${value}`);
  return 1;
}

const workerNo = (id: string): number | null => {
  const m = /^ashigaru([1-9])$/.exec(id);
  return m ? Number(m[1]) : null;
};

/**
 * 差し替えを行に当てる。**書かぬ。** 呼ぶ側が中身を見てから書く。
 */
export function apply(text: string, plan: Plan): EditResult {
  const lines = text.split('\n');
  const b = blocks(lines);
  if (!b) return { ok: false, message: 'cli.agents が見つからぬ。行の形が違う（`cli:` の下に 2 字下げの `agents:`）。' };

  const summary: string[] = [];
  const byId = new Map(b.blocks.map((x) => [x.id, x]));

  // ── 頭数 ──
  if (plan.workers !== undefined) {
    const n = plan.workers;
    if (!Number.isInteger(n) || n < 1 || n > 7) return { ok: false, message: `足軽は 1〜7。${n} は受けぬ。` };
    const have = b.blocks.map((x) => workerNo(x.id)).filter((x): x is number => x !== null);
    const max = have.length ? Math.max(...have) : 0;
    // 減らす: 後ろから消す。行を消すと以降の番地がずれるゆえ、後ろから
    for (let k = max; k > n; k--) {
      const blk = byId.get(`ashigaru${k}`);
      if (!blk) continue;
      // 塊の末尾に並ぶ注釈と空行は**次の者のもの**（「gunshi MUST stay last」が
      // 足軽を消した拍子に消えた・試験が釣った）。消すのは自分の行まで
      let end = blk.end;
      while (end > blk.head + 1) {
        const t = lines[end - 1]!.trim();
        if (t === '' || t.startsWith('#')) end--;
        else break;
      }
      lines.splice(blk.head, end - blk.head);
      summary.push(`  ashigaru${k}  消した`);
    }
    // 増やす: 軍師の手前へ。軍師は最後に置く定め（settings.yaml の注釈）
    if (n > max) {
      const fresh = blocks(lines)!; // 消した後の番地で引き直す
      const gunshi = fresh.blocks.find((x) => x.id === 'gunshi');
      const tail = fresh.blocks[fresh.blocks.length - 1];
      let at = gunshi ? gunshi.head : tail ? tail.end : fresh.agentsAt + 1;
      // 軍師の直前に並ぶ注釈（「gunshi MUST stay last」）は軍師のもの。その上に挿す
      while (gunshi && at > 0 && lines[at - 1]!.trim().startsWith('#')) at--;
      for (let k = max + 1; k <= n; k++) {
        const id = `ashigaru${k}`;
        const c = plan.changes.find((x) => x.id === id);
        if (!c?.cli) return { ok: false, message: `${id} を足すには cli が要る（例: --${id} codex:gpt-5.6-sol）。` };
        if (!c.model) return { ok: false, message: `${id} を足すには model も要る。CLI だけ差して model を落とすと黙って動かぬ（2026-08-04 の実例）。` };
        const block = [`    ${id}:`, `      type: ${c.cli}`, `      model: ${c.model}`];
        lines.splice(at, 0, ...block);
        at += block.length;
        summary.push(`  ${id}  足した  ${c.cli} ${c.model}`);
      }
    }
  }

  // ── 差し替え ──
  const now = blocks(lines);
  if (!now) return { ok: false, message: '頭数を変えた後で cli.agents を見失った。書かぬ。' };
  const cur = new Map(now.blocks.map((x) => [x.id, x]));
  for (const c of plan.changes) {
    const blk = cur.get(c.id);
    if (!blk) {
      if (workerNo(c.id) !== null && plan.workers !== undefined) continue; // 足した/消した分は上で済み
      return { ok: false, message: `${c.id} は cli.agents に居らぬ。` };
    }
    if (c.cli !== undefined && !isCli(c.cli)) {
      return { ok: false, message: `${c.id}: ${c.cli} は起こせる CLI に無い（${LAUNCHABLE_CLIS.join(' / ')}）。` };
    }
    const before = current(lines.join('\n')).find((x) => x.id === c.id)!;
    let grew = 0;
    if (c.cli !== undefined && c.cli !== before.cli) grew += setAttr(lines, blk, 'type', c.cli);
    blk.end += grew;
    if (c.model !== undefined && c.model !== before.model) setAttr(lines, blk, 'model', c.model);
    // 番地がずれるゆえ、以降の塊は引き直す
    const re = blocks(lines)!;
    cur.clear();
    for (const x of re.blocks) cur.set(x.id, x);
    const after = current(lines.join('\n')).find((x) => x.id === c.id)!;
    if (after.cli !== before.cli || after.model !== before.model) {
      summary.push(`  ${c.id.padEnd(10)} ${before.cli ?? '-'} ${before.model ?? '-'}  →  ${after.cli ?? '-'} ${after.model ?? '-'}`);
    }
  }

  // ── 書く前に読み返す ──
  const out = lines.join('\n');
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(out);
  } catch (e) {
    return { ok: false, message: `直した結果が YAML として解けぬ。書かぬ: ${String(e).slice(0, 160)}` };
  }
  const agents = (doc as { cli?: { agents?: Record<string, { type?: unknown; model?: unknown }> } })?.cli?.agents ?? {};
  for (const c of current(out)) {
    const a = agents[c.id];
    if (!a || (a.type ?? null) !== c.cli || (a.model ?? null) !== c.model) {
      return { ok: false, message: `直した結果を解き直すと ${c.id} が意図と合わぬ。書かぬ。` };
    }
  }
  if (plan.workers !== undefined) {
    const ws = Object.keys(agents).filter((k) => workerNo(k) !== null).length;
    if (ws !== plan.workers) return { ok: false, message: `頭数が ${plan.workers} にならぬ（${ws}）。書かぬ。` };
  }
  return { ok: true, text: out, summary };
}

/**
 * その CLI で使えそうな模型。`capability_tiers` の cost_group と、
 * いま同じ CLI を使っている者の模型から拾う。**当てずっぽうは出さぬ。**
 */
export function suggestModels(doc: unknown, cli: string, cur: Current[]): string[] {
  const group: Record<string, string> = { claude: 'claude_max', cursor: 'cursor', codex: 'codex' };
  const tiers = (doc as { capability_tiers?: Record<string, { cost_group?: unknown }> })?.capability_tiers ?? {};
  const out = new Set<string>();
  for (const c of cur) if (c.cli === cli && c.model) out.add(c.model);
  const g = group[cli];
  if (g) for (const [m, t] of Object.entries(tiers)) if (t?.cost_group === g) out.add(m);
  return [...out];
}
