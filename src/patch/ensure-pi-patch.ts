import { accessSync, constants, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi / 第三方扩展补丁（自补丁器，替代 patch-package）。
 *
 * 背景：编辑器触发门、后台任务插件的 Windows shell、subagent 配置目录
 * 等上游没有扩展点的行为改动，都靠这张表补；patch-package 在非 dev 安装
 * （全局 tarball）下没有 devDeps 可依赖，所以改成这份零依赖、幂等的字符串
 * 级补丁表；postinstall 与 hapilon 启动链都调用它（pi 单独升级时 postinstall
 * 不会跑，靠启动链补上）。
 *
 * 韧性优先于完整性：升级导致锚点失配时**只警告不阻断**。

/** 补丁锚点目标包 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** 第二目标包:编辑器组件在 pi-tui 里(与 pi 同 scope、同层安装) */
const PI_TUI_PACKAGE = "@earendil-works/pi-tui";

/** 补丁标记:仅作无 marker 规则的回退（当前表内所有规则均自带 marker） */
const PATCH_MARKER = "__hapilonPatched";
/** 中段 slash 触发钩子的 marker(editor 触发门补丁专用) */
const MID_TEXT_SLASH_MARKER = "__hapiMidTextSlash";
/** 「/」键中段触发钩子的 marker(独立 marker,防同 marker 早退漏应用) */
const MID_TEXT_SLASH_OPEN_MARKER = "__hapiMidTextSlashOpen";
/** 后台任务插件 shell 修复的 marker */
const HAPI_SHELL_MARKER = "hapiShell";
/** 后台任务状态行耗时展示的 marker */
const HAPI_BG_ELAPSED_MARKER = "hapiBgElapsed";
/** 后台任务插件包名（hapilon 自身的依赖，不在 pi 包树里）。
 *  版本锁定 0.1.8 不升级（package.json 精确钉版）：面板与行为补丁锚定其源码，
 *  只有破坏性极强（安全洞、与 pi 新版不兼容）才考虑升级。 */
const BACKGROUND_TASKS_PACKAGE = "@nklisch/pi-background-tasks";
/** subagent 扩展包名（hapilon 自身的依赖，不在 pi 包树里） */
const SUBAGENTS_PACKAGE = "@tintinweb/pi-subagents";
/** pi-subagents 项目配置目录迁移（.pi → .hapilon）的 marker */
const HAPI_SUBAGENTS_DIR_MARKER = "hapiSubagentsDir";
/** 隐藏 pi 内置 /compact（补全与命令表，压缩权移交 billion-context）的 marker */
const HAPI_COMPACT_HIDE_MARKER = "hapiCompactHide";
/** bg-task 完成通知从聊天区永久行改为 footer 短暂展示的 marker */
const HAPI_BG_DONE_MARKER = "hapiBgDone";
const HAPI_BG_RUNNING_GLYPH_MARKER = "hapiBgRunningGlyph";
/** bg-task 面板圆角盒改版（列表/翻页换 FloatingPane 观感 + 翻页滚动）的 marker */
const HAPI_JOB_PANEL_BOX_MARKER = "hapiJobPanelBox";
/** bg-task 任务起止事件（bg-jobs:started/ended，hpl-herdr 等据此撑 working）的 marker */
const HAPI_BG_JOB_EVENTS_MARKER = "hapiBgJobEvents";
/** ponytail 图标去 emoji（🌿⚡🔥🐴 → 盲文点阵）的 marker */
const HAPI_PONYTAIL_GLYPH_MARKER = "hapiPonytailGlyph";
/** ponytail 模糊请求改按 workflow 确认制（出 plan 等批准，不自行选最小版）的 marker */
const HAPI_PONYTAIL_WORKFLOW_MARKER = "hapiPonytailWorkflow";
/** ponytail 注释规则向项目 code style 让位（项目规则优先）的 marker */
const HAPI_PONYTAIL_COMMENTS_MARKER = "hapiPonytailComments";
/** ponytail 包名（hapilon 自身的依赖） */
const PONYTAIL_PACKAGE = "@dietrichgebert/ponytail";
/** 压缩内核包名（hapilon 自身的依赖） */
const BILLION_CONTEXT_PACKAGE = "billion-context-pi";
/** billion-context 提醒措辞温和化的 marker */
const HAPI_NUDGE_WORDING_MARKER = "hapiNudgeWording";
/** billion-context 提醒冷却戳判断前清零的 marker */
const HAPI_NUDGE_COOLDOWN_RESET_MARKER = "hapiNudgeCooldownReset";
/** /compact 条目移除后数组空洞的源头过滤（补全项不含 undefined）的 marker */
const HAPI_COMPACT_FILTER_MARKER = "hapiCompactFilter";
/** SubagentWorkflow 派发模型列表钩子的 marker */
const HAPI_SUBAGENT_MODELS_MARKER = "__hplSubagentModelsPick";
/** 状态行追加不覆盖的 marker（showStatus 连续状态不再互相替换） */
const HAPI_STATUS_STACK_MARKER = "hapiStatusStack";
/** 思考折叠标签实时耗时（Thinking... 后跳秒）：两条规则的 marker 即钩子名本身 */
const HAPI_THINKING_NODE_MARKER = "__hapiThinkingNode";
const HAPI_THINKING_TICK_MARKER = "__hapiThinkingTick";
/** Bundle chunk directory; the host file is located by signature, not its hash name. */
const PI_BUNDLE_CHUNKS = "dist/bundle/chunks";

/** 补丁目标的包从哪棵依赖树解析：pi 包树（默认）或 hapilon 自身依赖 */
type PatchBase = "pi" | "hapilon";

/** SelectList 选中项描述两行展开的 marker */
const HAPI_DESC_WRAP_MARKER = "hapiDescWrap";

interface PatchRule {
  /** 相对包根 */
  file: string;
  find: string;
  replace: string;
  /** 期望出现次数;实际不符 = 锚点失配(视为 pi 升级) */
  occurrences: number;
  /** Bundle chunks use a stable content signature instead of a hashed filename. */
  signature?: string;
  /** 目标包;缺省 pi 主包 */
  package?: string;
  /** 本规则的已补丁标记;缺省 PATCH_MARKER */
  marker?: string;
  /** 包解析基准;缺省 pi */
  base?: PatchBase;
}

/**
 * 全部改动均为字符串级替换，逐条 anchors 与实际安装产物 byte-for-byte 校验过
 * （pi-tui editor.js 2 条 + select-list.js 2 条 + pi bundle chunk 7 条 + pi 主包 4 条
 * + background-tasks.ts 6 条 + pi-subagents host.js/settings.js 2 条 + ponytail 3 条
 * + billion-context-pi dist/index.js 2 条，共 28 条）。
 */
/** 补丁规则表(导出仅供测试构造 fixture;运行时只读) */
export const PATCH_RULES: readonly PatchRule[] = [
  // ── 中段 slash 补全触发门(hpl-editor-slash):provider 在编辑器触发门之后,
  //    门的行首判定会让中段打字永远不请求补全。给「字母键触发分支」加一个
  //    全局钩子,由扩展注入中段片段判定;钩子缺席时行为与原版一致。
  {
    package: PI_TUI_PACKAGE,
    file: "dist/components/editor.js",
    find: "if (this.isInSlashCommandContext(textBeforeCursor)) {",
    replace:
      "if (this.isInSlashCommandContext(textBeforeCursor) || globalThis.__hapiMidTextSlash?.(textBeforeCursor)) {",
    occurrences: 3,
    marker: MID_TEXT_SLASH_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "isInSlashCommandContext",
    find: "this.isInSlashCommandContext(textBeforeCursor)?this.tryTriggerAutocomplete()",
    replace:
      "this.isInSlashCommandContext(textBeforeCursor)||globalThis.__hapiMidTextSlash?.(textBeforeCursor)?this.tryTriggerAutocomplete()",
    occurrences: 3,
    marker: MID_TEXT_SLASH_MARKER,
  },
  // 同一需求的另一半:「/」键本身也要能在中段触发(行首门槛 isAtStartOfMessage 之外
  // 加钩子;钩子判定与补全建议同一片段正则)。独立 marker,避免被已应用的同名 marker 早退吞掉
  {
    package: PI_TUI_PACKAGE,
    file: "dist/components/editor.js",
    find: 'if (char === "/" && this.isAtStartOfMessage()) {',
    replace:
      'if (char === "/" && (this.isAtStartOfMessage() || globalThis.__hapiMidTextSlashOpen?.(before + char))) {',
    occurrences: 1,
    marker: MID_TEXT_SLASH_OPEN_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "isInSlashCommandContext",
    find: 'else if(char==="/"&&this.isAtStartOfMessage())this.tryTriggerAutocomplete()',
    replace:
      'else if(char==="/"&&(this.isAtStartOfMessage()||globalThis.__hapiMidTextSlashOpen?.(this.state.lines[this.state.cursorLine].slice(0,this.state.cursorCol)+char)))this.tryTriggerAutocomplete()',
    occurrences: 1,
    marker: MID_TEXT_SLASH_OPEN_MARKER,
  },
  // 后台任务插件（background/monitor）把 shell 写死成 "/bin/sh"：Windows 上无此路径，
  // spawn 直接 ENOENT——team 模式的派发链就跑在 background 里，于是整个机制失效。
  // 改用 pi 导出的 getShellConfig()：与 pi 的 bash 工具同一套平台解析（Windows 优先
  // Git Bash、尊重 settings.shellPath），POSIX 保持原样。上游若自行修复，删掉这三条。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: 'import { spawn, type ChildProcess } from "node:child_process";',
    replace: 'import { spawn, type ChildProcess } from "node:child_process";\n\n'
      + '// hapilon: Windows 没有 /bin/sh；Windows 下复用 pi 的平台 shell 解析（懒解析一次）\n'
      + 'import { getShellConfig } from "@earendil-works/pi-coding-agent";\n'
      + "type HapiShellConfig = ReturnType<typeof getShellConfig>;\n"
      + "let hapiShellCache: HapiShellConfig | undefined;\n"
      + "function hapiShell(): string {\n"
      + '    const config = process.platform !== "win32" ? { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" as const } : (hapiShellCache ??= getShellConfig());\n'
      + '    if (config.commandTransport === "stdin") throw new Error("hapiShell: stdin shell transport is unsupported by pi-background-tasks (background/monitor)");\n'
      + "    return config.shell;\n"
      + "}",
    occurrences: 1,
    marker: HAPI_SHELL_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '      shell: "/bin/sh",',
    replace: "      shell: hapiShell(),",
    occurrences: 1,
    marker: HAPI_SHELL_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: 'result = await pi.exec!("/bin/sh", ["-c", command], {',
    replace: 'result = await pi.exec!(hapiShell(), ["-c", command], {',
    occurrences: 1,
    marker: HAPI_SHELL_MARKER,
  },
  // ── 后台任务状态行展示每个任务的运行耗时：上游只在任务事件时刷新状态行，
  //    耗时会停在事件间的死数上。补两件事：labels 追加 fmtDuration(elapseMs(j))；
  //    活跃任务存在时起秒级 interval 刷新状态行，清零即停。上游若自带耗时展示，删掉这条。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '    if (active.length === 0) {\n      ui.setStatus(STATUS_KEY, undefined);\n      return;\n    }\n    const labels = active.map((j) => `#${j.id} ${j.label}`).slice(0, 3).join(", ");',
    replace: '    if (active.length === 0) {\n      // hapilon: hapiBgElapsed —— 无活跃任务时停掉秒级刷新\n      const g = globalThis as unknown as { __hapiBgTick?: ReturnType<typeof setInterval> };\n      if (g.__hapiBgTick) { clearInterval(g.__hapiBgTick); g.__hapiBgTick = undefined; }\n      ui.setStatus(STATUS_KEY, undefined);\n      return;\n    }\n    // hapilon: hapiBgElapsed —— 每秒刷一次状态行让耗时走表（updateStatus 幂等，重复调用安全）\n    {\n      const g = globalThis as unknown as { __hapiBgTick?: ReturnType<typeof setInterval> };\n      if (!g.__hapiBgTick) g.__hapiBgTick = setInterval(() => updateStatus(lastUi), 1000);\n    }\n    const labels = active.map((j) => `#${j.id} ${j.label} ${fmtDuration(elapseMs(j))}`).slice(0, 3).join(", ");',
    occurrences: 1,
    marker: HAPI_BG_ELAPSED_MARKER,
  },
  // ── SubagentWorkflow 派发模型列表：workflow 脚本的 agent() 在 host 内部直接解析
  //    模型，无 tool_call 可拦（hpl-subagent-models 只能覆写 Agent/TaskExecute）。
  //    给「脚本未点名模型」的派发插一个全局钩子，由扩展注册；钩子缺席（裸 pi）时
  //    行为与原版一致。frontmatter 让位列表，脚本显式点名仍最优先。
  {
    base: "hapilon",
    package: SUBAGENTS_PACKAGE,
    file: "dist/workflow/host.js",
    find: "            if (modelInput !== undefined) {",
    replace: "            // hapilon: hpl-subagent-models 列表（脚本未点名时；钩子缺席则旁路）\n            if (request.model === undefined) {\n                const picked = globalThis.__hplSubagentModelsPick?.(ctx.cwd);\n                if (picked) {\n                    const fromList = resolveModel(`${picked.provider}/${picked.id}`, ctx.modelRegistry);\n                    if (typeof fromList !== \"string\")\n                        model = fromList;\n                }\n            }\n            if (modelInput !== undefined) {",
    occurrences: 1,
    marker: HAPI_SUBAGENT_MODELS_MARKER,
  },
  // ── pi-subagents 项目配置迁移：上游硬编码 <cwd>/.pi/subagents.json；hapilon 的
  //    项目级配置一律归 .hapilon/（含 /agents → Settings 的写入落点）。上游若提供
  //    官方路径覆盖，删掉这条。
  {
    base: "hapilon",
    package: SUBAGENTS_PACKAGE,
    file: "dist/settings.js",
    find: 'return join(cwd, ".pi", "subagents.json");',
    replace: 'return join(cwd, ".hapilon", "subagents.json"); /*hapilon: hapiSubagentsDir*/',
    occurrences: 1,
    marker: HAPI_SUBAGENTS_DIR_MARKER,
  },
  // ── 隐藏 pi 内置 /compact：billion-context 接管压缩（session_before_compact
  //    cancel），/compact 成为死命令——从内置命令表移除，slash 补全随之消失。
  //    扩展同名命令会被 pi 的补全构建器过滤（内置优先），只能走补丁。
  //    移除 billion-context 接入时删掉这两条。
  {
    file: "dist/core/slash-commands.js",
    find: '    { name: "compact", description: "Manually compact the session context" },\n',
    replace: "    // hapilon: hapiCompactHide — /compact 由 billion-context 接管\n",
    occurrences: 1,
    marker: HAPI_COMPACT_HIDE_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "BUILTIN_SLASH_COMMANDS",
    find: '{name:"compact",description:"Manually compact the session context"},',
    replace: "/*hapiCompactHide*/,",
    occurrences: 1,
    marker: HAPI_COMPACT_HIDE_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "BUILTIN_SLASH_COMMANDS",
    find: "slashCommands=BUILTIN_SLASH_COMMANDS.map(command=>",
    replace: "slashCommands=BUILTIN_SLASH_COMMANDS.filter(Boolean).map(command=>/*hapiCompactFilter*/",
    occurrences: 1,
    marker: HAPI_COMPACT_FILTER_MARKER,
  },
  // ── bg-task 完成通知：从 notify()（聊天区永久行）改为 setStatus（footer 5s
  //    自动清除）——hapiStatusStack 补丁使 notify 永久堆积，完成消息不该占聊天区。
  //    唤醒消息（wake → pi.sendMessage triggerTurn）不受影响。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '      notify(ok ? "success" : "error", `background job #${job.id} "${label}" finished: ${reason}`, job);',
    replace: '      // hapilon: hapiBgDone — 完成通知走 footer 短暂展示，不占聊天区\n      // （hapiStatusStack 补丁使 notify 永久堆积，完成消息会刷屏）\n      lastUi?.setStatus?.("bg-done", `${ok ? "⠧" : "⠭"} #${job.id} ${label}: ${reason}`);\n      setTimeout(() => lastUi?.setStatus?.("bg-done", undefined), 5000);',
    occurrences: 1,
    marker: HAPI_BG_DONE_MARKER,
  },
  // ── 后台任务运行中状态行的 ⏳ 换随机盲文：与 ponytail 图标同一「emoji → 盲文」约定
  //    （emoji 宽度表现形曾致状态行超宽崩溃），并在 10 帧里随机抽一帧，每次状态刷新重抽。纯视觉，行为不变。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '    ui.setStatus(STATUS_KEY, `⏳ ${active.length} job${active.length === 1 ? "" : "s"}: ${labels}${more}`);',
    replace: '    // hapilon: hapiBgRunningGlyph — ⏳ 换随机盲文，每次状态刷新在 10 帧里抽一帧（emoji 去 emoji 约定，补丁表）\n    ui.setStatus(STATUS_KEY, `${["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Math.random() * 10)]} ${active.length} job${active.length === 1 ? "" : "s"}: ${labels}${more}`);',
    occurrences: 1,
    marker: HAPI_BG_RUNNING_GLYPH_MARKER,
  },
  // ── bg-task 任务起止事件（hapiBgJobEvents，2 条一组）：插件原无任何事件出口，
  //    主循环 settle 后后台任务还在跑时，herdr 这类状态消费者无从得知（误报 idle）。
  //    两个任务创建点（background/monitor 文本相同，occurrences:2 一条覆盖）发
  //    bg-jobs:started，finalize（注释自证全部终态路径的唯一汇合点）发
  //    bg-jobs:ended，hpl-herdr 订阅后作为第三路事实源撑住 working。
  //    同 marker 文件级判定、首跑全打。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: "    jobs.set(job.id, job);\n    snapshot(job);\n    refreshVisuals(job);",
    replace: "    jobs.set(job.id, job);\n    snapshot(job);\n    refreshVisuals(job);\n    // hapilon: hapiBgJobEvents — 任务创建即广播，状态消费者据此撑住 working\n    pi.events.emit(\"bg-jobs:started\", { id: job.id });",
    occurrences: 2,
    marker: HAPI_BG_JOB_EVENTS_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: "    if (!shuttingDown) snapshot(job);\n    pruneTerminal();\n    if (!shuttingDown) refreshVisuals(job);\n  }",
    replace: "    if (!shuttingDown) snapshot(job);\n    pruneTerminal();\n    if (!shuttingDown) refreshVisuals(job);\n    pi.events.emit(\"bg-jobs:ended\", { id: job.id });\n  }",
    occurrences: 1,
    marker: HAPI_BG_JOB_EVENTS_MARKER,
  },
  // ── bg-task 面板圆角盒改版（hapiJobPanelBox，5 条一组）：JobPanel 原为平线横幅
  //    （上下横线、无侧边框、快捷键提示挤标题行），且翻页模式不能滚动。整组把
  //    列表/翻页换成圆角闭合盒（╭─╮│╰╯，标题嵌上边框、提示入盒内 footer 行，
  //    对齐 hpl-panel-viewer 的 FloatingPane 观感），翻页加 ↑↓ 滚动窗口（5000 行
  //    上限、按 jobId+bufferLen 缓存保持尾随）。同 marker 文件级判定、首跑全打。
  //    上游若自行改版，删掉整组并重核锚点。
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '  return out.replace(/\\x1b\\[[0-9;]*$/, "");\n}',
    replace: '  return out.replace(/\\x1b\\[[0-9;]*$/, "");\n}\n\n// hapilon: hapiJobPanelBox — 盒渲染用的 ANSI 感知宽度/补齐（与 clipToWidth 同一\n// UTF-16 近似，宽字形最多溢出一列，沿用上游注释的取舍）\nfunction hapiVisibleWidth(text: string): number {\n  return text.replace(/\\x1b\\[[0-9;]*m/g, "").length;\n}\nfunction hapiPadTo(text: string, width: number): string {\n  const clipped = clipToWidth(text, width);\n  return clipped + " ".repeat(Math.max(0, width - hapiVisibleWidth(clipped)));\n}\nconst HAPI_PAGING_MAX_LINES = 5000;',
    occurrences: 1,
    marker: HAPI_JOB_PANEL_BOX_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '  private paging: { jobId: number } | null = null;\n  private getJobs: () => Job[];',
    replace: '  private paging: { jobId: number } | null = null;\n  // hapilon: hapiJobPanelBox — 翻页滚动偏移（从尾部上移的行数）与按 jobId+bufferLen\n  // 失效的行缓存（输出增长即重切，尾随保持实时）\n  private pagingScroll = 0;\n  private pagingCache: { jobId: number; bufferLen: number; lines: string[] } | null = null;\n  private getJobs: () => Job[];',
    occurrences: 1,
    marker: HAPI_JOB_PANEL_BOX_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '    if (this.paging) {\n      // In paging mode: left/Esc/enter/"q"/back-to-list all return to the list.\n      if (this.is(data, "cancel") || this.is(data, "confirm") || this.is(data, "left") || data === "q") this.paging = null;\n      return;\n    }',
    replace: '    if (this.paging) {\n      // hapilon: hapiJobPanelBox — 翻页窗口可滚动：↑ 向历史方向移窗，↓ 回到尾部；\n      // 越界钳制在渲染端做（end = max(visible, len - offset)）。\n      if (this.is(data, "up")) { this.pagingScroll++; return; }\n      if (this.is(data, "down") && this.pagingScroll > 0) { this.pagingScroll--; return; }\n      // In paging mode: left/Esc/enter/"q"/back-to-list all return to the list.\n      if (this.is(data, "cancel") || this.is(data, "confirm") || this.is(data, "left") || data === "q") { this.paging = null; this.pagingScroll = 0; }\n      return;\n    }',
    occurrences: 1,
    marker: HAPI_JOB_PANEL_BOX_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '  render(width: number): string[] {\n    if (this.paging) return this.renderPaging(width);\n    const jobs = this.getJobs();\n    const lines: string[] = [];\n    const w = Math.max(1, width);\n    // Clamp selection if the list shrank (jobs pruned/added between renders).\n    const sel = jobs.length === 0 ? 0 : Math.min(this.selected, jobs.length - 1);\n    this.selected = sel;\n    const rule = "─".repeat(w);\n    lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n    const header = this.fg("accent", ` Background jobs (${jobs.length}) `) + this.fg("dim", "  — ↑/↓ move · enter page output · q/Esc close");\n    lines.push(clipToWidth(header, w));\n    lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n    if (jobs.length === 0) {\n      lines.push("");\n      lines.push(clipToWidth(this.fg("dim", "  No background jobs or monitors."), w));\n    }\n    jobs.forEach((job, i) => {\n      const marker = i === sel ? this.fg("accent", "▸ ") : "  ";\n      lines.push(clipToWidth(`${marker}${formatJobLine(job)}`, w));\n    });\n    lines.push("");\n    lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n    return lines;\n  }',
    replace: '  render(width: number): string[] {\n    if (this.paging) return this.renderPaging(width);\n    const jobs = this.getJobs();\n    // hapilon: hapiJobPanelBox — 平线横幅换圆角闭合盒：左右 │ 边框、标题嵌上边框、\n    // 提示移入盒内 footer 行（对齐 hpl-panel-viewer 的 FloatingPane 观感）。\n    const inner = Math.max(1, Math.max(1, width) - 2);\n    const box = (s: string) => this.fg("border", "│") + s + this.fg("border", "│");\n    // Clamp selection if the list shrank (jobs pruned/added between renders).\n    const sel = jobs.length === 0 ? 0 : Math.min(this.selected, jobs.length - 1);\n    this.selected = sel;\n    const title = this.fg("accent", ` Background jobs (${jobs.length}) `);\n    const out: string[] = [];\n    out.push(this.fg("border", "╭") + title + this.fg("border", "─".repeat(Math.max(0, inner - hapiVisibleWidth(title))) + "╮"));\n    if (jobs.length === 0) {\n      out.push(box(hapiPadTo(this.fg("dim", " No background jobs or monitors."), inner)));\n    }\n    jobs.forEach((job, i) => {\n      const marker = i === sel ? this.fg("accent", "▸ ") : "  ";\n      out.push(box(hapiPadTo(`${marker}${formatJobLine(job)}`, inner)));\n    });\n    out.push(box(hapiPadTo(this.fg("dim", " ↑/↓ move · enter page output · q/Esc close"), inner)));\n    out.push(this.fg("border", "╰" + "─".repeat(inner) + "╯"));\n    return out;\n  }',
    occurrences: 1,
    marker: HAPI_JOB_PANEL_BOX_MARKER,
  },
  {
    base: "hapilon",
    package: BACKGROUND_TASKS_PACKAGE,
    file: "extensions/background-tasks.ts",
    find: '  private renderPaging(width: number): string[] {\n    const job = this.paging ? this.getJobs().find((j) => j.id === this.paging!.jobId) : undefined;\n    const lines: string[] = [];\n    const w = Math.max(1, width);\n    const rule = "─".repeat(w);\n    lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n    if (!job) {\n      lines.push(clipToWidth(this.fg("warning", "  Job no longer in the registry."), w));\n    } else {\n      lines.push(clipToWidth(this.fg("accent", ` Job #${job.id} "${job.label}" — output `), w));\n      lines.push(clipToWidth(this.fg("dim", ` ${formatJobLine(job)}`), w));\n      lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n      // Bound the paged output to a sane number of lines (the buffer is already\n      // size-capped; tailLines never gets a 0 argument which would return it all).\n      const body = tailLines(job.buffer, PAGING_TAIL_LINES) || "(no output captured)";\n      for (const ln of body.split("\\n")) lines.push(clipToWidth(ln, w));\n    }\n    lines.push(clipToWidth(this.fg("borderMuted", rule), w));\n    lines.push(clipToWidth(this.fg("dim", " ←/q/Esc/enter — back to list"), w));\n    return lines;\n  }',
    replace: '  private pagingLines(job: Job): string[] {\n    if (!this.pagingCache || this.pagingCache.jobId !== job.id || this.pagingCache.bufferLen !== job.buffer.length) {\n      // hapilon: hapiJobPanelBox — 窗口上限放宽到 5000 行（缓冲本身 200K 字符封顶），\n      // 滚动才能离开尾部；按 jobId+bufferLen 缓存，输出增长时重切保持尾随。\n      const body = tailLines(job.buffer, HAPI_PAGING_MAX_LINES) || "(no output captured)";\n      this.pagingCache = { jobId: job.id, bufferLen: job.buffer.length, lines: body.split("\\n") };\n    }\n    return this.pagingCache.lines;\n  }\n\n  private renderPaging(width: number): string[] {\n    const inner = Math.max(1, Math.max(1, width) - 2);\n    const box = (s: string) => this.fg("border", "│") + s + this.fg("border", "│");\n    const job = this.paging ? this.getJobs().find((j) => j.id === this.paging!.jobId) : undefined;\n    const out: string[] = [];\n    if (!job) {\n      out.push(this.fg("border", "╭" + "─".repeat(inner) + "╮"));\n      out.push(box(hapiPadTo(this.fg("warning", "  Job no longer in the registry."), inner)));\n      out.push(this.fg("border", "╰" + "─".repeat(inner) + "╯"));\n      return out;\n    }\n    const all = this.pagingLines(job);\n    const len = all.length;\n    const visible = Math.min(PAGING_TAIL_LINES, len);\n    const end = Math.max(visible, len - this.pagingScroll);\n    const start = end - visible;\n    const head = this.fg("accent", ` Job #${job.id} "${job.label}" `) + this.fg("dim", `output ${start + 1}-${end}/${len}`);\n    out.push(this.fg("border", "╭") + head + this.fg("border", "─".repeat(Math.max(0, inner - hapiVisibleWidth(head))) + "╮"));\n    out.push(box(hapiPadTo(this.fg("dim", ` ${formatJobLine(job)}`), inner)));\n    for (let i = start; i < end; i++) out.push(box(hapiPadTo(all[i] ?? "", inner)));\n    out.push(box(hapiPadTo(this.fg("dim", " ↑/↓ scroll · q/Esc back to list"), inner)));\n    out.push(this.fg("border", "╰" + "─".repeat(inner) + "╯"));\n    return out;\n  }',
    occurrences: 1,
    marker: HAPI_JOB_PANEL_BOX_MARKER,
  },
  // ── ponytail 图标去 emoji：档位图标与状态栏的马（🌿⚡🔥🐴）换成盲文点阵——
  //    档位密度递进 ⠿/⣿/⡷，马换 ⠓（盲文 h，与 startup 猫头同源）。纯视觉，行为不变。
  {
    base: "hapilon",
    package: PONYTAIL_PACKAGE,
    file: "pi-extension/index.js",
    find: '    const levelIcons = { lite: "🌿", full: "⚡", ultra: "🔥" };\n    const icon = levelIcons[currentMode] || "";\n    const label = currentMode.toUpperCase();\n    const indicator = isActive ? theme.fg("accent", "●") : theme.fg("dim", "○");\n    c.ui.setStatus("ponytail", indicator + " 🐴 " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label));',
    replace: '    const levelIcons = { lite: "⠿", full: "⣿", ultra: "⡷" };\n    const icon = levelIcons[currentMode] || "";\n    const label = currentMode.toUpperCase();\n    const indicator = isActive ? theme.fg("accent", "●") : theme.fg("dim", "○");\n    // hapilon: hapiPonytailGlyph — 图标去 emoji（补丁表），⠓ 与 startup 猫头同源\n    c.ui.setStatus("ponytail", indicator + " ⠓ " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label));',
    occurrences: 1,
    marker: HAPI_PONYTAIL_GLYPH_MARKER,
  },
  // ── ponytail 模糊请求裁决：上游「vague request → 自选最小版」与 hapilon workflow
  //    确认制冲突（同一场景两套指令）。改按 workflow 说法：出 plan 等批准。
  {
    base: "hapilon",
    package: PONYTAIL_PACKAGE,
    file: "skills/ponytail/SKILL.md",
    find: 'A vague request ("build me X") gets the smallest version that does the core job.',
    replace: 'A vague request ("build me X") is real ambiguity: reply with a two-to-three-line plan (what to do, where, what you will not touch) and wait for approval before changing anything. <!-- hapilon: hapiPonytailWorkflow -->',
    occurrences: 1,
    marker: HAPI_PONYTAIL_WORKFLOW_MARKER,
  },
  // ── ponytail 注释规则收敛：与 hapilon code_style 重复定义（改一处忘一处会漂移），
  //    改为项目规则优先的让位声明，code_style 保持单一来源。
  {
    base: "hapilon",
    package: PONYTAIL_PACKAGE,
    file: "skills/ponytail/SKILL.md",
    find: "- Comment only the why the code cannot show, in one line.",
    replace: "- Comment only the why the code cannot show, in one line — where the project's comment rules say more, they win. <!-- hapilon: hapiPonytailComments -->",
    occurrences: 1,
    marker: HAPI_PONYTAIL_COMMENTS_MARKER,
  },
  // ── 状态行追加不覆盖：pi 的 showStatus 对连续状态就地替换（防刷屏），扩展经
  //    ctx.ui.notify 发的多条提示会互相顶掉。去掉替换分支后每条通知各占一行；
  //    pi 自身的状态提示（Switched to… 等）同样改为追加。
  {
    file: "dist/modes/interactive/interactive-mode.js",
    find: "        if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {\n            this.lastStatusMessage = message;\n            this.lastStatusText.invalidate();\n            this.ui.requestRender();\n            return;\n        }\n",
    replace: "        // hapilon: 状态行追加不覆盖（hapiStatusStack）\n",
    occurrences: 1,
    marker: HAPI_STATUS_STACK_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "lastStatusSpacer",
    find: 'if(last&&secondLast&&last===this.lastStatusText&&secondLast===this.lastStatusSpacer){this.lastStatusMessage=message,this.lastStatusText.invalidate(),this.ui.requestRender();return}',
    replace: "/*hapilon:状态行追加不覆盖(hapiStatusStack)*/",
    occurrences: 1,
    marker: HAPI_STATUS_STACK_MARKER,
  },
  // ── slash 补全描述只展示单行（pi-tui SelectList.renderItem 把描述压平后按
  //    剩余宽度截断），长描述看不全。选中项的描述改为独占下方最多 2 行（全宽
  //    换行），非选中项维持原样不占行。
  {
    package: PI_TUI_PACKAGE,
    file: "dist/components/select-list.js",
    find: "            lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));",
    replace: "            // hapilon: hapiDescWrap — renderItem 可能返回多行（选中项描述展开）\n"
      + '            const hapiRendered = this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth);\n'
      + "            lines.push(...(Array.isArray(hapiRendered) ? hapiRendered : [hapiRendered]));",
    occurrences: 1,
    marker: HAPI_DESC_WRAP_MARKER,
  },
  {
    package: PI_TUI_PACKAGE,
    file: "dist/components/select-list.js",
    find: "        if (descriptionSingleLine && width > 40) {\n            const effectivePrimaryColumnWidth",
    replace: "        // hapilon: hapiDescWrap — 选中项描述独占下方最多 2 行，非选中项保持单行\n"
      + "        if (isSelected && descriptionSingleLine && width > 40) {\n"
      + "            const hapiHeaderWidth = Math.max(10, width - prefixWidth - 2);\n"
      + "            const hapiHeader = this.theme.selectedText(`${prefix}${this.truncatePrimary(item, isSelected, hapiHeaderWidth, hapiHeaderWidth)}`);\n"
      + "            const hapiMax = Math.max(10, width - 4);\n"
      + "            const hapiLines = [];\n"
      + '            let hapiCur = "";\n'
      + "            for (const ch of descriptionSingleLine) {\n"
      + '                if (visibleWidth(hapiCur + ch) > hapiMax) {\n'
      + "                    hapiLines.push(hapiCur);\n"
      + "                    hapiCur = ch;\n"
      + "                }\n"
      + "                else\n"
      + "                    hapiCur += ch;\n"
      + "            }\n"
      + "            if (hapiCur)\n"
      + "                hapiLines.push(hapiCur);\n"
      + '            return [hapiHeader, ...hapiLines.slice(0, 2).map((l) => this.theme.description("    " + truncateToWidth(l, hapiMax, "")))];\n'
      + "        }\n"
      + "        if (descriptionSingleLine && width > 40) {\n"
      + "            const effectivePrimaryColumnWidth",
    occurrences: 1,
    marker: HAPI_DESC_WRAP_MARKER,
  },
  // ── billion-context 提醒（0.1.83）两处：① 压缩提醒缺「先压缩已耗尽区间、保持
  //    活跃工作集」的前置建议，措辞从单次调用参数直接开头——温和化改写，原句后半
  //    参数说明原样保留。② 上游提醒展示即写冷却戳（lastNudgeShownTokens /
  //    lastShownByTier），被忽略也长期拦住后续提醒——decideNudge 判断前构造无展
  //    示戳的局部 state 传入（billion-context 所有 node 都以返回新 state 的不可变
  //    风格工作，不直接改 io.state），同一 turn 仍由 runtime turnKey 去重，跨新
  //    user turn 符合条件会再提醒；nudgeNode 随后照常 stamp 新戳并随返回值落
  //    state。上游若按成功结果计冷却，删掉这两条。
  {
    base: "hapilon",
    package: BILLION_CONTEXT_PACKAGE,
    file: "dist/index.js",
    find: '      "",\n      `\\u{1F4A1} If you compress, fold the ranges you keep in ONE call \\u2014 pass multiple content entries',
    replace: '      "",\n'
      + "      // hapilon: hapiNudgeWording — 先建议压缩已耗尽区间，保持活跃工作集不动，再接原句的单次调用参数说明\n"
      + '      `\\u{1F4A1} If some listed ranges are fully consumed, consider compressing those ranges before continuing. Leave the active working set untouched. If you compress, fold all chosen ranges in ONE call \\u2014 pass multiple content entries',
    occurrences: 1,
    marker: HAPI_NUDGE_WORDING_MARKER,
  },
  {
    base: "hapilon",
    package: BILLION_CONTEXT_PACKAGE,
    file: "dist/index.js",
    find: 'var nudgeNode = {\n  name: "nudge-inject",\n  run(io, ctx) {\n    const nudge = decideNudge({\n      tokenCount: ctx.tokenCount,\n      config: ctx.config,\n      state: io.state,',
    replace: 'var nudgeNode = {\n  name: "nudge-inject",\n  run(io, ctx) {\n'
      + "    // hapilon: hapiNudgeCooldownReset — 提醒展示即写冷却戳，被忽略也拦住后续提醒；判断使用无展示戳的局部 state（不可变风格，不改 io.state）\n"
      + "    const hapiNudgeState = { ...io.state, nudge: { ...io.state.nudge, lastNudgeShownTokens: 0, lastShownByTier: {} } };\n"
      + '    const nudge = decideNudge({\n      tokenCount: ctx.tokenCount,\n      config: ctx.config,\n      state: hapiNudgeState,',
    occurrences: 1,
    marker: HAPI_NUDGE_COOLDOWN_RESET_MARKER,
  },
  // ── 思考折叠标签计时：「Thinking...」后追加实时跳动的耗时（如 Thinking... 12s）。
  //    pi 的折叠标签是 updateContent 时一次成型的静态 Text（缓存按文本判等），思考
  //    chunk 的间隙里永远停在旧文本。三件事：① 标签节点改由 globalThis.__hapiThinkingNode
  //    钩子构造（hpl-thinking-timer 扩展注册，持主题样式与按 run 序号的计时状态）；
  //    ② render 每帧回调 __hapiThinkingTick 让秒数走表——流式期间工作 spinner 已在
  //    80ms 节拍驱动 requestRender，无需自起定时器；③ 钩子缺席（裸 pi / print 模式）
  //    回落原标签。历史消息与展开态不计时。上游若自带思考计时，删掉这四条。
  //    marker 即钩子名（replace 文本自带），与 midTextSlash 同款做法。
  {
    file: "dist/modes/interactive/components/assistant-message.js",
    find: '                    ? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)',
    replace:
      '                    ? (globalThis.__hapiThinkingNode?.(this, runIndex) ?? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0))',
    occurrences: 1,
    marker: HAPI_THINKING_NODE_MARKER,
  },
  {
    file: "dist/modes/interactive/components/assistant-message.js",
    find: "    render(width) {\n        const lines = super.render(width);\n        if (this.hasToolCalls || lines.length === 0) {",
    replace:
      "    render(width) {\n        globalThis.__hapiThinkingTick?.(this);\n        const lines = super.render(width);\n        if (this.hasToolCalls || lines.length === 0) {",
    occurrences: 1,
    marker: HAPI_THINKING_TICK_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "hiddenThinkingLabel",
    find: 'hidden?new Text(theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel)),this.outputPad,0)',
    replace:
      'hidden?(globalThis.__hapiThinkingNode?.(this,runIndex)??new Text(theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel)),this.outputPad,0))',
    occurrences: 1,
    marker: HAPI_THINKING_NODE_MARKER,
  },
  {
    file: PI_BUNDLE_CHUNKS,
    signature: "hiddenThinkingLabel",
    find: "render(width){let lines=super.render(width);return this.hasToolCalls",
    replace:
      "render(width){globalThis.__hapiThinkingTick?.(this);let lines=super.render(width);return this.hasToolCalls",
    occurrences: 1,
    marker: HAPI_THINKING_TICK_MARKER,
  },
];

