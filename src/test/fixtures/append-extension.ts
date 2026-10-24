// 测试辅助：sections 贡献型扩展（与 ponytail 5.x before_agent_start 同语义），供加载顺序测试加载
export default function sectionsExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const sections = (event.systemPromptOptions as { sections?: Record<string, string> }).sections;
    if (sections && typeof sections === "object") {
      sections.ponytail = "PONYTAIL-TAIL-MARKER";
      return {};
    }
    // 旧版 pi 无 sections 通道：退回尾部追加
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}PONYTAIL-TAIL-MARKER` };
  });
}
