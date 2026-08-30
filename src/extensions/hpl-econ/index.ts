import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "../../hapilon-home.js";
import { shouldCompress, compressOutput, type CompressResult } from "./compress.js";
import {
  readEconSettings,
  writeEconSettings,
  envDisabled,
  THRESHOLD_CHOICES,
  RETENTION_CHOICES,
  type EconSettings,
} from "./settings.js";

/**
 * hpl-econ — bash 输出压缩扩展（issue #52）。
 *
 * hook tool_result（仅 bash）：输出超阈值时替换为「头 N 行 + 省略提示 + 尾 M 行」，
 * 全文落盘供 grep；ctx_more 工具按行号取回省略片段。省略提示给行动指引
 * （实测：措辞决定 agent 是否自救）。
 *
 * 开关优先级（高→低）：/econ 会话内切换 > HAPILON_ECON_OFF env > settings.enabled。
 * CLI --no-econ 由 cli.ts 在启动时映射为会话覆盖（同 /econ 的会话内通道）。
 */

/** 会话内覆盖（/econ 或 --no-econ 设置；undefined = 跟随 settings） */
interface RuntimeOverride {
  enabled?: boolean;
  threshold?: number;
  headLines?: number;
  tailLines?: number;
}

const override: RuntimeOverride = {};

/** 压缩统计（/context 与 /econ Status 汇报） */
export const stats = {
  compactions: 0,
  originalChars: 0,
  compactChars: 0,
  retrieved: 0,
};

export function recordRetrieval(): void {
  stats.retrieved += 1;
}

export function statsLine(): string {
  const saved = stats.originalChars - stats.compactChars;
  return (
    `hpl-econ: ${stats.compactions} compactions, ` +
    `${saved >= 0 ? saved : 0} chars saved, ${stats.retrieved} ctx_more retrievals`
  );
}

let logDir: string | undefined;
function logCompact(result: CompressResult, ref: string): void {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, "econ.jsonl"),
      JSON.stringify({
        event: "compact",
        ref,
        originalChars: result.originalChars,
        compactChars: result.compactChars,
        omittedLines: result.omittedLines,
        fullOutputPath: result.fullOutputPath,
      }) + "\n",
      "utf8",
    );
  } catch {
    // 统计日志失败不阻断主流程，但也不静默——warn 可见（Make It Observable）
    console.warn("[hpl-econ] 压缩统计写入失败（继续运行）");
  }
}

/** cli.ts --no-econ 映射入口（json/rpc/-p 模式） */
export function setSessionDisabled(disabled: boolean): void {
  override.enabled = !disabled;
}

function effectiveSettings(agentDirPath: string): EconSettings {
  const base = readEconSettings(agentDirPath);
  return {
    enabled: override.enabled ?? base.enabled,
    threshold: override.threshold ?? base.threshold,
    headLines: override.headLines ?? base.headLines,
    tailLines: override.tailLines ?? base.tailLines,
  };
}

