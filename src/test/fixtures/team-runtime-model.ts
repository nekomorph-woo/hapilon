import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function teamRuntimeModel(pi: ExtensionAPI): void {
  const home = process.env.HAPILON_HOME;
  if (!home) throw new Error("Team verification needs an isolated HAPILON_HOME");
  const output = join(home, "verify-events.jsonl");
  const record = (data: object): void => {
    appendFileSync(output, `${JSON.stringify({
      pid: process.pid,
      role: process.env.HAPI_ORCH_ROLE ?? "owner-or-standalone",
      address: process.env.HC_TERMINAL_ID ?? process.env.HERDR_PANE_ID ?? null,
      ...data,
    })}\n`);
  };

  pi.on("session_start", (event, ctx) => {
    record({ event: "session", reason: event.reason, id: ctx.sessionManager.getSessionId() });
  });

  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider("team-verify", {
    api: "team-verify",
    apiKey: "verify-only",
    baseUrl: "http://127.0.0.1:1",
    models: [{ id: "probe", name: "Team probe", input: ["text"], cost, reasoning: false, contextWindow: 65536, maxTokens: 1024 }],
    streamSimple(model, ctx) {
      const user = ctx.messages.findLast((message) => message.role === "user");
      const text = typeof user?.content === "string" ? user.content
        : user?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") ?? "";
      record({ event: "turn", text, prompt: getCurrentSystemPrompt(ctx.messages), tools: getCurrentTools(ctx.messages).map((tool) => tool.name) });
      const task = /TEAM_VERIFY_DOSSIER=([^\r\n< ]+)/.exec(text)?.[1];
      const role = process.env.HAPI_ORCH_ROLE;
      if (task && role === "worker") appendFileSync(join(task, "worker-report.md"), "Verified worker report.\n");
      if (task && role === "reviewer") appendFileSync(join(task, "reviewer-report.md"), "No findings.\napprove\n");
      const request = /TEAM_VERIFY_CTL=(open|clear) (worker|reviewer)/.exec(text);
      const last = ctx.messages.at(-1);
      if (last?.role === "toolResult") record({ event: "tool", name: last.toolName, error: last.isError, content: last.content });
      const call = request && last?.role !== "toolResult" && !role && getCurrentTools(ctx.messages).some((tool) => tool.name === "team_ctl")
        ? { type: "toolCall" as const, id: "verify-team-ctl", name: "team_ctl", arguments: (request[1] === "open"
          ? { action: "open", role: request[2], model: "team-verify/probe" }
          : { action: "clear", target: request[2] }) as JsonObject }
        : undefined;
      const reason = call ? "toolUse" : "stop";
      const marker = /^TEAM_VERIFY_([A-Z_]+)(?=\s|$)/.exec(text)?.[1] ?? "TURN";
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason,
        message: {
          role: "assistant",
          content: call ? [call] : [{ type: "text", text: `TEAM_VERIFY_DONE_${marker}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
          stopReason: reason,
          timestamp: Date.now(),
        },
      });
      return stream;
    },
  });
}
