import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 * pi-web-access 预置（#42 决策）：workflow 改 none——上游默认 summary-review
 * 会在每次 web_search 时弹浏览器 curator 审查页，对终端工作流是打断；
 * 需要人工审查时 /websearch 命令仍可手动开启。
 */
const WEB_ACCESS_CONFIG_DEFAULTS = { workflow: "none" };
/**
 * pi-mcp-adapter 预置（#49）：空 mcpServers 骨架——给用户与 agent 一个
 * 明确的配置落点（写入用 hapi mcp add 或让 agent 按 system prompt 指引写，
 * 见 #50）。仅当文件不存在时写，已有 server 配置永不触碰。
 */
const MCP_CONFIG_DEFAULTS = { mcpServers: {} };
/**
 * hpl-econ 预置（#52）：组合甲默认。文件缺省时扩展自身回落同款默认，
 * 这里播种实体文件让用户看得到、改得了。
 */
const ECON_CONFIG_DEFAULTS = { enabled: true, threshold: 8192, headLines: 40, tailLines: 20 };
/**
 * 文件不存在时写入 defaults；存在时不碰（含解析失败——不覆盖用户数据）。
 * agentDir 不存在时创建（与 ensureQuietStartup 同模式）。
 */
function ensureJsonConfig(agentDir, filename, defaults) {
    if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    }
    const path = join(agentDir, filename);
    if (existsSync(path))
        return;
    writeFileSync(path, JSON.stringify(defaults, null, 2) + "\n", "utf8");
}
/**
 * 预置扩展的全局默认配置（幂等，首次启动生效）。
 */
export function ensureExtensionConfigs(agentDir) {
    ensureJsonConfig(agentDir, "tasks-config.json", TASKS_CONFIG_DEFAULTS);
    // pi-web-access（#43）：workflow:none 不弹浏览器；fff/ask-user/btw 无必配项
    ensureJsonConfig(agentDir, "web-search.json", WEB_ACCESS_CONFIG_DEFAULTS);
    // pi-mcp-adapter（#49）：空骨架给 mcp.json 一个明确落点；用户配置永不覆盖
    ensureJsonConfig(agentDir, "mcp.json", MCP_CONFIG_DEFAULTS);
    // hpl-econ（#52）：组合甲默认实体化
    ensureJsonConfig(agentDir, "econ-config.json", ECON_CONFIG_DEFAULTS);
}
