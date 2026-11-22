/**
 * sensitive-args.ts — bash 命令敏感文件参数检测
 *
 * Bash 与 read 工具共用 READ_CONFIRM。Bash 检查以路径参数为线索；
 * 只有能识别为纯字面输出或访问元数据的操作才排除。
 */

import { createRequire } from "node:module";
import type ts from "typescript";
import { expandTilde, resolveTarget } from "../hpl-protected-paths/classifier.js";
import { READ_CONFIRM } from "../hpl-protected-paths/rules.js";

/** 复合命令切分：管道 / 顺序 / 与 / 或（不做引号内的操作符识别——注入检测覆盖该层） */
export function splitCommandSegments(command: string): string[] {
  return command.split(/\||;|&&|\|\|/);
}

const LITERAL_WORD = /^(?:(?:~\/)?[\w.,/+:-]+|'[\w.,/+:-]+'|"[\w.,/+:-]+")$/;

const NODE_HEREDOC = /^[ \t]*node[ \t]+--input-type=module[ \t]+<<[ \t]*'([A-Za-z_]\w*)'[ \t]*\n/;
const require = createRequire(import.meta.url);

function hasLiteralNodeInput(command: string): boolean {
  // 限制解析量；较长程序仍走原检查。
  if (command.length > 4096) return false;
  const header = NODE_HEREDOC.exec(command);
  if (!header) return false;
  const lines = command.slice(header[0].length).split("\n");
  const end = lines.indexOf(header[1]);
  if (end < 0 || lines.slice(end + 1).some(line => !/^[ \t]*$/.test(line))) return false;

  const syntax: typeof ts = require("typescript");
  const source = syntax.createSourceFile("stdin.js", lines.slice(0, end).join("\n"), syntax.ScriptTarget.Latest);
  if (!("parseDiagnostics" in source) || !Array.isArray(source.parseDiagnostics) || source.parseDiagnostics.length) return false;

  type ValueKind = "array" | "scalar";
  const constants = new Map<string, ValueKind>();
  function valueKind(expression: ts.Expression, depth = 0): ValueKind | undefined {
    if (depth >= 16) return undefined;
    if (syntax.isStringLiteral(expression) || syntax.isNumericLiteral(expression)) return "scalar";
    if (syntax.isIdentifier(expression)) return constants.get(expression.text);
    const kindOf = (child: ts.Expression) => valueKind(child, depth + 1);
    if (syntax.isArrayLiteralExpression(expression) && expression.elements.every(item => kindOf(item))) return "array";
    if (syntax.isPropertyAccessExpression(expression) && expression.name.text === "length" && kindOf(expression.expression) === "array") return "scalar";
    if (syntax.isBinaryExpression(expression) && expression.operatorToken.kind === syntax.SyntaxKind.EqualsEqualsEqualsToken
      && kindOf(expression.left) === "scalar" && kindOf(expression.right) === "scalar") return "scalar";
    if (syntax.isConditionalExpression(expression) && kindOf(expression.condition) === "scalar"
      && kindOf(expression.whenTrue) === "scalar" && kindOf(expression.whenFalse) === "scalar") return "scalar";
    return undefined;
  }

  // 只有字面数据及其派生值能进入输出，不把未知 JavaScript 当成数据。
  return source.statements.every(statement => {
    if (syntax.isVariableStatement(statement) && (statement.declarationList.flags & syntax.NodeFlags.Const)) {
      return statement.declarationList.declarations.every(({ name, initializer }) => {
        if (!syntax.isIdentifier(name) || name.text === "console" || constants.has(name.text) || !initializer) return false;
        const kind = valueKind(initializer);
        if (!kind) return false;
        constants.set(name.text, kind);
        return true;
      });
    }
    if (!syntax.isExpressionStatement(statement) || !syntax.isCallExpression(statement.expression)) return false;
    const { expression, arguments: args } = statement.expression;
    return syntax.isPropertyAccessExpression(expression) && syntax.isIdentifier(expression.expression)
      && expression.expression.text === "console" && expression.name.text === "log"
      && args.every(arg => valueKind(arg));
  });
}

function sensitiveReadSegments(command: string): string[] {
  if (hasLiteralNodeInput(command)) return [];

  const segments = splitCommandSegments(command);
  if (!command.split(/&&|\r?\n/).every(line =>
    line.split(/[ \t]+/).every(word => !word || LITERAL_WORD.test(word)),
  )) return segments;

  return segments.map(segment => segment.replace(/^[ \t]*(ls|stat)[ \t]+([^\r\n]+)/gm, (line, word: string, rest: string) => {
    const args = rest.trim().split(/[ \t]+/).map(arg => arg.replace(/^["']|["']$/g, ""));
    const onlyMetadata = args.every(arg => !arg.startsWith("-") || arg === "--" || (word === "ls" && /^-[adhl]+$/.test(arg)));
    return onlyMetadata ? word : line;
  }));
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
    if (tok === "2>&1") continue;
    if (/^\d*<$/.test(tok) || /^\d*<[^<>]/.test(tok)) {
      const target = /^\d*<$/.test(tok) ? tokens[++i] : tok.replace(/^\d*</, "");
      if (target) args.push(target.replace(/^["']|["']$/g, ""));
      continue;
    }
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
  for (const segment of sensitiveReadSegments(command)) {
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
  for (const segment of sensitiveReadSegments(command)) {
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
