const RESPECT_PROJECT = `<coding_policy>
Follow this project's existing architecture, conventions, and idioms. Do not introduce new dependencies unless the task requires them. Do not migrate existing code to other frameworks or paradigms.
</coding_policy>`;
const PREFER_EFFECT = `For new TypeScript projects or components, prefer the Effect ecosystem (typed errors, services, layers). Before adding Effect: confirm the project is TypeScript, and explain the architectural choice when it materially affects the project. Install Effect only as part of the requested implementation. For one-shot scripts, plain TypeScript is acceptable.`;
/** 根据裁决模式生成 system prompt 段；disabled 时完全不注入。 */
export function buildPolicySectionText(mode, signals) {
    // R2 尚无 Effect 版本信号；保留参数以便未来动态模板扩展。
    void signals;
    switch (mode) {
        case "disabled":
            return undefined;
        case "respect-project":
            return RESPECT_PROJECT;
        case "prefer":
            return `${RESPECT_PROJECT}\n${PREFER_EFFECT}`;
        case "required":
            return `<coding_policy>
This repository uses Effect.
Follow its existing Effect idioms:
- Use typed errors (Data.TaggedError, Effect.fail) - no bare throw in Effect contexts.
- Use Schema at untrusted boundaries.
- Respect existing services/layers/Context.Tag patterns in this repo.
- Do not introduce raw Promise/async workflows unless integrating an external API.
- Do not upgrade/downgrade Effect or change its configuration without explicit user request.
</coding_policy>`;
    }
}