export default function hplEcon(pi: ExtensionAPI): void {
  const agentDirPath = agentDir();
  logDir = join(agentDirPath, "logs");

  const registry = new Map<string, { lines: string[]; fullOutputPath: string }>();
  let seq = 0;

  // ── ctx_more：取回省略片段（单次 ≤200 行）─────────────────────────
  pi.registerTool({
    name: "ctx_more",
    label: "Context More",
    description:
      "Retrieve omitted lines from a previously compressed (truncated) command output. " +
      "Use the ref shown in the omission notice and a 1-based line range of the omitted block.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ref id from the omission notice" },
        from: { type: "number", description: "1-based start line of the omitted block" },
        to: { type: "number", description: "1-based end line (inclusive, max 200 per call)" },
      },
      required: ["ref", "from", "to"],
    },
    execute: async (
      _toolCallId: string,
      params: { ref?: unknown; from?: unknown; to?: unknown },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const ref = String(params.ref ?? "");
      const from = Math.max(1, Number(params.from ?? 1));
      const to = Number(params.to ?? from + 199);
      const stored = registry.get(ref);
      if (!stored) {
        return {
          content: [{ type: "text" as const, text: `Unknown ref: ${ref}` }],
          details: {},
          isError: true,
        };
      }
      const cap = Math.min(to, from + 199, stored.lines.length);
      const slice = stored.lines.slice(from - 1, cap);
      recordRetrieval();
      return {
        content: [{ type: "text" as const, text: slice.join("\n") || "(empty range)" }],
        details: { ref, from, to: cap, total: stored.lines.length },
      };
    },
  });

  // ── /econ 命令：TUI 运行时开关与参数（pi-tasks /tasks 模式）──────
  pi.registerCommand("econ", {
    description: "Context economy — toggle bash output compression and tune parameters",
    handler: async (_args: string, ctx) => {
      const ui = ctx.ui;
      const main = async (): Promise<void> => {
        const s = effectiveSettings(agentDirPath);
        const onOff = s.enabled ? "Enabled" : "Disabled";
        const choice = await ui.select(
          "hpl-econ (bash output compression)",
          [
            `${s.enabled ? "●" : "○"} Compression: ${onOff} (toggle)`,
            `Threshold: ${Math.round(s.threshold / 1024)}KB`,
            `Retention: ${s.headLines}/${s.tailLines} lines`,
            `Status: ${stats.compactions} compactions, ${stats.originalChars - stats.compactChars} chars saved`,
            "Save as default",
            "Close",
          ],
        );
        if (!choice || choice === "Close") return;
        if (choice.includes("Compression")) {
          override.enabled = !s.enabled;
        } else if (choice.includes("Threshold")) {
          const labels = THRESHOLD_CHOICES.map((t) => `${Math.round(t / 1024)}KB`);
          const pick = await ui.select("Threshold", [...labels, "Back"]);
          if (pick && pick !== "Back") {
            const idx = labels.indexOf(pick);
            if (idx >= 0) override.threshold = THRESHOLD_CHOICES[idx];
          }
        } else if (choice.includes("Retention")) {
          const labels = RETENTION_CHOICES.map((r) => `${r.head}/${r.tail} lines`);
          const pick = await ui.select("Retention (head/tail)", [...labels, "Back"]);
          if (pick && pick !== "Back") {
            const idx = labels.indexOf(pick);
            if (idx >= 0) {
              override.headLines = RETENTION_CHOICES[idx].head;
              override.tailLines = RETENTION_CHOICES[idx].tail;
            }
          }
        } else if (choice.includes("Save as default")) {
          const s2 = effectiveSettings(agentDirPath);
          writeEconSettings(agentDirPath, s2);
          ui.notify(`Saved: enabled=${s2.enabled}, threshold=${Math.round(s2.threshold / 1024)}KB, retention=${s2.headLines}/${s2.tailLines}`);
          return;
        }
        await main();
      };
      await main();
    },
  });

  // ── tool_result hook：压缩 bash 输出 ─────────────────────────────
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;
    const s = effectiveSettings(agentDirPath);
    if (!s.enabled || envDisabled()) return undefined;

    const text = event.content
      .map((c) => (c.type === "text" && c.text ? c.text : ""))
      .join("\n");
    if (!shouldCompress(text, { threshold: s.threshold, headLines: s.headLines, tailLines: s.tailLines, storeDir: agentDirPath })) {
      return undefined;
    }

    const ref = `econ-${++seq}`;
    // 双层截断（#52）：内核 truncateTail 已跑过——从 details 取内核落盘路径与截断标志
    const details = event.details as
      | { truncation?: { truncated?: boolean }; fullOutputPath?: string }
      | undefined;
    const kernelPath = details?.fullOutputPath;
    const kernelTruncated = details?.truncation?.truncated ?? false;

    const storeDir = join(agentDirPath, "econ-store");
    const result = compressOutput(
      text,
      ref,
      { threshold: s.threshold, headLines: s.headLines, tailLines: s.tailLines, storeDir },
      kernelPath,
      kernelTruncated,
    );
    registry.set(ref, {
      lines: text.split("\n"),
      fullOutputPath: result.fullOutputPath,
    });
    stats.compactions += 1;
    stats.originalChars += result.originalChars;
    stats.compactChars += result.compactChars;
    logCompact(result, ref);

    return { content: [{ type: "text" as const, text: result.text }] };
  });
}
