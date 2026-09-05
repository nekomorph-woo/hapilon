/**
 * pi-listing.ts — spawn pi --list-models 与表格解析
 *
 * 从 config.ts 拆出的独立模块（issue #4）：职责单一，测试从本模块导入。
 */

import { spawn } from "node:child_process";
import { resolvePiCli } from "./pi-cli-path.js";
import { agentDir } from "../config/hapilon-home.js";
import { Cause, Data, Effect, Option } from "effect";

export class PiListingError extends Data.TaggedError("PiListingError")<{
  message: string;
}> {}

/** pi --list-models 输出表格的一行 */
export interface ParsedModel {
  provider: string;
  model: string;
  context: string;
}

/**
 * 解析 pi --list-models 输出的表格。
 * 表头行（provider model context ...）跳过；targetProvider 时只留该 provider 行。
 */
export function parseModelsTable(
  output: string,
  targetProvider?: string,
): ParsedModel[] {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return [];

  const dataLines = lines.slice(1);

  return dataLines
    .map((line) => line.trim().split(/\s{2,}/))
    .filter((cols) => {
      if (cols.length < 2) return false;
      if (targetProvider && cols[0] !== targetProvider) return false;
      return true;
    })
    .map((cols) => ({
      provider: cols[0],
      model: cols[1],
      context: cols[2] ?? "?",
    }));
}

/** spawn `pi --list-models`，按 provider 过滤并解析（失败 reject 带 stderr） */
export const listModelsForProviderEffect = (providerId: string): Effect.Effect<ParsedModel[], PiListingError> => Effect.gen(function* () {
  const piCli = yield* Effect.try({
    // 有意统一为“无法启动 pi:”前缀，补充启动上下文并与同族错误保持一致。
    try: () => resolvePiCli(),
    catch: (err) => new PiListingError({ message: `无法启动 pi: ${err instanceof Error ? err.message : String(err)}` }),
  });
  const piAgentDir = yield* Effect.try({
    try: () => agentDir(),
    catch: (err) => new PiListingError({ message: `无法启动 pi: ${err instanceof Error ? err.message : String(err)}` }),
  });

  return yield* Effect.async<ParsedModel[], PiListingError>((resume) => {
    try {
      const child = spawn(process.execPath, [piCli, "--list-models"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: piAgentDir,
        },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });

      child.on("error", (err) =>
        resume(Effect.fail(new PiListingError({ message: `无法启动 pi: ${err.message}` }))),
      );
      child.on("exit", (code) => {
        if (code !== 0) {
          resume(Effect.fail(new PiListingError({ message: `pi --list-models 失败 (exit ${code}): ${stderr}` })));
          return;
        }
        try {
          resume(Effect.succeed(parseModelsTable(stdout, providerId)));
        } catch (err) {
          resume(Effect.fail(new PiListingError({
            message: `解析 pi --list-models 输出失败: ${err instanceof Error ? err.message : String(err)}`,
          })));
        }
      });
    } catch (err) {
      resume(Effect.fail(new PiListingError({ message: `无法启动 pi: ${err instanceof Error ? err.message : String(err)}` })));
    }
  });
});

/** Promise 兼容包装：调用侧继续 await，失败保留 PiListingError 实例。 */
export function listModelsForProvider(
  providerId: string,
): Promise<ParsedModel[]> {
  return Effect.runPromiseExit(listModelsForProviderEffect(providerId)).then((exit) => {
    if (exit._tag === "Success") return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) return Promise.reject(failure.value);
    return Promise.reject(new Error(String(exit.cause)));
  });
}
