/**
 * guard.ts — 阶段跳跃防护：提示不拦截（设计 §8）
 *
 * 有活跃 flow 且 stage ≤ GUARD_STAGE_MAX（产物只有工作区 md）时，
 * 模型 write/edit 的目标在 .hapilon/ 之外 → 不拦执行，notify 提示用户；
 * 同一阶段只提示第一次。无活跃 flow 完全不生效。
 * cwd 取事件上下文（命令与会话 cwd 可能不同步，闭包不可靠）。
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative } from "node:path";
import { Effect } from "effect";
import { loadFlowEffect, readActiveEffect } from "./machine.js";
import { GUARD_STAGE_MAX, stageByIndex } from "./stages.js";
/** 已提示过的 (cwd|slug → stage)，会话内存去重 */
const notified = new Map();
function insideHapilon(cwd, target) {
    const abs = isAbsolute(target) ? target : join(cwd, target);
    const rel = relative(cwd, abs);
    return rel === ".hapilon" || rel.startsWith(".hapilon/");
}
export function registerGuard(pi) {
    pi.on("tool_call", async (event, ctx) => {
        if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event))
            return;
        const target = event.input.path;
        if (typeof target !== "string")
            return;
        const cwd = ctx.cwd;
        if (insideHapilon(cwd, target))
            return;
        let slug = null;
        let stage = -1;
        let status = "active";
        try {
            const active = Effect.runSync(Effect.either(readActiveEffect(cwd)));
            if (active._tag !== "Right" || !active.right)
                return;
            slug = active.right;
            const state = Effect.runSync(Effect.either(loadFlowEffect(cwd, slug)));
            if (state._tag !== "Right")
                return;
            stage = state.right.stage;
            status = state.right.status;
        }
        catch {
            return;
        }
        if (status !== "active" || stage > GUARD_STAGE_MAX)
            return;
        const key = `${cwd}|${slug}`;
        if (notified.get(key) === stage)
            return;
        notified.set(key, stage);
        const def = stageByIndex(stage);
        ctx.ui?.notify?.(`[build-ai-flow] 当前动作超出本阶段默认产物范围：S${stage} ${def.slug}（${def.zh}）阶段写流程外文件 ${target}。\n` +
            `若属于本阶段必要的调查/辅助工作（脚本、SQL、数据导出、草稿），可继续并向用户说明用途；\n` +
            `若准备提前进入后续阶段，用 /build-ai-flow goto <0-9> 带原因记录；否则先完成本阶段产物 ${def.artifacts.join("、")}。` +
            `（本阶段只提示这一次）`, "warning");
    });
}
/** 测试用：清空去重表 */
export function resetGuardState() {
    notified.clear();
}
