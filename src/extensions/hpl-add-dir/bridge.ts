/**
 * bridge.ts — hpl-add-dir → hpl-system-prompt 共享状态桥
 *
 * hpl-add-dir 按字母序先于 hpl-system-prompt 加载，其 before_agent_start
 * 返回的 systemPrompt 会被后者的全量组装抹掉（与 #55 ponytail 同类问题）。
 * 参照 hpl-effect-policy/bridge.ts 模式：本扩展只写状态，组装方读取并
 * 纳入最终 prompt——不依赖扩展执行顺序。
 */

import type { AddedDir } from "./context.js";

let addedDirs: AddedDir[] = [];

/** 由 system-prompt 组装时读取。 */
export function getAddedDirs(): AddedDir[] {
  return addedDirs;
}

/** 由 hpl-add-dir 每轮 before_agent_start 写入。 */
export function setAddedDirs(dirs: AddedDir[]): void {
  addedDirs = dirs;
}

/** 测试隔离用。 */
export function resetAddedDirs(): void {
  addedDirs = [];
}
