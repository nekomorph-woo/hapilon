/**
 * config/prompts.ts — 交互式问答 helpers（question / yesno）
 *
 * 从 config.ts 拆出（issue #4）：readline 问答与配置处理分离。
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

export async function question(
  rl: ReturnType<typeof createInterface>,
  q: string,
): Promise<string> {
  stdout.write(q);
  const lines = rl[Symbol.asyncIterator]();
  const { value, done } = await lines.next();
  return done ? "" : value;
}

export async function yesno(
  rl: ReturnType<typeof createInterface>,
  q: string,
): Promise<boolean> {
  const a = (await question(rl, q + "（y/N）")).trim().toLowerCase();
  return a === "y" || a === "yes";
}
