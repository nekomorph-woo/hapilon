import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkspacePaneContent,
  formatAddedDirTime,
  readAddedWorkspaceDirs,
} from "../../extensions/hpl-startup-header/workspace.js";
import {
  createStartupHeader,
  shortenWorkspacePath,
} from "../../extensions/hpl-startup-header/content.js";
import hplStartupHeader from "../../extensions/hpl-startup-header/index.js";

describe("hpl-startup-header workspace", () => {
  it("按 home/非 home 规则压缩路径", () => {
    assert.equal(shortenWorkspacePath("/Users/alice", "/Users/alice"), "~");
    assert.equal(shortenWorkspacePath("/Users/alice/a/b/c", "/Users/alice"), "~/a/b/c");
    assert.equal(
      shortenWorkspacePath("/Users/alice/morphiiouo/work/hapilon/deep", "/Users/alice"),
      "~/morphiiouo/…/hapilon/deep",
    );
    assert.equal(
      shortenWorkspacePath("/Volumes/Under_M2/morphiiouo/hapilon", "/Users/alice"),
      "/Volumes/Under_M2/…/hapilon",
    );
  });

  it("读取 branch 中最新 add-dir:state", () => {
    const dirs = readAddedWorkspaceDirs([
      { type: "custom", customType: "add-dir:state", data: {
        dirs: [{ absolutePath: "/old", label: "old", addedAt: 1 }],
      } },
      { type: "message", data: {} },
      { type: "custom", customType: "add-dir:state", data: {
        dirs: [{ absolutePath: "/new", label: "new", addedAt: 2 }],
      } },
    ]);
    assert.deepEqual(dirs, [{ absolutePath: "/new", label: "new", addedAt: 2 }]);
    assert.deepEqual(readAddedWorkspaceDirs([]), []);
  });

  it("组装完整路径、目录时间和空目录提示", () => {
    const content = buildWorkspacePaneContent("/workspace/main", [
      { absolutePath: "/workspace/docs", label: "docs", addedAt: Date.UTC(2026, 0, 2, 3, 4) },
    ]);
    assert.equal(content.lines[0], "/workspace/main");
    assert.match(content.lines[2]!, /docs.*\/workspace\/docs.*\d{2}:\d{2}/);
    assert.deepEqual(content.lineStyles, ["text", "muted", "muted"]);

    const empty = buildWorkspacePaneContent("/workspace/main", []);
    assert.match(empty.lines[2]!, /未添加外部目录/);
    assert.match(formatAddedDirTime(Date.UTC(2026, 0, 2, 3, 4)), /^\d{2}:\d{2}$/);
  });

  it("header render 每帧读取最新目录计数", () => {
    let entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const theme = {
      fg: (slot: string, text: string) => `<${slot}>${text}`,
      bold: (text: string) => `<bold>${text}</bold>`,
    } as never;
    const component = createStartupHeader({
      cwd: "/workspace/main",
      sessionManager: { getBranch: () => entries },
    }, {} as never, theme, { expanded: false });

    assert.ok(component.render(80).some((line) => line.includes("Welcome back!")));
    entries = [{
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [{ absolutePath: "/docs", label: "docs", addedAt: 1 }] },
    }];
    assert.ok(component.render(80).some((line) => line.includes("※ +1 dirs")));
  });

  it("注册 /workspace 命令", () => {
    const commands = new Map<string, unknown>();
    hplStartupHeader({
      registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
      on: () => {},
    } as never);
    assert.ok(commands.has("workspace"));
  });

  it("命令在无目录时组装完整路径和提示行", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplStartupHeader({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
    } as never);
    const notices: string[] = [];
    await commands.get("workspace")!.handler("", {
      cwd: "/workspace/main",
      mode: "print",
      hasUI: false,
      model: { id: "model-1" },
      sessionManager: { getBranch: () => [] },
      ui: { notify: (message: string) => notices.push(message) },
    });
    assert.match(notices[0]!, /Workspace/);
    assert.match(notices[0]!, /\/workspace\/main/);
    assert.match(notices[0]!, /未添加外部目录/);
  });
});
