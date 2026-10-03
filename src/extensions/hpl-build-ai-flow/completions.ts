/**
 * completions.ts — 插件专用补全：前缀分派 + 状态感知候选
 *
 * 不用通用 argumentCompletions（设计 §4）：候选集随活跃 flow 状态变化
 * （goto 候选标注回退/前跳、start 候选列磁盘 slug、next 描述带 Gate 状态）。
 * 匹配仍复用 pi-tui 公开的 fuzzyFilter；返回 null = 无补全（pi 约定）。
 */

import { Effect } from "effect";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { evaluateGate, KNOWN_CAPABILITIES, readActiveEffect, loadFlowEffect } from "./machine.js";
import { STAGES } from "./stages.js";

interface Candidate extends AutocompleteItem {
  searchText?: string;
}

function filter(candidates: Candidate[], query: string): AutocompleteItem[] | null {
  const hits = fuzzyFilter([...candidates], query, (c) => `${c.value} ${c.searchText ?? c.description ?? ""}`);
  return hits.length === 0 ? null : hits.map(({ searchText: _ignored, ...item }) => item);
}

/** 读活跃 flow；任何失败都静默回落（补全永不抛错） */
function activeFlowSync(cwd: string) {
  try {
    const slug = Effect.runSync(Effect.either(readActiveEffect(cwd)));
    if (slug._tag !== "Right" || !slug.right) return null;
    const state = Effect.runSync(Effect.either(loadFlowEffect(cwd, slug.right)));
    return state._tag === "Right" ? state.right : null;
  } catch {
    return null;
  }
}

export function buildCompletions(query: string, cwd: string): AutocompleteItem[] | null {
  const trimmed = query.trimStart();
  const flow = activeFlowSync(cwd);

  // 子命令位
  if (!/^(start|goal|goto|next|status|list|audit|debt|cap)\b/.test(trimmed)) {
    const gateHint =
      flow && flow.status === "active"
        ? evaluateGate(cwd, flow.slug, flow.stage, flow.stale).passed
          ? "推进（当前 Gate 已过）"
          : "推进（当前 Gate 未过，将列缺口可强推）"
        : "推进到下一阶段";
    return filter(
      [
        { value: "start ", label: "start", description: "新建 flow：start <目标>（可多行；模型提炼英文 slug 后自动建）", searchText: "start 新建 开始" },
        { value: "next", label: "next", description: gateHint, searchText: "next 推进 下一阶段" },
        { value: "status", label: "status", description: "ASCII 状态轨 + 当前状态 + 建议下一步", searchText: "status 状态 查看进度" },
        { value: "list", label: "list", description: "列出全部 flow", searchText: "list 列表 全部" },
        { value: "goto ", label: "goto", description: "导航到任意阶段（前跳/回补/重做）：goto <0-9> <原因>", searchText: "goto 跳转 回补 前跳 重做" },
        { value: "goal ", label: "goal", description: "拍板目标：goal <定位句>（换行后每行一条验收要点）——S8 盘点与冻结以此为准", searchText: "goal 目标 定位句 验收 拍板" },
        { value: "audit", label: "audit", description: "决策冲突审查（tier:sonnet 读 decision-log 找矛盾）", searchText: "audit 审查 冲突 决策" },
        { value: "debt", label: "debt", description: "查看 Gate 缺口欠账", searchText: "debt 欠账 缺口 查看" },
        { value: "debt resolve ", label: "debt resolve", description: "关闭欠账：debt resolve <G-00x> <说明>", searchText: "debt resolve 关闭 欠账" },
        ...KNOWN_CAPABILITIES.map((id) => {
          const cap = flow?.capabilities?.[id];
          const state =
            cap?.status === "enabled" ? "已启用" : cap?.status === "declined" ? "已拒绝（可重新启用）" : "未决定（S2/S3 会提示是否推荐）";
          return {
            value: `cap ${id} `,
            label: `cap ${id}`,
            description: `能力：${id}（${state}）——enable|decline [说明]`,
            searchText: `cap capability 能力 ${id} 启用 拒绝`,
          };
        }),
      ],
      trimmed,
    );
  }

  if (/^cap\b/.test(trimmed)) {
    const candidates: Candidate[] = [];
    for (const id of KNOWN_CAPABILITIES) {
      const cap = flow?.capabilities?.[id];
      const state =
        cap?.status === "enabled" ? "当前已启用" : cap?.status === "declined" ? "当前已拒绝" : "当前未决定";
      candidates.push(
        { value: `cap ${id} enable `, label: `enable`, description: `${state}——启用${id}`, searchText: `cap ${id} enable 启用` },
        { value: `cap ${id} decline `, label: `decline`, description: `${state}——拒绝（不再重复推荐）`, searchText: `cap ${id} decline 拒绝` },
      );
    }
    return filter(candidates, trimmed);
  }

  if (/^goto\b/.test(trimmed)) {
    const current = flow?.status === "active" || flow?.status === "frozen" ? flow.stage : null;
    const candidates: Candidate[] = STAGES.map((s) => {
      const rel = current === null ? "" : s.index < current ? "回跳" : s.index > current ? "前跳" : "当前";
      return {
        value: `goto ${s.index} `,
        label: `goto ${s.index} ${s.slug}`,
        description: `${rel ? rel + " · " : ""}${s.zh}｜${s.coreQuestion}`,
        searchText: `goto ${s.index} ${s.slug} ${s.zh} ${s.coreQuestion}`,
      };
    });
    return filter(candidates, trimmed);
  }

  return null;
}
