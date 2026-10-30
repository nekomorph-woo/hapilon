/**
 * menu-loop.ts — 常驻菜单循环（对齐 pi /settings 的「改完不退出」）。
 *
 * ctx.ui.select 每次选择后 overlay 即关闭，所以这里用最朴素的循环实现常驻：
 * action 执行完 → build() 重算标签（计数/状态刷新）→ 菜单重开；
 * 选「退出」或 esc 离开。零并发对话框、零 TUI 内部依赖，print 模式同样可用。
 */

/** 菜单项：label 会展示；run 执行后回到菜单。 */
export interface MenuItem {
  label: string;
  run: () => Promise<void> | void;
}

export interface MenuLoopOptions {
  title: string;
  /** 每轮重算菜单项——标签里带计数/状态时必须现读，否则改完看不到刷新。 */
  build: () => MenuItem[] | Promise<MenuItem[]>;
}

/** 退出项文案；菜单 build 的 label 不要与之重名。 */
export const MENU_EXIT_LABEL = "退出";

type MenuUi = {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
};

/**
 * 跑一个常驻菜单直到用户退出。action 抛错不中断循环：
 * 打一行通知（若 ui 有 notify）后回到菜单，让用户能继续别的操作或退出。
 */
export async function runMenuLoop(
  ctx: { ui: MenuUi },
  opts: MenuLoopOptions,
): Promise<void> {
  while (true) {
    const items = await opts.build();
    const chosen = await ctx.ui.select(
      opts.title,
      [...items.map((item) => item.label), MENU_EXIT_LABEL],
    );
    if (chosen === undefined || chosen === MENU_EXIT_LABEL) return;
    const item = items.find((candidate) => candidate.label === chosen);
    if (!item) continue;
    try {
      await item.run();
    } catch (error) {
      ctx.ui.notify?.(`操作失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}
