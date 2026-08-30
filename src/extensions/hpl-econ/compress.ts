import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * compress.ts — hpl-econ 压缩核心（纯函数，无事件依赖）。
 *
 * 输出超阈值时替换为「头 N 行 + 省略提示 + 尾 M 行」，全文落盘。
 * 省略提示的措辞是实测确定的关键变量（issue #52）：必须包含
 * 「省略行数 + 全文路径 + ctx_more 取回指引」——提示给行动指引，
 * agent 才会自救；内核的消极措辞（"you only saw the tail"）会让 agent 放弃。
 *
 * 双层截断（#52 警告段）：内核 truncateTail（50KB）先于本扩展执行，
 * >50KB 输出的头部在到达本层前已被裁剪。因此提示须同时引用内核的
 * fullOutputPath，且 kernelTruncated=true 时如实告知头部不完整。
 */

export interface EconParams {
  threshold: number;
  headLines: number;
  tailLines: number;
  storeDir: string;
}

export interface CompressResult {
  /** 替换后的 tool_result 文本 */
  text: string;
  /** 全文落盘路径（hpl-econ 自己的存储） */
  fullOutputPath: string;
  originalChars: number;
  compactChars: number;
  omittedLines: number;
}

export function shouldCompress(text: string, params: EconParams): boolean {
  return text.length > params.threshold;
}

export function compressOutput(
  full: string,
  ref: string,
  params: EconParams,
  kernelFullOutputPath?: string,
  kernelTruncated = false,
): CompressResult {
  const lines = full.split("\n");
  const head = lines.slice(0, params.headLines).join("\n");
  const tail = lines.slice(-params.tailLines).join("\n");
  // 单行超长输出（无换行）时 head/tail 是同一块——省略行数 clamp 到 0，
  // 保留区仍各自呈现（模型看到两份相同的片段，总长仍远小于原文）。
  const omitted = Math.max(0, lines.length - params.headLines - params.tailLines);

  mkdirSync(params.storeDir, { recursive: true });
  const fullOutputPath = join(params.storeDir, `${ref}.log`);
  writeFileSync(fullOutputPath, full, "utf8");

  const notices = [
    `[... ${omitted} lines omitted — full output saved to ${fullOutputPath}]`,
    `[Retrieve with the ctx_more tool (ref: ${ref}), or grep/read the full file directly.]`,
  ];
  if (kernelFullOutputPath && kernelFullOutputPath !== fullOutputPath) {
    notices.push(`[System copy also available: ${kernelFullOutputPath}]`);
  }
  if (kernelTruncated) {
    notices.push(
      `[Note: the beginning of the original output was trimmed by the system before this view — use the paths above to recover it.]`,
    );
  }

  const text = `${head}\n${notices.join("\n")}\n${tail}`;
  return {
    text,
    fullOutputPath,
    originalChars: full.length,
    compactChars: text.length,
    omittedLines: omitted,
  };
}
