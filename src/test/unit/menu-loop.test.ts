import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMenuLoop, MENU_EXIT_LABEL, type MenuItem } from "../../shared/menu-loop.js";

/** 记录每次 select 的标题与选项；按脚本依次返回，队列空返回 undefined（等价 esc）。 */
function makeCtx(script: Array<string | undefined>) {
  const calls: Array<{ title: string; options: string[] }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const queue = [...script];
  const ctx = {
    ui: {
      select: async (title: string, options: string[]) => {
        calls.push({ title, options });
        const next = queue.shift();
        assert.ok(next === undefined || options.includes(next), `${next} 应在候选项中: ${JSON.stringify(options)}`);
        return next;
      },
      notify: (message: string, type?: string) => notices.push({ message, type }),
    },
  };
  return { ctx, calls, notices };
}

describe("runMenuLoop", () => {
  it("action 执行后回到菜单且 build 重算标签，退出项离开", async () => {
    let count = 0;
    const ran: string[] = [];
    const { ctx, calls } = makeCtx(["计数（0）", "计数（1）", MENU_EXIT_LABEL]);
    await runMenuLoop(ctx, {
      title: "菜单",
      build: () => [{ label: `计数（${count}）`, run: () => { count++; ran.push("hit"); } }],
    });
    assert.deepEqual(ran, ["hit", "hit"]);
    assert.equal(count, 2);
    // 第二轮标签已刷新；两轮菜单都以「退出」收尾
    assert.deepEqual(calls.map((c) => c.options), [
      ["计数（0）", MENU_EXIT_LABEL],
      ["计数（1）", MENU_EXIT_LABEL],
      ["计数（2）", MENU_EXIT_LABEL],
    ]);
  });

  it("esc（undefined）立即离开", async () => {
    const ran: string[] = [];
    const { ctx, calls } = makeCtx([undefined]);
    await runMenuLoop(ctx, {
      title: "菜单",
      build: () => [{ label: "动作", run: () => { ran.push("hit"); } }],
    });
    assert.deepEqual(ran, []);
    assert.equal(calls.length, 1);
  });

  it("action 抛错不中断循环：通知错误并回到菜单", async () => {
    const { ctx, calls, notices } = makeCtx(["炸", MENU_EXIT_LABEL]);
    await runMenuLoop(ctx, {
      title: "菜单",
      build: () => [{
        label: "炸",
        run: () => { throw new Error("boom"); },
      }],
    });
    assert.equal(calls.length, 2, "第一轮抛错后应回到菜单");
    assert.match(notices[0]!.message, /boom/);
    assert.equal(notices[0]!.type, "error");
  });

  it("菜单项按 MenuItem 定义执行", async () => {
    const items: MenuItem[] = [
      { label: "a", run: () => {} },
      { label: "b", run: () => {} },
    ];
    const { ctx } = makeCtx(["b", MENU_EXIT_LABEL]);
    await runMenuLoop(ctx, { title: "菜单", build: () => items });
  });
});
