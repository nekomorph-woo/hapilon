/**
 * tier-model-arg.ts — hapi CLI 的档位模型指代解析。
 *
 * `--model tier:<opus|sonnet|haiku>[<index>]` 在启动时解析成具体 `provider/id[:thinking]`
 * 再传给 pi：pi 对不可解析的 --model 只报 diagnostic 然后静默回落默认模型，
 * 「指代没生效」比启动失败难查得多，必须在 spawn 前拦下。
 *
 * 数据源是 model-tiers-resolved.json（hpl-model-tiers 每次启动对着实时模型表重写，
 * 过期 id 不在其中），所以这里只做指位与回退，不重复验模型存在性。
 * 回退语义：index 越界时按模运算绕回档内条目（tier:haiku[99] 等价 tier:haiku[0]）；
 * 整档为空才是失败。
 */
import {
  parseTierReference,
  type ModelTier,
  type ResolvedTierModel,
  type ResolvedTierModels,
} from "../extensions/hpl-model-tiers/resolved.js";

export function modelSpec(model: ResolvedTierModel): string {
  return model.thinking ? `${model.provider}/${model.id}:${model.thinking}` : `${model.provider}/${model.id}`;
}

/** 按模运算取档内条目：越界索引绕回（与 orchestra「回落档位[0]」同向，且任意序号都有定义）。 */
export function pickTierModel(tiers: ResolvedTierModels, tier: ModelTier, index: number): ResolvedTierModel | undefined {
  const list = tiers[tier];
  if (list.length === 0) return undefined;
  const start = ((index % list.length) + list.length) % list.length;
  return list[start];
}

export interface TierModelRewrite {
  args: string[];
  /** 命中档位指代时的解析结果，供调用方留痕。 */
  resolved?: { original: string; spec: string };
  /** 指代合法但整档为空——必须失败而不是透传给 pi。 */
  error?: string;
}

/** 扫描 args 中独立成对出现的 --model <tier:…>，命中则原位替换为具体模型串。 */
export function rewriteTierModelArg(
  args: string[],
  lookup: (tier: ModelTier, index: number) => ResolvedTierModel | undefined,
): TierModelRewrite {
  const next = [...args];
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i] !== "--model") continue;
    const value = next[i + 1];
    const reference = parseTierReference(value);
    if (!reference) continue;
    const model = lookup(reference.tier, reference.index);
    if (!model) {
      return { args: next, error: `模型指代 ${value} 无法解析：${reference.tier} 档没有可用模型（检查 model-tiers 配置）` };
    }
    next[i + 1] = modelSpec(model);
    return { args: next, resolved: { original: value, spec: next[i + 1] } };
  }
  return { args: next };
}
