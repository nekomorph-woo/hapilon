import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function shouldCompress(text, params) {
    return text.length > params.threshold;
}
export function compressOutput(full, ref, params, kernelFullOutputPath, kernelTruncated = false) {
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
        notices.push(`[Note: the beginning of the original output was trimmed by the system before this view — use the paths above to recover it.]`);
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
