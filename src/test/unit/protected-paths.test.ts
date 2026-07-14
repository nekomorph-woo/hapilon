/**
 * protected-paths 单元测试 — 分层路径匹配 + 白名单 + /allow
 *
 * 测试纯函数 classifyPath()、expandTilde() 和白名单辅助函数，
 * 不依赖 Pi ExtensionAPI mock。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  classifyPath,
  expandTilde,
  resolveTarget,
  addAllow,
  removeAllow,
  isAllowed,
  clearAllow,
  listAllow,
} from "../../extensions/protected-paths/index.js";

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

  // ─── 白名单 ────────────────────────────────────────────────────

  describe("whitelist（白名单）", () => {
    // 每个 test 前清空白名单
    const resetWhitelist = () => {
      clearAllow();
      // 验证清空
      assert.strictEqual(listAllow().length, 0);
    };

    it("addAllow → isAllowed → true", () => {
      resetWhitelist();
      addAllow("/tmp/project/.env", "/tmp/project");
      assert.strictEqual(isAllowed("/tmp/project/.env"), true);
    });

    it("未添加的路径 → isAllowed → false", () => {
      resetWhitelist();
      assert.strictEqual(isAllowed("/tmp/project/.env"), false);
    });

    it("removeAllow 后 → isAllowed → false", () => {
      resetWhitelist();
      addAllow("/tmp/project/.env", "/tmp/project");
      removeAllow("/tmp/project/.env", "/tmp/project");
      assert.strictEqual(isAllowed("/tmp/project/.env"), false);
    });

    it("listAllow 返回已添加路径", () => {
      resetWhitelist();
      addAllow("/tmp/project/.env", "/tmp/project");
      const list = listAllow();
      assert.strictEqual(list.length, 1);
      assert.ok(list[0].endsWith(".env"));
    });

    it("clearAllow 清空所有", () => {
      resetWhitelist();
      addAllow("/tmp/project/.env", "/tmp/project");
      addAllow("/tmp/project/.gitmodules", "/tmp/project");
      clearAllow();
      assert.strictEqual(listAllow().length, 0);
    });

    it("相对路径 → 解析为绝对后加白名单", () => {
      resetWhitelist();
      addAllow("./.env", "/tmp/project");
      assert.strictEqual(isAllowed("/tmp/project/.env"), true);
    });

    it("空路径 → 不加白名单", () => {
      resetWhitelist();
      addAllow("", "/tmp/project");
      assert.strictEqual(listAllow().length, 0);
    });
  });
});
