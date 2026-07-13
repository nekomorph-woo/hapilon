/**
 * protected-paths 单元测试 — 路径匹配 + 保护分类
 *
 * 测试纯函数 classifyPath() 和 expandTilde()，
 * 不依赖 Pi ExtensionAPI mock。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  classifyPath,
  expandTilde,
} from "../../extensions/protected-paths.js";

const home = homedir();

describe("protected-paths", () => {
  describe("expandTilde()", () => {
    it("~ → 展开为 home 目录（裸波浪号）", () => {
      assert.strictEqual(expandTilde("~"), home);
    });

    it("~/ → 展开为 home 目录", () => {
      assert.strictEqual(expandTilde("~/"), home + "/");
    });

    it("~/.ssh/id_rsa → 展开为绝对路径", () => {
      assert.strictEqual(expandTilde("~/.ssh/id_rsa"), home + "/.ssh/id_rsa");
    });

    it("非 tilde 路径 → 原样返回", () => {
      assert.strictEqual(expandTilde("/etc/passwd"), "/etc/passwd");
    });

    it("相对路径 → 原样返回", () => {
      assert.strictEqual(expandTilde("./.env"), "./.env");
    });
  });

  describe("classifyPath() — 写保护", () => {
    it("write .env → block", () => {
      assert.strictEqual(classifyPath(".env", "write"), "block");
    });

    it("write .env.production → block", () => {
      assert.strictEqual(classifyPath(".env.production", "write"), "block");
    });

    it("write package-lock.json → block", () => {
      assert.strictEqual(classifyPath("package-lock.json", "write"), "block");
    });

    it("write yarn.lock → block", () => {
      assert.strictEqual(classifyPath("yarn.lock", "write"), "block");
    });

    it("write pnpm-lock.yaml → block", () => {
      assert.strictEqual(classifyPath("pnpm-lock.yaml", "write"), "block");
    });

    it("write pnpm-lock.yml → block", () => {
      assert.strictEqual(classifyPath("pnpm-lock.yml", "write"), "block");
    });

    it("write bun.lockb → block", () => {
      assert.strictEqual(classifyPath("bun.lockb", "write"), "block");
    });

    it("write Cargo.lock → block（其他语言锁文件）", () => {
      assert.strictEqual(classifyPath("Cargo.lock", "write"), "block");
    });

    it("write composer.lock → block", () => {
      assert.strictEqual(classifyPath("composer.lock", "write"), "block");
    });

    it("write Gemfile.lock → block", () => {
      assert.strictEqual(classifyPath("Gemfile.lock", "write"), "block");
    });

    it("write poetry.lock → block", () => {
      assert.strictEqual(classifyPath("poetry.lock", "write"), "block");
    });

    it("edit .git/config → block", () => {
      assert.strictEqual(classifyPath(".git/config", "edit"), "block");
    });

    it("write .git/hooks/pre-commit → block", () => {
      assert.strictEqual(
        classifyPath(".git/hooks/pre-commit", "write"),
        "block",
      );
    });

    it("write .gitmodules → block", () => {
      assert.strictEqual(classifyPath(".gitmodules", "write"), "block");
    });

    it("write .github/workflows/deploy.yml → block（CI/CD 管道）", () => {
      assert.strictEqual(
        classifyPath(".github/workflows/deploy.yml", "write"),
        "block",
      );
    });

    it("write .gitlab-ci.yml → block", () => {
      assert.strictEqual(classifyPath(".gitlab-ci.yml", "write"), "block");
    });

    it("write ~/.ssh/id_rsa → block（含 tilde 展开）", () => {
      assert.strictEqual(classifyPath("~/.ssh/id_rsa", "write"), "block");
    });

    it("write ~/.aws/credentials → block", () => {
      assert.strictEqual(classifyPath("~/.aws/credentials", "write"), "block");
    });

    it("write ~/.netrc → block（凭证文件）", () => {
      assert.strictEqual(classifyPath("~/.netrc", "write"), "block");
    });

    it("write ~/.git-credentials → block", () => {
      assert.strictEqual(classifyPath("~/.git-credentials", "write"), "block");
    });

    it("write ~/.docker/config.json → block", () => {
      assert.strictEqual(
        classifyPath("~/.docker/config.json", "write"),
        "block",
      );
    });

    it("write ~/.kube/config → block（K8s 凭证）", () => {
      assert.strictEqual(classifyPath("~/.kube/config", "write"), "block");
    });

    it("write project.kubeconfig → block", () => {
      assert.strictEqual(classifyPath("project.kubeconfig", "write"), "block");
    });

    it("write ~/.npmrc → block（npm token）", () => {
      assert.strictEqual(classifyPath("~/.npmrc", "write"), "block");
    });

    it("write server.key → block（匹配 *.key）", () => {
      assert.strictEqual(classifyPath("server.key", "write"), "block");
    });

    it("write cert.pem → block（匹配 *.pem）", () => {
      assert.strictEqual(classifyPath("cert.pem", "write"), "block");
    });

    it("write cert.p12 → block（匹配 *.p12）", () => {
      assert.strictEqual(classifyPath("cert.p12", "write"), "block");
    });

    it("write keystore.jks → block（匹配 *.jks）", () => {
      assert.strictEqual(classifyPath("keystore.jks", "write"), "block");
    });

    it("write server.keystore → block", () => {
      assert.strictEqual(classifyPath("server.keystore", "write"), "block");
    });

    it("write server.truststore → block", () => {
      assert.strictEqual(classifyPath("server.truststore", "write"), "block");
    });

    it("write key.asc → block（匹配 *.asc）", () => {
      assert.strictEqual(classifyPath("key.asc", "write"), "block");
    });

    it("write id_rsa → block", () => {
      assert.strictEqual(classifyPath("id_rsa", "write"), "block");
    });

    it("write id_ecdsa → block", () => {
      assert.strictEqual(classifyPath("id_ecdsa", "write"), "block");
    });

    it("write id_ecdsa.pub → block", () => {
      assert.strictEqual(classifyPath("id_ecdsa.pub", "write"), "block");
    });

    it("write id_ed25519.pub → block", () => {
      assert.strictEqual(classifyPath("id_ed25519.pub", "write"), "block");
    });

    it("write authorized_keys → block", () => {
      assert.strictEqual(classifyPath("authorized_keys", "write"), "block");
    });

    // 相对路径解析
    it("write ./.env → block（相对路径解析）", () => {
      assert.strictEqual(classifyPath("./.env", "write"), "block");
    });

    // 自定义 cwd
    it("write .env with custom cwd → block", () => {
      assert.strictEqual(
        classifyPath(".env", "write", "/tmp/mock-project"),
        "block",
      );
    });
  });

  describe("classifyPath() — 读保护", () => {
    it("read ~/.ssh/id_rsa → confirm", () => {
      assert.strictEqual(classifyPath("~/.ssh/id_rsa", "read"), "confirm");
    });

    it("read ~/.aws/credentials → confirm", () => {
      assert.strictEqual(
        classifyPath("~/.aws/credentials", "read"),
        "confirm",
      );
    });

    it("read ~/.aws/config → confirm", () => {
      assert.strictEqual(classifyPath("~/.aws/config", "read"), "confirm");
    });

    it("read ~/.config/gcloud/app_credentials.json → confirm", () => {
      assert.strictEqual(
        classifyPath("~/.config/gcloud/application_default_credentials.json", "read"),
        "confirm",
      );
    });

    it("read ~/.docker/config.json → confirm（Docker 凭证）", () => {
      assert.strictEqual(
        classifyPath("~/.docker/config.json", "read"),
        "confirm",
      );
    });

    it("read ~/.kube/config → confirm（K8s 凭证）", () => {
      assert.strictEqual(
        classifyPath("~/.kube/config", "read"),
        "confirm",
      );
    });

    it("read project.kubeconfig → confirm", () => {
      assert.strictEqual(
        classifyPath("project.kubeconfig", "read"),
        "confirm",
      );
    });

    it("read ~/.npmrc → confirm（npm token）", () => {
      assert.strictEqual(classifyPath("~/.npmrc", "read"), "confirm");
    });
  });

  describe("classifyPath() — 放行", () => {
    it("write src/app.ts → allow", () => {
      assert.strictEqual(classifyPath("src/app.ts", "write"), "allow");
    });

    it("write README.md → allow", () => {
      assert.strictEqual(classifyPath("README.md", "write"), "allow");
    });

    it("edit src/utils.ts → allow", () => {
      assert.strictEqual(classifyPath("src/utils.ts", "edit"), "allow");
    });

    it("read package.json → allow（非锁文件）", () => {
      assert.strictEqual(classifyPath("package.json", "read"), "allow");
    });

    it("read .gitignore → allow（非 .git/config）", () => {
      assert.strictEqual(classifyPath(".gitignore", "read"), "allow");
    });
  });

  describe("classifyPath() — 边界条件", () => {
    it("空路径 → allow", () => {
      assert.strictEqual(classifyPath("", "write"), "allow");
    });

    it("未知工具类型 → allow", () => {
      assert.strictEqual(classifyPath(".env", "delete" as string), "allow");
      assert.strictEqual(classifyPath("~/.ssh/id_rsa", "unknown_tool" as string), "allow");
    });

    it("绝对路径不受 cwd 影响", () => {
      assert.strictEqual(
        classifyPath(resolve("/absolute/.env"), "write", "/anywhere"),
        "block",
      );
    });
  });
});
