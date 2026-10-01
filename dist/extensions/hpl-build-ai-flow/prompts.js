/**
 * prompts.ts — 派发 prompt 拼装（骨架在此，内容逐项从 stages.ts 读，不存副本）
 */
import { STAGES, stageByIndex, CONTEXT } from "./stages.js";
import { listArtifacts, openDebts } from "./machine.js";
export function buildStagePrompt(opts) {
    const { state, cwd } = opts;
    const def = stageByIndex(state.stage);
    const existing = new Set(listArtifacts(cwd, state.slug).filter((a) => a.exists).map((a) => a.name));
    const ctx = CONTEXT[def.slug] ?? { authoritative: [] };
    const tiers = [
        ["必读（本阶段依据）", ctx.authoritative],
        ["需要时参考", ctx.relevant ?? []],
        ["历史溯源时再读", ctx.historical ?? []],
    ];
    const lines = [];
    lines.push(`【build-ai-flow：${state.name}（${state.slug}）】阶段 ${state.stage}/9 ${def.slug}｜${def.zh}`);
    lines.push(state.goal ? `任务目标：${state.goal}` : "任务目标：（未填写——先和用户确认一句话目标，写进本阶段产物）");
    lines.push("");
    lines.push(`自主权：${def.autonomy}`);
    lines.push("");
    // 上游前提检查（仅 S4–S9）：AI 有回退建议权，没有回退执行权
    if (state.stage >= 4) {
        lines.push("上游前提检查：若发现无法可靠继续的原因来自已确认的上游结论（Frame / Definition / Decision / Design 等）——不自行修改上游，不为了完成本阶段硬做；指出哪个前提可能失效、给出新证据、说明对当前工作的影响、建议回退到哪个阶段，然后停下等用户决定 goto。你有回退建议权，没有回退执行权。");
        lines.push("");
    }
    for (const [label, files] of tiers) {
        const present = files.filter((f) => existing.has(f));
        if (present.length > 0)
            lines.push(`${label}：${present.join("、")}（.hapilon/ai-flow/${state.slug}/）`);
    }
    if (tiers.some(([, files]) => files.filter((f) => existing.has(f)).length > 0))
        lines.push("");
    // stale 提示：旧版本产物仅供历史参考，重新验证/重写后保存才算数
    if (state.stale && state.stage >= state.stale.from) {
        lines.push(`注意（stale）：上游已回退（自 S${state.stale.from} 起），本阶段及之后已有产物是旧版本，仅供历史参考——需基于当前上游重新验证或重写后保存（确认仍有效也重新落盘，如补一行确认记录）。`);
        lines.push("decision-log 不整体重写：按需追加条目（supersedes / 事件行）即可。");
        lines.push("");
    }
    const debts = openDebts(state);
    if (debts.length > 0) {
        lines.push("未解决的 Gate 缺口（debt，跨阶段持续存在，直到显式关闭）：");
        for (const d of debts) {
            lines.push(`- ${d.id}（S${d.stage} ${STAGES[d.stage]?.slug ?? ""}）：${d.gaps.join("；")}`);
        }
        lines.push("关闭方式：补齐后执行 /build-ai-flow debt resolve <id> <说明>。");
        lines.push("");
    }
    if (opts.priorGaps && opts.priorGaps.length > 0) {
        lines.push(`上一阶段 Gate 缺口（用户强推时留下，本阶段优先补上）：`);
        for (const gap of opts.priorGaps)
            lines.push(`- ${gap}`);
        lines.push("");
    }
    lines.push(`核心问题：${def.coreQuestion}`);
    lines.push("");
    lines.push("本阶段清单：");
    for (const item of def.checklist)
        lines.push(`- ${item}`);
    lines.push("");
    if (def.skills.length > 0) {
        lines.push(`可用技能（按需加载）：${def.skills.join("、")}。`);
        lines.push("");
    }
    lines.push(`本阶段产物：${def.artifacts.join("、")}（写入 .hapilon/ai-flow/${state.slug}/ 下）。${def.artifactNote}`);
    lines.push("");
    lines.push(`停止条件：${def.stopCondition}`);
    lines.push("完成后由用户执行 /build-ai-flow next 做 Gate 检查，不要自行进入下一阶段。");
    return lines.join("\n");
}
/** freeze 收尾说明（不再派发阶段 prompt，只给重放/收口指引） */
export function buildFreezeNote(state) {
    return [
        `【build-ai-flow：${state.name}】已冻结（frozen）。`,
        "",
        "收口产物：spec.md、start-prompt.md、decision-log.md（.hapilon/ai-flow/" + state.slug + "/）。",
        "重放方式：新会话把 start-prompt.md 内容发给模型即可按固化流程继续。",
        "决策冲突审查：/build-ai-flow audit（冻结前后都可跑）。",
        "要重开：/build-ai-flow goto <0-9> <原因>。",
    ].join("\n");
}
/** 无活跃 flow 时 bare 命令的引导（含 GPT 六句话术的首句精神） */
export function buildStartGuide() {
    return [
        "当前没有活跃的 build-ai-flow。",
        "",
        "开始：/build-ai-flow start <slug> [目标一句话]",
        "例：/build-ai-flow start 月度质量报告 给领导看的应用测试月报",
        "",
        "适用：开始时说不清、最后要交付的难任务（报告/看板/审核台/方案）。",
        "先倒出来再搞清楚——第一步只整理材料，不急着做成品。",
        "查看已有 flow：/build-ai-flow list",
    ].join("\n");
}
/** 十阶段状态轨文案（render 用）：✓ 已过 / ! 强推 / ● 当前 / ○ 未到 */
export function stageMark(def, state, forcedStages) {
    if (state.status === "frozen")
        return `✓${def.slug}`;
    if (def.index < state.stage)
        return forcedStages.has(def.index) ? `!${def.slug}` : `✓${def.slug}`;
    if (def.index === state.stage)
        return `●${def.slug}`;
    return `○${def.slug}`;
}