interface PatchTarget {
  key: string;
  path: string;
  label: string;
  pkg: string;
  file: string;
  rules: PatchRule[];
}

interface ResolvedTargets {
  targets: PatchTarget[];
  problems: string[];
}

/**
 * 目标文件的唯一键与磁盘路径:pi 主包用 findPiDir,其余包按同 scope 同层解析
 * (node_modules/@earendil-works/pi-tui 与 pi-coding-agent 并排;全局/提升安装同构)。
 * base="hapilon" 的包从 hapilon 自身依赖树解析（不在 pi 包树里）。
 */
function resolveTargets(piDir: string, hapilonRoot: string): ResolvedTargets {
  const seen = new Map<string, PatchTarget>();
  const chunkMatches = new Map<string, string | null>();
  const problems: string[] = [];
  for (const rule of PATCH_RULES) {
    const pkg = rule.package ?? PI_PACKAGE;
    const base: PatchBase = rule.base ?? "pi";
    const pkgDir = base === "hapilon"
      ? (findAncestorPackageDir(pkg, hapilonRoot) ?? join(hapilonRoot, "node_modules", pkg))
      : resolvePackageDir(piDir, pkg);
    let file = rule.file;
    if (rule.signature) {
      const chunkKey = `${pkgDir}::${rule.file}::${rule.signature}`;
      if (!chunkMatches.has(chunkKey)) {
        const chunksDir = join(pkgDir, rule.file);
        try {
          const candidates = readdirSync(chunksDir)
            .filter((name) => name.endsWith(".js"))
            .filter((name) => readFileSync(join(chunksDir, name), "utf8").includes(rule.signature!));
          if (candidates.length !== 1) {
            problems.push(`${pkg}/${rule.file}: 签名「${rule.signature}」命中 ${candidates.length} 个文件（期望唯一）`);
            chunkMatches.set(chunkKey, null);
          } else {
            chunkMatches.set(chunkKey, join(rule.file, candidates[0]));
          }
        } catch (error) {
          problems.push(`${pkg}/${rule.file}: 查找签名「${rule.signature}」失败（${errorMessage(error)}）`);
          chunkMatches.set(chunkKey, null);
        }
      }
      const resolved = chunkMatches.get(chunkKey);
      if (resolved === null || resolved === undefined) continue;
      file = resolved;
    }
    const key = `${base}::${pkg}::${file}`;
    const target = seen.get(key);
    if (target) {
      target.rules.push(rule);
    } else {
      seen.set(key, {
        key,
        path: join(pkgDir, file),
        label: `${pkg}/${file}`,
        pkg,
        file,
        rules: [rule],
      });
    }
  }
  return { targets: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)), problems };
}

