/**
 * 誰に振るかを決める。
 *
 * shogun の `get_recommended_model` を引き継ぐが、返すものを変える。
 *
 * ## モデル名ではなく agent を返す
 *
 * あちらはモデル名を返していた。だが家老が要るのは「誰に振るか」であって、
 * モデル名だけでは振れない。モデルと agent を結ぶのは settings.yaml の
 * cli.agents だけで、両者を突き合わせる者が居なかった。
 *
 * 実際、bloom=6 の推薦は cli.agents に居ないモデル (gpt-5.5) を返していたし、
 * 記録を足したあとは将軍のモデルを返すようになった。どちらも足軽へは振れない。
 *
 * honden は名簿を持っているので、そこで突き合わせる。役も見るので、
 * 足軽の仕事に上役が混じることもない。
 *
 * ## 能力と素性で既定の向きを逆にする
 *
 * | 見るもの | 挙げるもの | 未知の扱い |
 * |---|---|---|
 * | 能力 | 弱いものだけ | **通す**（新しいモデルは古いものより強い） |
 * | 素性 | 系統で | **止める**（新しい中国系も中国系） |
 *
 * 能力を許可制にすると、新しいモデルが出た日に表へ載るまで使えない。
 * 素性を弱いものだけの一覧にすると、新しい deepseek が素通りする。
 * settings.yaml の exclude_models は 3 つの名を並べているだけなので、
 * deepseek-v5 が出れば抜ける。だから名ではなく系統で見る。
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { journal } from './store';
import { roster, type RosterEntry } from './roster';

/** 制限を設けていないときの上限。未知のモデルもここへ落ちる。 */
export const NO_LIMIT = 6;

/**
 * モデル名から系統を割り出す。
 *
 * 名の並びで見る。表に列挙すると、新しい版が出たときに抜ける。
 * 割り出せないものは `unknown` にして、素性を問う場面では止める。
 */
export function providerOf(model: string): string {
  const m = model.toLowerCase();
  const table: [RegExp, string][] = [
    [/^claude[-.]/, 'anthropic'],
    [/^(gpt|o[1-9])[-.]/, 'openai'],
    [/^gemini[-.]/, 'google'],
    [/^deepseek[-.]/, 'deepseek'],
    [/^mimo[-.]/, 'xiaomi'],
    [/^glm[-.]/, 'zhipu'],
    [/^minimax[-.]/, 'minimax'],
    [/^qwen[-.]/, 'alibaba'],
    [/^kimi[-.]/, 'moonshot'],
    [/^(composer|auto$)/, 'cursor'],
  ];
  for (const [re, name] of table) if (re.test(m)) return name;
  return 'unknown';
}

export interface ModelLimit {
  model: string;
  maxBloom: number;
  costGroup: string | null;
}

/**
 * settings.yaml の capability_tiers を読む。
 *
 * この表は「使ってよいモデルの一覧」ではなく「能力に制限があるモデルの一覧」。
 * 表に無いモデルは制限なしとして扱う。
 */
export function readLimitsFromSettings(path: string): ModelLimit[] {
  const doc = Bun.YAML.parse(readFileSync(path, 'utf8')) as {
    capability_tiers?: Record<string, { max_bloom?: unknown; cost_group?: unknown }>;
  };
  const tiers = doc?.capability_tiers;
  if (!tiers || typeof tiers !== 'object') return [];
  return Object.entries(tiers).map(([model, spec]) => ({
    model,
    maxBloom: typeof spec?.max_bloom === 'number' ? spec.max_bloom : NO_LIMIT,
    costGroup: typeof spec?.cost_group === 'string' ? spec.cost_group : null,
  }));
}

/** 制限表を入れ替える。足すのではなく入れ替える。 */
export function syncLimits(db: Database, limits: ModelLimit[], actor = 'routing'): void {
  db.run('DELETE FROM model_limit');
  const ins = db.prepare('INSERT INTO model_limit(model, max_bloom, cost_group) VALUES (?,?,?)');
  for (const l of limits) ins.run(l.model, l.maxBloom, l.costGroup);
  journal(db, { actor, action: 'limits.sync', target: `${limits.length}件` });
}

/** そのモデルの上限。表に無ければ制限なし。 */
export function maxBloomOf(db: Database, model: string): number {
  const r = db.query('SELECT max_bloom FROM model_limit WHERE model = ?').get(model) as
    | { max_bloom: number }
    | null;
  return r ? r.max_bloom : NO_LIMIT;
}

export interface Candidate {
  agent: string;
  model: string;
  cli: string | null;
  provider: string;
  maxBloom: number;
}

export interface RecommendOptions {
  bloom: number;
  /** 上役の仕事か足軽の仕事か。省略すると両方から選ぶ。 */
  role?: 'commander' | 'worker';
  /**
   * 素性で締める。指定した系統は外す。
   *
   * **`unknown` も外す。** 割り出せない素性を通すと、新しい系統が素通りする。
   * 金融のように素性を問う場面では、これを渡すこと。
   */
  allowedProviders?: readonly string[];
  /** その仕事に就けない者（既に別の仕事を握っている等）。 */
  busy?: readonly string[];
}

