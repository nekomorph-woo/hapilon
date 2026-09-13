/**
 * hpl-metrics — hapi 内置统计工具（`/hapi-metrics`）
 *
 * 子命令制，且**不带子命令时只打印用法、不执行任何分析**：统计要扫全部会话文件，
 * 一次跑全部维度既慢又没法按需扩展。每个子命令各自负责自己的数据源与渲染。
 *
 * 目前子命令：
 *   ponytail   会话级的「体量与形状」对照（token/成本/文本-代码比/编辑规模）
 *
 * 后续可加（各自独立数据源，互不影响）：
 *   quality    reviewer P0/P1、verify 通过率、返工次数
 *   tools      工具使用分布、失败率
 */
import { showFloatingPane } from "../../shared/floating-pane/index.js";
import { loadSamples, hapilonHomes } from "./sessions.js";
import { groupSamples, renderPonytailLines } from "./ponytail.js";
const GROUP_BYS = ["ponytail", "model", "day", "project"];
function flagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index < 0)
        return undefined;
    return args[index + 1];
}
/** 纯解析：用法/未知子命令都不触发扫描（测试的主要入口） */
export function parseMetricsArgs(args) {
    const argv = args.trim().split(/\s+/).filter(Boolean);
    const [sub, ...rest] = argv;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h")
        return { kind: "usage" };
    if (sub !== "ponytail")
        return { kind: "usage", reason: `未知子命令：${sub}` };
    const groupByRaw = flagValue(rest, "--group-by") ?? "ponytail";
    if (!GROUP_BYS.includes(groupByRaw)) {
        return { kind: "usage", reason: `--group-by 只支持 ${GROUP_BYS.join(" | ")}` };
    }
    const sinceRaw = flagValue(rest, "--since");
    let sinceMs;
    if (sinceRaw !== undefined) {
        const parsed = Date.parse(sinceRaw.length === 10 ? `${sinceRaw}T00:00:00Z` : sinceRaw);
        if (!Number.isFinite(parsed))
            return { kind: "usage", reason: `--since 无法解析：${sinceRaw}` };
        sinceMs = parsed;
    }
    return {
        kind: "ponytail",
        groupBy: groupByRaw,
        sinceMs,
        project: flagValue(rest, "--project"),
        json: rest.includes("--json"),
    };
}
export function usageText(reason) {
    return [
        ...(reason ? [`✗ ${reason}`, ""] : []),
        "用法：/hapi-metrics <子命令> [选项]",
        "",
        "子命令：",
        "  ponytail               会话级「体量与形状」对照（按档位/模型/天/项目分组）",
        "",
        "ponytail 选项：",
        "  --group-by <档>        ponytail | model | day | project（默认 ponytail）",
        "  --since <YYYY-MM-DD>   只看该日期之后开始的会话",
        "  --project <子串>       按 cwd 过滤",
        "  --json                 输出 JSON（给后续工具/脚本用）",
        "",
        "不带子命令只打印本用法，不执行任何统计（子命令各自独立，便于扩展与控耗时）。",
    ].join("\n");
}
function notify(ctx, message, type = "info") {
    ctx.ui?.notify?.(message, type);
}
export default function hplMetrics(pi) {
    pi.registerCommand("hapi-metrics", {
        description: "hapi 内置统计工具（子命令制：ponytail …）",
        handler: async (args, ctx) => {
            const invocation = parseMetricsArgs(args);
            if (invocation.kind === "usage") {
                notify(ctx, usageText(invocation.reason), invocation.reason ? "warning" : "info");
                return;
            }
            const homes = hapilonHomes();
            const samples = loadSamples({
                ...(invocation.sinceMs !== undefined ? { sinceMs: invocation.sinceMs } : {}),
                ...(invocation.project ? { project: invocation.project } : {}),
            });
            const groups = groupSamples(samples, invocation.groupBy);
            if (invocation.json) {
                notify(ctx, JSON.stringify({
                    groupBy: invocation.groupBy,
                    samples: samples.length,
                    groups,
                }, null, 1));
                return;
            }
            const meta = {
                homes,
                groupBy: invocation.groupBy,
                samples: samples.length,
                ponytailFromSession: samples.filter((sample) => sample.ponytailSource === "session").length,
                ...(invocation.project ? { project: invocation.project } : {}),
                ...(invocation.sinceMs !== undefined ? { since: new Date(invocation.sinceMs).toISOString().slice(0, 10) } : {}),
            };
            await showFloatingPane(ctx, {
                title: `hapi metrics · ponytail · ${invocation.groupBy}`,
                lines: renderPonytailLines(groups, meta),
                footer: "Esc 关闭 · 体量 ≠ 正确性",
                width: "fit-content",
                maxHeight: 90,
            });
        },
    });
}
