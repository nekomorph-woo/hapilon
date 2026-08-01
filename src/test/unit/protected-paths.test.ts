/**
 * protected-paths 单元测试 — 分层路径匹配 + 白名单 + /allow
 *
 * 测试纯函数 classifyPath()、expandTilde() 和白名单辅助函数，
 * 不依赖 Pi ExtensionAPI mock。
 */

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  classifyPath,
  expandTilde,
  resolveTarget,
  parseAllowArgs,
} from "../../extensions/protected-paths/index.js";
import protectedPathsExtension from "../../extensions/protected-paths/index.js";
import { addTrust, isSessionTrusted, clearSessionTrust } from "../../trust-store.js";

const home = homedir();

describe("protected-paths", () => {
  describe("expandTilde()", () => {
    it("~ → home", () => assert.strictEqual(expandTilde("~"), home));
    it("~/ → home/", () => assert.strictEqual(expandTilde("~/"), home + "/"));
    it("~/.ssh/id_rsa → 绝对路径", () => assert.strictEqual(expandTilde("~/.ssh/id_rsa"), home + "/.ssh/id_rsa"));
    it("非 tilde → 原样", () => assert.strictEqual(expandTilde("/etc/passwd"), "/etc/passwd"));
    it("相对路径 → 原样", () => assert.strictEqual(expandTilde("./.env"), "./.env"));
  });

  describe("resolveTarget()", () => {
    it("相对路径 → 解析为绝对", () => {
      const r = resolveTarget(".env", "/tmp/project");
      assert.ok(r.startsWith("/"), "应返回绝对路径");
      assert.ok(r.endsWith("/.env"), "应包含文件名");
    });
    it("绝对路径 → 解析 symlink", () => {
      // macOS /etc → /private/etc，realpathSync 会跟随 symlink
      const r = resolveTarget("/etc/hosts", "/tmp");
      assert.ok(r.endsWith("/etc/hosts") || r.endsWith("/private/etc/hosts"),
        "应解析为 /etc/hosts 或其 symlink 真实路径");
    });
    it("空路径 → cwd", () => {
      assert.strictEqual(resolveTarget("", "/tmp/project"), "/tmp/project");
    });
  });

  // ─── 写保护 — 硬 block（高危：永远不允许）─────────────────────

  describe("classifyPath() — 写保护 block", () => {
    it("edit .git/config → block", () => assert.strictEqual(classifyPath(".git/config", "edit"), "block"));
    it("write .git/hooks/pre-commit → block", () => assert.strictEqual(classifyPath(".git/hooks/pre-commit", "write"), "block"));
    it("write ~/.ssh/id_rsa → block", () => assert.strictEqual(classifyPath("~/.ssh/id_rsa", "write"), "block"));
    it("write ~/.aws/credentials → block", () => assert.strictEqual(classifyPath("~/.aws/credentials", "write"), "block"));
    it("write ~/.netrc → block", () => assert.strictEqual(classifyPath("~/.netrc", "write"), "block"));
    it("write ~/.git-credentials → block", () => assert.strictEqual(classifyPath("~/.git-credentials", "write"), "block"));
    it("write ~/.docker/config.json → block", () => assert.strictEqual(classifyPath("~/.docker/config.json", "write"), "block"));
    it("write ~/.kube/config → block", () => assert.strictEqual(classifyPath("~/.kube/config", "write"), "block"));
    it("write ~/.npmrc → block", () => assert.strictEqual(classifyPath("~/.npmrc", "write"), "block"));
    it("write server.key → block（*.key）", () => assert.strictEqual(classifyPath("server.key", "write"), "block"));
    it("write cert.pem → block（*.pem）", () => assert.strictEqual(classifyPath("cert.pem", "write"), "block"));
    it("write cert.p12 → block（*.p12）", () => assert.strictEqual(classifyPath("cert.p12", "write"), "block"));
    it("write keystore.jks → block（*.jks）", () => assert.strictEqual(classifyPath("keystore.jks", "write"), "block"));
    it("write server.keystore → block", () => assert.strictEqual(classifyPath("server.keystore", "write"), "block"));
    it("write server.truststore → block", () => assert.strictEqual(classifyPath("server.truststore", "write"), "block"));
    it("write key.asc → block（*.asc）", () => assert.strictEqual(classifyPath("key.asc", "write"), "block"));
    it("write id_rsa → block", () => assert.strictEqual(classifyPath("id_rsa", "write"), "block"));
    it("write id_ecdsa → block", () => assert.strictEqual(classifyPath("id_ecdsa", "write"), "block"));
    it("write id_ecdsa.pub → block", () => assert.strictEqual(classifyPath("id_ecdsa.pub", "write"), "block"));
    it("write id_ed25519.pub → block", () => assert.strictEqual(classifyPath("id_ed25519.pub", "write"), "block"));
    it("write authorized_keys → block", () => assert.strictEqual(classifyPath("authorized_keys", "write"), "block"));
  });

  // ─── 写保护 — confirm（中危：工作中可能需要改）─────────────────

  describe("classifyPath() — 写保护 confirm", () => {
    it("write .env → confirm", () => assert.strictEqual(classifyPath(".env", "write"), "confirm"));
    it("write .env.production → confirm", () => assert.strictEqual(classifyPath(".env.production", "write"), "confirm"));
    it("write package-lock.json → confirm", () => assert.strictEqual(classifyPath("package-lock.json", "write"), "confirm"));
    it("write yarn.lock → confirm", () => assert.strictEqual(classifyPath("yarn.lock", "write"), "confirm"));
    it("write pnpm-lock.yaml → confirm", () => assert.strictEqual(classifyPath("pnpm-lock.yaml", "write"), "confirm"));
    it("write bun.lockb → confirm", () => assert.strictEqual(classifyPath("bun.lockb", "write"), "confirm"));
    it("write Cargo.lock → confirm", () => assert.strictEqual(classifyPath("Cargo.lock", "write"), "confirm"));
    it("write composer.lock → confirm", () => assert.strictEqual(classifyPath("composer.lock", "write"), "confirm"));
    it("write Gemfile.lock → confirm", () => assert.strictEqual(classifyPath("Gemfile.lock", "write"), "confirm"));
    it("write poetry.lock → confirm", () => assert.strictEqual(classifyPath("poetry.lock", "write"), "confirm"));
    it("write .gitmodules → confirm", () => assert.strictEqual(classifyPath(".gitmodules", "write"), "confirm"));
    it("write .github/workflows/deploy.yml → confirm", () => assert.strictEqual(classifyPath(".github/workflows/deploy.yml", "write"), "confirm"));
    it("write .gitlab-ci.yml → confirm", () => assert.strictEqual(classifyPath(".gitlab-ci.yml", "write"), "confirm"));
    it("write project.kubeconfig → confirm", () => assert.strictEqual(classifyPath("project.kubeconfig", "write"), "confirm"));
    it("write ./.env → confirm（相对路径）", () => assert.strictEqual(classifyPath("./.env", "write"), "confirm"));
    it("write .env custom cwd → confirm", () => assert.strictEqual(classifyPath(".env", "write", "/tmp/project"), "confirm"));
  });

  // ─── 读保护 — confirm ──────────────────────────────────────────

  describe("classifyPath() — 读保护 confirm", () => {
    it("read ~/.ssh/id_rsa → confirm", () => assert.strictEqual(classifyPath("~/.ssh/id_rsa", "read"), "confirm"));
    it("read ~/.aws/credentials → confirm", () => assert.strictEqual(classifyPath("~/.aws/credentials", "read"), "confirm"));
    it("read ~/.aws/config → confirm", () => assert.strictEqual(classifyPath("~/.aws/config", "read"), "confirm"));
    it("read ~/.config/gcloud/creds.json → confirm", () => assert.strictEqual(classifyPath("~/.config/gcloud/application_default_credentials.json", "read"), "confirm"));
    it("read ~/.docker/config.json → confirm", () => assert.strictEqual(classifyPath("~/.docker/config.json", "read"), "confirm"));
    it("read ~/.kube/config → confirm", () => assert.strictEqual(classifyPath("~/.kube/config", "read"), "confirm"));
    it("read project.kubeconfig → confirm", () => assert.strictEqual(classifyPath("project.kubeconfig", "read"), "confirm"));
    it("read ~/.npmrc → confirm", () => assert.strictEqual(classifyPath("~/.npmrc", "read"), "confirm"));
  });

  // ─── 放行 ───────────────────────────────────────────────────────

  describe("classifyPath() — 放行", () => {
    it("write src/app.ts → allow", () => assert.strictEqual(classifyPath("src/app.ts", "write"), "allow"));
    it("read package.json → allow", () => assert.strictEqual(classifyPath("package.json", "read"), "allow"));
    it("read .gitignore → allow", () => assert.strictEqual(classifyPath(".gitignore", "read"), "allow"));
    it("空路径 → allow", () => assert.strictEqual(classifyPath("", "write"), "allow"));
  });

  // ─── /allow 参数解析（批量支持，纯函数）────────────────────────────

  describe("parseAllowArgs()", () => {
    it("单个路径 → add", () => {
      assert.deepStrictEqual(parseAllowArgs(".env"), { kind: "add", paths: [".env"] });
    });
    it("空格分隔批量 → add 多条", () => {
      assert.deepStrictEqual(parseAllowArgs(".env .env.production"), {
        kind: "add",
        paths: [".env", ".env.production"],
      });
    });
    it("多余空格与换行 → trim 后解析", () => {
      assert.deepStrictEqual(parseAllowArgs("  .env  .gitmodules\n.env.production "), {
        kind: "add",
        paths: [".env", ".gitmodules", ".env.production"],
      });
    });
    it("--list → list", () => assert.deepStrictEqual(parseAllowArgs("--list"), { kind: "list", paths: [] }));
    it("--clear → clear", () => assert.deepStrictEqual(parseAllowArgs("--clear"), { kind: "clear", paths: [] }));
    it("空输入 → add 空列表（handler 判空给用法提示）", () => {
      assert.deepStrictEqual(parseAllowArgs(""), { kind: "add", paths: [] });
    });
  });

  // ─── 白名单 resolve 一致性（调用层约定：add/is 均用 resolveTarget 后的路径）──

  describe("白名单 resolve 一致性", () => {
    afterEach(() => clearSessionTrust());

    it("/allow .env 后 agent 写 ./.env 命中白名单", () => {
      const cwd = "/tmp/project";
      // 模拟 /allow：存储 resolveTarget 后的路径
      addTrust("write", resolveTarget(".env", cwd), "session", cwd);
      // 模拟 agent 用不同写法写入：入口统一 resolve 后检查
      assert.strictEqual(isSessionTrusted("write", resolveTarget("./.env", cwd)), true);
    });

    it("原样存储时写法一变即失效（证明调用层必须 resolve）", () => {
      const cwd = "/tmp/project";
      addTrust("write", ".env", "session", cwd);
      assert.strictEqual(isSessionTrusted("write", ".env"), true);
      assert.strictEqual(isSessionTrusted("write", "./.env"), false);
    });
  });

  // ─── /allow 命令行为（高危路径二次确认，Seam 直调 handler）────────

  describe("/allow 命令（高危确认）", () => {
    afterEach(() => clearSessionTrust());

    function captureAllowHandler() {
      let allowHandler: ((argsStr: string, ctx: unknown) => Promise<unknown>) | undefined;
      const pi = {
        on: () => {},
        registerCommand: (name: string, def: { handler: unknown }) => {
          if (name === "allow") allowHandler = def.handler as typeof allowHandler;
        },
      };
      protectedPathsExtension(pi as never);
      assert.ok(allowHandler, "/allow 命令已注册");
      return allowHandler as (argsStr: string, ctx: unknown) => Promise<unknown>;
    }

    it("confirm 路径 → 直接加白名单，不弹高危确认", async () => {
      const h = captureAllowHandler();
      const ctx = {
        hasUI: true,
        cwd: "/tmp",
        ui: {
          select: async () => {
            throw new Error("confirm 路径不应弹确认框");
          },
          notify: () => {},
        },
      };
      await h(".env", ctx);
      assert.strictEqual(isSessionTrusted("write", resolveTarget(".env", "/tmp")), true);
    });

    it("block 路径 → 弹高危确认，拒绝则不加", async () => {
      const h = captureAllowHandler();
      let selectCalls = 0;
      const ctx = {
        hasUI: true,
        cwd: "/tmp",
        ui: {
          select: async () => {
            selectCalls++;
            return "Deny";
          },
          notify: () => {},
        },
      };
      await h("~/.ssh/id_rsa", ctx);
      assert.strictEqual(selectCalls, 1, "应弹一次高危确认");
      assert.strictEqual(isSessionTrusted("write", resolveTarget("~/.ssh/id_rsa", "/tmp")), false);
    });

    it("block 路径 → 确认后加白名单（write/edit/read 三命令维度）", async () => {
      const h = captureAllowHandler();
      const ctx = {
        hasUI: true,
        cwd: "/tmp",
        ui: {
          select: async () => "Allow this Session",
          notify: () => {},
        },
      };
      await h("~/.ssh/id_rsa", ctx);
      const key = resolveTarget("~/.ssh/id_rsa", "/tmp");
      assert.strictEqual(isSessionTrusted("write", key), true);
      assert.strictEqual(isSessionTrusted("edit", key), true);
      assert.strictEqual(isSessionTrusted("read", key), true);
    });

    it("非交互（无 UI）block 路径 → 拒绝", async () => {
      const h = captureAllowHandler();
      await h("~/.ssh/id_rsa", { cwd: "/tmp", hasUI: false });
      assert.strictEqual(isSessionTrusted("write", resolveTarget("~/.ssh/id_rsa", "/tmp")), false);
    });

    it("批量 → 逐条处理", async () => {
      const h = captureAllowHandler();
      const ctx = {
        hasUI: true,
        cwd: "/tmp",
        ui: {
          select: async () => "Deny",
          notify: () => {},
        },
      };
      await h(".env .env.production", ctx);
      assert.strictEqual(isSessionTrusted("write", resolveTarget(".env", "/tmp")), true);
      assert.strictEqual(isSessionTrusted("write", resolveTarget(".env.production", "/tmp")), true);
    });
  });

  // ── Seam B：拦截日志（tool_call 回调 + spy console.warn，issue #6）──
  // 仅捕获注册的回调并直接调用，不经过 Pi 运行时，不执行任何命令。
  describe("拦截日志（tool_call 回调）", () => {
    function captureToolCallHandler() {
      let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
      const pi = {
        on: (name: string, cb: unknown) => {
          if (name === "tool_call") handler = cb as typeof handler;
        },
        // protected-paths 扩展注册了 /allow 命令，mock 需提供该方法
        registerCommand: () => {},
      };
      protectedPathsExtension(pi as never);
      assert.ok(handler, "tool_call 回调已注册");
      return handler;
    }

    const writeEvent = (path: string) => ({
      toolName: "write",
      input: { path },
    });
    const readEvent = (path: string) => ({
      toolName: "read",
      input: { path },
    });
    const noUI = { cwd: "/tmp", hasUI: false };

    it("write BLOCK 命中 → console.warn 记录 reason（不再静默）", async () => {
      const handler = captureToolCallHandler();
      const warn = mock.method(console, "warn");
      try {
        const result = (await handler(writeEvent("~/.ssh/id_rsa"), noUI)) as
          | { block?: boolean }
          | null
          | undefined;
        assert.strictEqual(result?.block, true);
        assert.strictEqual(warn.mock.callCount(), 1);
        assert.match(String(warn.mock.calls[0]?.arguments[0]), /受保护的文件路径/);
      } finally {
        warn.mock.restore();
      }
    });

    it("write CONFIRM 非交互拒绝 → console.warn 记录 reason", async () => {
      const handler = captureToolCallHandler();
      const warn = mock.method(console, "warn");
      try {
        const result = (await handler(writeEvent(".env"), noUI)) as
          | { block?: boolean }
          | null
          | undefined;
        assert.strictEqual(result?.block, true);
        assert.strictEqual(warn.mock.callCount(), 1);
        assert.match(String(warn.mock.calls[0]?.arguments[0]), /非交互模式下拦截中危写入/);
      } finally {
        warn.mock.restore();
      }
    });

    it("read CONFIRM 非交互拒绝 → console.warn 记录 reason", async () => {
      const handler = captureToolCallHandler();
      const warn = mock.method(console, "warn");
      try {
        const result = (await handler(readEvent("~/.ssh/id_rsa"), noUI)) as
          | { block?: boolean }
          | null
          | undefined;
        assert.strictEqual(result?.block, true);
        assert.strictEqual(warn.mock.callCount(), 1);
        assert.match(String(warn.mock.calls[0]?.arguments[0]), /非交互模式下禁止读取敏感文件/);
      } finally {
        warn.mock.restore();
      }
    });
  });
});
