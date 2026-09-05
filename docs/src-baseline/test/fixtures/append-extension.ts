// 测试辅助：追加型扩展（与 ponytail before_agent_start 同语义），供加载顺序测试加载
export default function appendExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}PONYTAIL-TAIL-MARKER` };
  });
}
