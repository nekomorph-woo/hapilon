/**
 * config/prompts.ts — 交互式问答 helpers（question / yesno）
 *
 * 从 config.ts 拆出（issue #4）：readline 问答与配置处理分离。
 */
import { stdout } from "node:process";
export async function question(rl, q) {
    stdout.write(q);
    const lines = rl[Symbol.asyncIterator]();
    const { value, done } = await lines.next();
    return done ? "" : value;
}
export async function yesno(rl, q) {
    const a = (await question(rl, q + "（y/N）")).trim().toLowerCase();
    return a === "y" || a === "yes";
}