export interface Switchable {
  agent: string;
  /** いま載せているモデル。 */
  from: string;
  /** 切り替え先の案。足りる中で最も軽いもの。 */
  to: string;
  /** そのモデルを載せている者が居れば、その CLI。居なければ null。 */
  cli: string | null;
  reason: string;
}

export interface Recommendation {
  ok: boolean;
  /** いまのまま振れる者。 */
  candidates: Candidate[];
  /**
   * 切り替えれば振れる者。
   *
   * いま走っていないモデルを挙げること自体は問題ない。switch_cli.sh で
   * どの agent もどのモデルへ切り替えられる。fable が過剰／不足なときに
   * opus や sonnet へ寄せる筋もある。
   *
   * 手が塞がっている者・素性で外れた者はここに載せない。切り替えても解けぬゆえ。
   */
  switchable: Switchable[];
  /** 選べなかったときの理由。誰がなぜ外れたかまで書く。 */
  message?: string;
}

/**
 * 振り先を挙げる。強い順ではなく、**足りる中で最も軽い順**に並べる。
 *
 * 一番強いものを常に選ぶと、軽い仕事で高い枠を焼く。
 * 足りていれば十分なので、`maxBloom` の小さいほうから出す。
 */
export function recommend(db: Database, opts: RecommendOptions): Recommendation {
  if (!Number.isInteger(opts.bloom) || opts.bloom < 1 || opts.bloom > 6) {
    return { ok: false, candidates: [], switchable: [], message: `bloom は 1 から 6 の整数。受け取った値: ${opts.bloom}` };
  }
  const all: RosterEntry[] = roster(db);
  if (all.length === 0) {
    return { ok: false, candidates: [], switchable: [], message: '名簿が空である。honden roster sync で入れられよ。' };
  }

  // その難度に足りるモデルを、軽い順に並べた品揃え。
  // 表に載っているものだけを見る。未知のモデルは制限なしだが、
  // 名を知らぬものを「切り替え先」として勧めることはできない。
  const catalog = (
    db.query('SELECT model, max_bloom FROM model_limit WHERE max_bloom >= ? ORDER BY max_bloom, model').all(
      opts.bloom,
    ) as { model: string; max_bloom: number }[]
  ).filter((m) => !opts.allowedProviders || opts.allowedProviders.includes(providerOf(m.model)));

  // そのモデルを今載せている者が居れば、その CLI を添える。
  const cliOf = new Map<string, string>();
  for (const e of all) if (e.model && e.cli) cliOf.set(e.model, e.cli);

  const rejected: string[] = [];
  const candidates: Candidate[] = [];
  const switchable: Switchable[] = [];

  for (const e of all) {
    if (opts.role && e.role !== opts.role) continue;
    if (!e.model) {
      rejected.push(`${e.id}: モデルが分からぬ`);
      continue;
    }
    if (opts.busy?.includes(e.id)) {
      rejected.push(`${e.id}: 別の仕事を握っておる`);
      continue;
    }
    const provider = providerOf(e.model);
    if (opts.allowedProviders && !opts.allowedProviders.includes(provider)) {
      rejected.push(`${e.id}: 系統が ${provider}（許された系統の外）`);
      continue;
    }
    const maxBloom = maxBloomOf(db, e.model);
    if (maxBloom < opts.bloom) {
      rejected.push(`${e.id}: ${e.model} は L${maxBloom} まで（L${opts.bloom} に足りぬ）`);
      // 能力だけで外れた者は、切り替えれば足りる。
      const to = catalog.find((m) => m.model !== e.model);
      if (to) {
        switchable.push({
          agent: e.id,
          from: e.model,
          to: to.model,
          cli: cliOf.get(to.model) ?? null,
          reason: `${e.model} は L${maxBloom} まで`,
        });
      }
      continue;
    }
    candidates.push({ agent: e.id, model: e.model, cli: e.cli, provider, maxBloom });
  }

  // 足りる中で最も軽い順。同じなら名の順で安定させる。
  candidates.sort((a, b) => a.maxBloom - b.maxBloom || a.agent.localeCompare(b.agent));

  if (candidates.length === 0) {
    const lines = [
      `L${opts.bloom}${opts.role ? `（${opts.role === 'worker' ? '足軽' : '上役'}）` : ''} に、いまのまま振れる者は居らぬ。`,
      ...rejected.map((r) => `    ${r}`),
    ];
    if (switchable.length > 0) {
      lines.push('  切り替えれば振れる者:');
      for (const s of switchable) {
        lines.push(
          `    ${s.agent}: ${s.from} → ${s.to}` +
            (s.cli ? `  bash scripts/switch_cli.sh ${s.agent} --type ${s.cli} --model ${s.to}` : ''),
        );
      }
    } else {
      lines.push('  仕事を分けて bloom を下げるか、手が空くのを待たれよ。');
    }
    return { ok: false, candidates: [], switchable, message: lines.join('\n') };
  }
  return { ok: true, candidates, switchable };
}
