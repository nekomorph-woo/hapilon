import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 扩展默认配置（map #31 决策）：
 *
 * hapilon 捆绑发行 pi-tasks / pi-subagents，少数配置值得以"捆绑发行方"
 * 身份预置（如 autoCascade——上游默认关是因为 pi 可能没装 pi-subagents，
 * 而 hapilon 捆绑了它，级联的联合体验才成立）。
 *
 * ensure 语义：目标文件**不存在时才写**；已存在（含用户手工编辑过的）
 * 一律不碰。上游默认值本身已成熟，hapilon 只写"捆绑发行方才知道"的少数几条。
 */

/** hapilon 预置的 pi-tasks 默认值（map #31 决策：级联默认开） */
const TASKS_CONFIG_DEFAULTS = { autoCascade: true };

/**
 * pi-subagents 无预置（#31 决策：outputTranscript 保持上游默认 true，
 * 用户选择保留 transcript 以便复盘）。上游"missing file is silent"，
 * 无值时不该写空文件制造噪音——若未来有预置项，在这里加一条 ensureJsonConfig。
 */

/**
 * 文件不存在时写入 defaults；存在时不碰（含解析失败——不覆盖用户数据）。
 * agentDir 不存在时创建（与 ensureQuietStartup 同模式）。
 */
function ensureJsonConfig(agentDir: string, filename: string, defaults: object): void {
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  const path = join(agentDir, filename);
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify(defaults, null, 2) + "\n", "utf8");
}

/**
 * 预置扩展的全局默认配置（幂等，首次启动生效）。
 */
export function ensureExtensionConfigs(agentDir: string): void {
  ensureJsonConfig(agentDir, "tasks-config.json", TASKS_CONFIG_DEFAULTS);
}