/**
 * 非 pi 主包的解析:遵循 npm 嵌套规则 —— pi 包内嵌套副本优先(pi 依赖冲突时
 * npm 会把 pi-tui 装进 pi-coding-agent/node_modules,运行时用的正是那份),
 * 否则回退同 scope 提升层。
 */
function resolvePackageDir(piDir: string, pkg: string): string {
  if (pkg === PI_PACKAGE) return piDir;
  const nested = join(piDir, "node_modules", pkg);
  if (existsSync(join(nested, "package.json"))) return nested;
  return join(dirname(dirname(piDir)), pkg);
}

export type PiPatchResult =
  /** 本包没带 pi（或 node_modules 还没装）——不关 hapilon 的事，静默跳过 */
  | { kind: "pi-not-found" }
  /** 全部目标文件都已带补丁标记 */
  | { kind: "already-patched"; piDir: string }
  /** 本次完成了替换并落盘 */
  | { kind: "patched"; piDir: string; files: string[] }
  /** pi 升级/缺文件导致锚点失配：不改文件，由调用方警告 */
  | { kind: "stale"; piDir: string; problems: string[] }
  /** 文件不可写（只读安装、root 属主等）：不改文件，由调用方警告 */
  | { kind: "unwritable"; piDir: string; problems: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从 startDir 向上找某个包（兼容 npm 提升与全局安装） */
function findAncestorPackageDir(pkg: string, startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findPiDir(): string | undefined {
  return findAncestorPackageDir(PI_PACKAGE, dirname(fileURLToPath(import.meta.url)));
}

function anchorLabel(find: string): string {
  return find.trim().split("\n")[0].slice(0, 60);
}

export interface EnsurePatchOptions {
  /** 测试注入：pi 包目录（缺省从本模块位置向上探测） */
  piDir?: string;
  /** 测试注入：hapilon 依赖树锚点（缺省本模块所在目录，向上按 node_modules 查找） */
  hapilonRoot?: string;
}

/**
 * 检查并（必要时）应用补丁。同步、零依赖、已补丁时只读判标记。
 */
export function ensurePiPatch(options: EnsurePatchOptions = {}): PiPatchResult {
  const piDir = options.piDir ?? findPiDir();
  if (piDir === undefined) return { kind: "pi-not-found" };

  const hapilonRoot = options.hapilonRoot ?? dirname(fileURLToPath(import.meta.url));
  const resolved = resolveTargets(piDir, hapilonRoot);
  if (resolved.problems.length > 0) return { kind: "stale", piDir, problems: resolved.problems };
  const targets = resolved.targets;
  const contents = new Map<string, string>();
  const readProblems: string[] = [];
  for (const target of targets) {
    if (!existsSync(target.path)) {
      readProblems.push(`文件不存在：${target.label}`);
      continue;
    }
    try {
      contents.set(target.key, readFileSync(target.path, "utf8"));
    } catch (error) {
      readProblems.push(`读取失败：${target.label}（${errorMessage(error)}）`);
    }
  }
  if (readProblems.length > 0) return { kind: "stale", piDir, problems: readProblems };

  const alreadyPatched = targets.every((target) =>
    target.rules.every((rule) => contents.get(target.key)!.includes(rule.marker ?? PATCH_MARKER)));
  if (alreadyPatched) {
    return { kind: "already-patched", piDir };
  }

  const next = new Map<string, string>();
  const problems: string[] = [];
  for (const target of targets) {
    let text = contents.get(target.key)!;
    let fileOk = true;
    // marker 判定用进入本文件规则循环前的原文：多条规则共享 marker 时，
    // 前一条规则应用后滚动 text 就含 marker，会把后面的规则错误跳过（首跑只打 1/N）。
    const initialText = text;
    for (const rule of target.rules) {
      // marker 命中 → 该规则已应用（旧版也算），跳过。必须在 replace 全文比对之前判：
      // 插入式规则（replace 含锚点）的锚点在旧补丁块里依然存活，规则 replace 文本
      // 改版后全文比对失效，重入会新旧两份声明并存（background-tasks 曾被打出两份
      // hapiShellCache，ESM 直接 SyntaxError 拒载，整个 hapi 启动失败）。规则改版要
      // 生效：换 marker 值，或重装包恢复原始文件。
      if (rule.marker && initialText.includes(rule.marker)) continue;
      // 替换产物已在 → 规则已应用,幂等跳过。必须在锚点计数之前判:
      // 插入式规则(替换文本包含锚点)在已补丁文件上锚点依然存活,
      // 重入会重复插入(曾把 theme.js 打出重复函数声明,ESM 直接 SyntaxError)
      if (text.includes(rule.replace)) continue;
      const found = text.split(rule.find).length - 1;
      if (found !== rule.occurrences) {
        problems.push(`${target.label}: 锚点出现 ${found} 次（期望 ${rule.occurrences}）「${anchorLabel(rule.find)}」`);
        fileOk = false;
        continue;
      }
      text = text.replaceAll(rule.find, rule.replace);
    }
    if (fileOk) next.set(target.key, text);
  }
  // 任一锚点失配 → 整个补丁都不落盘：半补丁（一部分文件带 token 一部分不带）比不补更难查
  if (problems.length > 0) return { kind: "stale", piDir, problems };

  // 落盘前先把可写性问完：否则写到一半被 EACCES 打断会留下半补丁
  const unwritable: string[] = [];
  for (const target of targets) {
    try {
      accessSync(target.path, constants.W_OK);
    } catch (error) {
      unwritable.push(`${target.label}: ${errorMessage(error)}`);
    }
  }
  if (unwritable.length > 0) return { kind: "unwritable", piDir, problems: unwritable };

  const files: string[] = [];
  for (const target of targets) {
    const text = next.get(target.key);
    if (text === undefined) continue;
    try {
      writeFileSync(target.path, text, "utf8");
      files.push(target.label);
    } catch (error) {
      return { kind: "unwritable", piDir, problems: [`${target.label}: ${errorMessage(error)}`] };
    }
  }
  return { kind: "patched", piDir, files };
}

/**
 * 仅在有问题时打警告（成功静默）——启动链与 postinstall 共用。
 * 警告不改退出码：锚点失配只跳过该条规则，其余补丁与应用不受影响。
 */
export function warnIfPiPatchStale(result: PiPatchResult): void {
  if (result.kind === "stale") {
    console.warn("⚠ pi 或插件已变更，hapilon 补丁（中段 slash/状态行追加/后台任务 shell 等）未应用"
      + "；请更新 src/patch/ensure-pi-patch.ts 的锚点");
    for (const problem of result.problems.slice(0, 3)) console.warn(`   · ${problem}`);
  } else if (result.kind === "unwritable") {
    console.warn("⚠ pi 或插件目录不可写，hapilon 补丁未应用（代码块无底色；中段 slash 无补全；Windows 后台任务不可用）");
    for (const problem of result.problems) console.warn(`   · ${problem}`);
  }
}
