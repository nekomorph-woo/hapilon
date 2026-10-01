/**
 * 纯选择器：配置顺序为准，provider 配额紧张的条目沉底顺延；
 * 全部紧张时不硬选——回落交由调用方处理（继承父 agent 的模型）。
 */
import { quotaNamespace } from "../hpl-quota-usage/snapshot.js";
/** hot 集合按快照命名空间判（glm 系两个 provider 入口共享一份用量）。 */
export function pickSubagentModel(entries, hotNamespaces) {
    if (entries.length === 0)
        return { kind: "none" };
    const fresh = entries.find((entry) => !hotNamespaces.has(quotaNamespace(entry.provider)));
    if (fresh)
        return { kind: "entry", entry: fresh };
    return { kind: "all-hot" };
}
