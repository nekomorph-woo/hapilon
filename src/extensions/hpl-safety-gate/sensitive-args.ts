/**
 * sensitive-args.ts — bash 命令敏感文件参数检测（issue #47）
 *
 * #39 的 READ_CONFIRM 只覆盖 read 工具；bash 通道（cat/head/grep 等）读
 * 敏感文件完全绕过。本模块从 bash 命令提取文件参数，复用 hpl-protected-paths
 * 的 READ_CONFIRM 规则做单一判定来源，避免两套敏感文件清单漂移。
 *
 * 只做「词法级」检测：提取参数 → 逐个过 READ_CONFIRM。不做 shell 语义
 * 解析（引号嵌套、变量展开等）——已由 shell 注入检测在更早一层拦下变形。
 */

import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { expandTilde, resolveTarget } from "../hpl-protected-paths/classifier.js";
import { READ_CONFIRM } from "../hpl-protected-paths/rules.js";

/** 复合命令切分：管道 / 顺序 / 与 / 或（不做引号内的操作符识别——注入检测覆盖该层） */
export function splitCommandSegments(command: string): string[] {
  return command.split(/\||;|&&|\|\|/);
}

const KNOWN_FLAGS = new Set([
  "-n", "-c", "-A", "-B", "-C", "-e", "-f", "-m", "-o", "-s", "-v", "-w",
  "-l", "-r", "-u", "-q", "-x", "-z", "-t", "-k", "-i", "-E", "-P", "-a",
  "--color", "--ignore-case", "--line-number", "--max-count", "--quiet",
  "--recursive", "--context", "--after-context", "--before-context",
]);

/** grep 系命令：第一个非 flag 参数是 pattern，不是路径 */
const PATTERN_FIRST_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/**
 * 从单段命令提取疑似路径参数：跳过首词（命令名）、已知 flag、
 * 重定向方向符与 /dev/null。词法级近似——目标是「把敏感文件捞出来问用户」，
 * 允许少量误报（confirm 只是多问一次），不允许漏报敏感文件。
 */
export function extractPathArgs(segment: string, cwd: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const isPatternFirst = PATTERN_FIRST_COMMANDS.has(tokens[0]);
  const args: string[] = [];
  let patternSkipped = false;
  let redirectNext = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    // 重定向目标（> .env）：写语义，不属于本「读保护」判定；跳过该 token
    if (redirectNext) {
      redirectNext = false;
      continue;
    }
    if (tok === ">" || tok === ">>" || tok === "2>" || (tok.startsWith(">") && tok.length > 1 && !tok.startsWith(">/"))) {
      // `>file` 无空格形式：目标是本 token 后缀，无后续 token 要跳
      if (tok.startsWith(">") && tok.length > 1) continue;
      redirectNext = true;
      continue;
    }
    if (tok === "<" || tok === "2>&1") continue;
    if (tok.startsWith("-") && tok !== "-") {
      if (tok.startsWith("--") || KNOWN_FLAGS.has(tok)) continue;
      continue;
    }
    if (tok === "/dev/null") continue;
    if (!isPathLike(tok)) continue;
    if (isPatternFirst && !patternSkipped) {
      patternSkipped = true;
      continue;
    }
    args.push(tok.replace(/^["']|["']$/g, ""));
  }
  return args;
}

/** 粗筛：含路径特征（/ . ~）或至少一个字母数字且非纯数字——过滤数值参数 */
function isPathLike(tok: string): boolean {
  if (/^[0-9]+$/.test(tok)) return false;
  return /[/\\]/.test(tok) || tok.startsWith(".") || tok.startsWith("~") || /[a-zA-Z]/.test(tok);
}

/**
 * bash 命令是否携带命中 READ_CONFIRM 的读取参数。
 * cwd 用于相对路径解析（与 read 工具同语义）。
 */
export function hasSensitiveReadArg(command: string, cwd: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    for (const arg of extractPathArgs(segment, cwd)) {
      const resolved = resolveTarget(expandTilde(arg), cwd);
      for (const pattern of READ_CONFIRM) {
        if (pattern.test(resolved)) return true;
      }
    }
  }
  return false;
}

/** 返回命中的敏感文件 label 列表（提示用户时说明原因） */
export function sensitiveReadLabels(command: string, cwd: string): string[] {
  const labels: string[] = [];
  for (const segment of splitCommandSegments(command)) {
    for (const arg of extractPathArgs(segment, cwd)) {
      const resolved = resolveTarget(expandTilde(arg), cwd);
      for (const pattern of READ_CONFIRM) {
        if (pattern.test(resolved) && !labels.includes(pattern.label)) {
          labels.push(pattern.label);
        }
      }
    }
  }
  return labels;
}
