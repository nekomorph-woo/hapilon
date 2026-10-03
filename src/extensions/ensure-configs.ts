import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { ConfigWriteError } from "../config/config-io.js";

/**
 * 扩展默认配置：
 *
 * hapilon 捆绑发行 pi-tasks / pi-subagents，少数配置值得以"捆绑发行方"
 * 身份预置（如 autoCascade——上游默认关是因为 pi 可能没装 pi-subagents，
 * 而 hapilon 捆绑了它，级联的联合体验才成立）。
 *
 * ensure 语义：目标文件不存在时写入 defaults；已存在时只补齐**缺失的顶层键**
 * （存量安装靠这一步拿到后续新增的默认值），用户写过的键一律保留。
 * 上游默认值本身已成熟，hapilon 只写"捆绑发行方才知道"的少数几条。
 */

/**
 * hapilon 预置的 pi-tasks 默认值：
 * - autoCascade 默认开：级联依赖 pi-subagents，上游默认关是因为 pi 可能没装它。
 * - taskScope 用 session-global：上游默认 session 会把 tasks-<sessionId>.json
 *   写进项目根 .pi/tasks/，那是运行时状态而非项目内容；session-global 让它落到
 *   <agentDir>/tasks/sessions/<projectKey>/，用户仓库保持干净（上游原生配置，升级免疫）。
 */
const TASKS_CONFIG_DEFAULTS = { autoCascade: true, taskScope: "session-global" };

/**
 * pi-subagents 无预置（决策：outputTranscript 保持上游默认 true，
 * 用户选择保留 transcript 以便复盘）。上游"missing file is silent"，
 * 无值时不该写空文件制造噪音——若未来有预置项，在这里加一条 ensureJsonConfig。
 */

/**
 * pi-web-access 预置：workflow 改 none——上游默认 summary-review
 * 会在每次 web_search 时弹浏览器 curator 审查页，对终端工作流是打断；
 * 需要人工审查时 /websearch 命令仍可手动开启。
 */
const WEB_ACCESS_CONFIG_DEFAULTS = { workflow: "none" };

/**
 * pi-mcp-adapter 预置：空 mcpServers 骨架——给用户与 agent 一个
 * 明确的配置落点（写入用 hapi mcp add 或让 agent 按 system prompt 指引写）。
 * 仅当文件不存在时写，已有 server 配置永不触碰。
 */
const MCP_CONFIG_DEFAULTS = { mcpServers: {} };

/**
 * hpl-econ 预置：组合甲默认。文件缺省时扩展自身回落同款默认，
 * 这里播种实体文件让用户看得到、改得了。
 */
const ECON_CONFIG_DEFAULTS = { enabled: true, threshold: 8192, headLines: 40, tailLines: 20 };

/**
 * 文件不存在时写入 defaults；存在时补齐缺失的顶层键，用户已设置的键与损坏
 * 文件（解析失败）一律不碰。agentDir 不存在时创建（与 ensureQuietStartup 同模式）。
 */
const ensureJsonConfigEffect = (agentDir: string, filename: string, defaults: object): Effect.Effect<void, ConfigWriteError> => Effect.gen(function* () {
  if (!existsSync(agentDir)) {
    yield* Effect.try({
      try: () => mkdirSync(agentDir, { recursive: true, mode: 0o700 }),
      catch: (err) => new ConfigWriteError({ message: err instanceof Error ? err.message : String(err) }),
    });
  }
  const path = join(agentDir, filename);
  const write = (value: object) => Effect.try({
    try: () => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8"),
    catch: (err) => new ConfigWriteError({ message: err instanceof Error ? err.message : String(err) }),
  });

  if (!existsSync(path)) return yield* write(defaults);

  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // 损坏文件不碰：解析失败不覆盖用户数据
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return;
  const record = existing as Record<string, unknown>;
  if (Object.keys(defaults).every((key) => key in record)) return; // 幂等
  yield* write({ ...defaults, ...record });
});

