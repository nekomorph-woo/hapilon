import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { setPolicySection } from "./bridge.js";
import { buildPolicySectionText } from "./inject.js";
import { resolveWithSignalsEffect } from "./override.js";

export default function hplEffectPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    try {
      const opts = event.systemPromptOptions;
      if (!opts || typeof opts.cwd !== "string" || opts.cwd.trim().length === 0) {
        setPolicySection(undefined);
        return {};
      }
      if (opts.customPrompt) {
        setPolicySection(undefined);
        return {};
      }

      const { mode, signals } = Effect.runSync(resolveWithSignalsEffect(opts.cwd));
      setPolicySection(buildPolicySectionText(mode, signals));
      return {};
    } catch (err) {
      setPolicySection(undefined);
      console.warn("[hpl-effect-policy] policy injection disabled after an error:", err);
      return {};
    }
  });
}
