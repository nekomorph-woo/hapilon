/**
 * metadata.ts — hpl-system-prompt 元数据共享模块
 *
 * 在 assembleSystemPrompt 完成后记录各部分内容长度，
 * 供 hpl-context-viewer 在 /context 命令中读取，
 * 实现 system prompt 组成的 token 估算分解。
 *
 * 设计来源: _plans/hpl-context-viewer.md §2.5
 */

import type { SystemPromptMeta } from "../hpl-context-viewer/types.js";

/** 最后一次 system prompt 组装元数据；null = 尚未组装 */
let lastMeta: SystemPromptMeta | null = null;

/** 记录最新元数据（由 assemble.ts 在每次组装后调用） */
export function setLastMeta(meta: SystemPromptMeta): void {
  lastMeta = meta;
}

/** 读取最后一次组装元数据；从未组装过则返回 undefined */
export function getLastMeta(): SystemPromptMeta | undefined {
  return lastMeta ?? undefined;
}

/** 清除元数据（测试用） */
export function clearLastMeta(): void {
  lastMeta = null;
}
