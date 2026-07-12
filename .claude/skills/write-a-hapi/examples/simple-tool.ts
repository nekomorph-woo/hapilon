/**
 * simple-tool.ts — 注册自定义 Tool 示例
 *
 * 功能：注册一个 get_timestamp 工具，LLM 可调用获取格式化时间戳。
 * 演示：pi.registerTool()、TypeBox 参数 schema、StringEnum、execute 生命周期。
 *
 * 用法：
 *   1. pi -e ./simple-tool.ts          # 临时测试
 *   2. 在对话中说 "获取当前时间的 iso 格式"
 *
 * 来源: doc/pi-wiki.md §6.2, §9.2
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_timestamp",
    label: "获取时间戳",
    description:
      "获取当前时间的格式化时间戳。支持 ISO 8601、Unix 时间戳、可读格式。",

    // 在 system prompt 的 "Available tools" 区域显示一行摘要
    promptSnippet: "获取当前时间的格式化时间戳 (iso/unix/readable)",

    // 追加到 system prompt Guidelines 区域的提示
    // ⚠️ 必须明确写工具名，不能用 "Use this tool when..."
    promptGuidelines: [
      "使用 get_timestamp 获取当前时间，不要用 bash date 命令。时间格式用 ISO 8601 保存到文件。",
    ],

    parameters: Type.Object({
      format: StringEnum(["iso", "unix", "readable"] as const, {
        description: "时间格式：iso = ISO 8601, unix = 秒级时间戳, readable = 人类可读",
      }),
      timezone: Type.Optional(
        Type.String({ description: "时区，如 Asia/Shanghai。不传则使用系统时区" }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // 检查是否被取消（Esc / Ctrl+C）
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "操作已取消" }] };
      }

      const now = new Date();
      let result: string;

      switch (params.format) {
        case "iso":
          result = now.toISOString();
          break;
        case "unix":
          result = String(Math.floor(now.getTime() / 1000));
          break;
        case "readable":
          result = now.toLocaleString("zh-CN", {
            timeZone: params.timezone ?? undefined,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          break;
      }

      // content → 发送给 LLM
      // details → TUI 渲染 + 状态持久化（session 重建用）
      return {
        content: [{ type: "text", text: result }],
        details: { format: params.format, timestamp: result },
      };
    },
  });
}