/**
 * hapilon 主题：仓库 resources/themes 直接当 pi 的主题目录用（settings.themes 通道）。
 *
 * 为什么不必走扩展的 resources_discover/themePaths 贡献：pi 在扩展资源合并之前就
 * initTheme(settings.theme) 并跑过一次 applyFromSettings()（interactive-mode 先建
 * ThemeController，之后才 bindExtensions 合并扩展贡献），那时主题还不在注册表里，
 * 默认选中会先报 "Failed to load theme" 再回落 dark。settings.themes 是资源装载器
 * 构建期就有的输入（package-manager 读 globalSettings.themes），且同一份列表既喂给
 * 冷启动的 initTheme，也喂给 /settings 的主题列表。
 */
const HAPILON_THEME_FILES = ["hapilon-light.json", "hapilon-dark.json"];

/**
 * 未设置 theme 时的默认主题：pi 的 settings.theme 支持 "浅色/深色" 配对语法
 * （settings-manager.getThemeSetting → theme.js resolveThemeSetting/parseAutoThemeSetting，
 * 与 CLI 的 --use-theme light/dark 同一条路径，对自定义主题名同样生效），
 * 于是跟随终端明暗自动切换。用户在 /settings 改过则永不再覆盖。
 */
const DEFAULT_THEME = "hapilon-light/hapilon-dark";

/** 仓库内主题源目录（本模块编译后在 dist/extensions/ 下） */
function hapilonThemesSourceDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "themes");
}

/** 识别 settings.themes 里属于 hapilon 的那条（仓库换路径后旧条目靠它剔除） */
function isHapilonThemesPath(entry: string): boolean {
  return entry.replaceAll("\\", "/").endsWith("/resources/themes");
}

/**
 * settings.json：themes 里常驻 hapilon 主题目录，theme 缺省时种子为 hapilon-light/hapilon-dark。
 * 用户自己填的 themes 条目与已选主题一律保留。
 */
const ensureThemeSettingsEffect = (agentDir: string): Effect.Effect<void, ConfigWriteError> => Effect.gen(function* () {
  const sourceDir = hapilonThemesSourceDir();
  const missing = HAPILON_THEME_FILES.filter((file) => !existsSync(join(sourceDir, file)));
  if (missing.length > 0) {
    return yield* Effect.fail(new ConfigWriteError({
      message: `[hapilon] 主题文件缺失：${sourceDir} 下缺 ${missing.join("、")}。安装不完整，请重新 npm ci && npm run build。`,
    }));
  }
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return; // 首次启动由 ensureQuietStartup 建文件，下一轮再种子

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`Warning: ${path} 解析失败，跳过主题设置写入`);
    return;
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    console.warn(`Warning: ${path} 不是 JSON object，跳过主题设置写入`);
    return;
  }
  const existing = settings as Record<string, unknown>;

  if (existing.themes !== undefined && !Array.isArray(existing.themes)) {
    console.warn(`Warning: ${path} 的 themes 不是数组，跳过主题设置写入`);
    return;
  }
  const userThemes = (existing.themes ?? []) as unknown[];
  const kept = userThemes.filter((entry) => !(typeof entry === "string" && isHapilonThemesPath(entry)));
  const nextThemes = [...kept, sourceDir];
  const themesChanged = JSON.stringify(userThemes) !== JSON.stringify(nextThemes);
  const needsDefaultTheme = typeof existing.theme !== "string";
  if (!themesChanged && !needsDefaultTheme) return; // 幂等

  existing.themes = nextThemes;
  if (needsDefaultTheme) existing.theme = DEFAULT_THEME;
  yield* Effect.try({
    try: () => writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8"),
    catch: (err) => new ConfigWriteError({ message: err instanceof Error ? err.message : String(err) }),
  });
});

/**
 * vision 子代理定义：agentDir/agents/vision.md 不存在时播种。模型不写在定义里
 * ——由 vision-models 列表在派发时改写（未配置时回落父模型并告警）。
 * 用户已有同名文件永不覆盖。
 */
const VISION_AGENT_MD = `---
name: vision
display_name: Vision
prompt_mode: replace
description: 图像/截图分析专用子代理（多模态模型派发）。看图专注、证据落地。派发时必须给全：图片路径、要回答的问题、判断/验收标准、期望输出格式；不齐会追问。适用：UI 截图审查、视觉回归比对、图表/照片内容提取。
---

你是视觉分析子代理，搭载多模态模型——读图是你的核心能力，也是你被派来的原因。你看图，主会话不看：你返回的每一句观察就是主会话唯一的「眼睛」。

## 看图纪律

- 真切地看图：逐区域扫描（整体布局→各区域→细节），不扫一眼就下结论。像素证据优先于猜测：对齐/溢出/遮挡/裁剪/文字渲染/色彩/状态，逐项核实。
- 观察与判断分开：先说看到了什么（引用图中可见文本、位置、区域），再下判断；判断必须能指回可见证据。
- 不知道就说不知道：图里看不清/被截断/无法判定的，明确说「无法判定+缺什么」，绝不编造画面内容。
- 通用性：不限于 UI——照片、图表、扫描件、示意图都按同一纪律处理：先描述可见事实，再回答派发问题。

## 输入契约（派发方应给全；缺了就追问，不猜）

1. 图片路径（一张或多张）
2. 要回答的具体问题（「看看有没有问题」不算问题——追问具体维度）
3. 判断/验收标准（什么算对、什么算错；没有标准则先声明你的判断依据）
4. 期望输出格式（清单/表格/逐项结论）

输入不齐时：先列出缺什么、按声明过的假设继续，把假设写在结论前——不许默默猜。

## 输出格式

- 逐项结论：观察（可见证据）→ 判断（Pass/Concern/Fail/无法判定）→ 依据
- 末尾附「未检查项」：没看过的维度明说，不营造全部检查过的印象
- 只描述与派发问题相关的内容，不复述整张图；文字结论自包含，主会话不再看图
`;

const ensureVisionAgentEffect = (agentDir: string): Effect.Effect<void, ConfigWriteError> => Effect.gen(function* () {
  const path = join(agentDir, "agents", "vision.md");
  if (existsSync(path)) return;
  yield* Effect.try({
    try: () => {
      mkdirSync(join(agentDir, "agents"), { recursive: true, mode: 0o700 });
      writeFileSync(path, VISION_AGENT_MD, "utf8");
    },
    catch: (err) => new ConfigWriteError({ message: err instanceof Error ? err.message : String(err) }),
  });
});

/**
 * 预置扩展的全局默认配置（幂等，首次启动生效）。
 */
export const ensureExtensionConfigsEffect = (agentDir: string): Effect.Effect<void, ConfigWriteError> => Effect.gen(function* () {
  yield* ensureJsonConfigEffect(agentDir, "tasks-config.json", TASKS_CONFIG_DEFAULTS);
  // pi-web-access：workflow:none 不弹浏览器；fff/ask-user/btw 无必配项
  yield* ensureJsonConfigEffect(agentDir, "web-search.json", WEB_ACCESS_CONFIG_DEFAULTS);
  // pi-mcp-adapter：空骨架给 mcp.json 一个明确落点；用户配置永不覆盖
  yield* ensureJsonConfigEffect(agentDir, "mcp.json", MCP_CONFIG_DEFAULTS);
  // hpl-econ：组合甲默认实体化
  yield* ensureJsonConfigEffect(agentDir, "econ-config.json", ECON_CONFIG_DEFAULTS);
  // vision 子代理定义：全局 agents 目录播种（用户已自定义则不碰）
  yield* ensureVisionAgentEffect(agentDir);
  // 主题：仓库主题目录挂进 settings.themes，默认选中 hapilon-light/hapilon-dark（跟随终端明暗）
  yield* ensureThemeSettingsEffect(agentDir);
});

export function ensureExtensionConfigs(agentDir: string): void {
  const result = Effect.runSync(Effect.either(ensureExtensionConfigsEffect(agentDir)));
  if (result._tag === "Left") throw new Error(result.left.message);
}
