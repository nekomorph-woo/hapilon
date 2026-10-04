/**
 * list-picker.ts — 可搜索的列表选择器（ctx.ui.custom 实现）。
 *
 * pi 的 ctx.ui.select 是全量渲染的纯列表：接入几百个模型（如 pi-cursor-sdk）时，
 * 挂在列表末尾的「完成」在屏幕外翻不到（issue #66）。此组件对齐 pi 原生 /model
 * 选择器（ModelSelectorComponent）的交互：搜索框实时 fuzzyFilter、可视窗口滚动、
 * 「完成/取消」固定在列表上方不参与过滤。
 *
 * 无 TUI（print 模式等）回落 ctx.ui.select，并把完成项固定在列表顶部。
 */
import {
  Container,
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  getKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";

/** pickFromList 的返回约定：null=完成，undefined=取消，string=选中的模型。 */
export type ListPick = string | null | undefined;

interface ListPickerOptions {
  /** 传入时在列表首行渲染固定的完成项；单选场景不传。 */
  doneLabel?: string;
}

export class ListPickerComponent extends Container {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: { action: "select"; value: string } | { action: "done" } | { action: "cancel" }) => void;
  private readonly title: string;
  private readonly options: string[];
  private readonly doneLabel?: string;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private filtered: string[] = [];
  /** 0 = 完成项（若有），1..n = filtered 的行号 */
  private row = 0;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (result: { action: "select"; value: string } | { action: "done" } | { action: "cancel" }) => void,
    title: string,
    options: string[],
    opts?: ListPickerOptions,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.title = title;
    this.options = options;
    this.doneLabel = opts?.doneLabel;
    this.filtered = options;

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "  输入过滤 · ↑↓ 导航 · enter 选择 · esc 取消"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.redraw();
  }

  /** 供 TUI 焦点/IME 传导（与 pi 原生 ModelSelectorComponent 同款）。 */
  get focused(): boolean {
    return this.searchInput.focused;
  }

  set focused(value: boolean) {
    this.searchInput.focused = value;
  }

  private get rowCount(): number {
    return (this.doneLabel ? 1 : 0) + this.filtered.length;
  }

  private filter(query: string): void {
    this.filtered = fuzzyFilter(this.options, query, (item) => item);
    this.row = 0;
    this.redraw();
  }

  private redraw(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.row - Math.floor(maxVisible / 2), this.rowCount - maxVisible));
    const end = Math.min(start + maxVisible, this.rowCount);

    const drawRow = (line: number, text: string, selected: boolean) => {
      if (line < start || line >= end) return;
      const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
      this.listContainer.addChild(new Text(cursor + (selected ? this.theme.fg("accent", text) : this.theme.fg("text", text)), 1, 0));
    };

    let row = 0;
    if (this.doneLabel) {
      drawRow(row, `✓ ${this.doneLabel}`, this.row === row);
      row++;
    }
    for (const item of this.filtered) {
      drawRow(row, item, this.row === row);
      row++;
    }

    if (start > 0 || end < this.rowCount) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.row + 1}/${this.rowCount})`), 1, 0));
    }
    if (this.filtered.length === 0 && !this.doneLabel) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  无匹配模型"), 1, 0));
    }
  }

  private close(result: { action: "select"; value: string } | { action: "done" } | { action: "cancel" }): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  handleInput(keyData: string): void {
    if (this.closed) return;
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.close({ action: "cancel" });
    } else if (kb.matches(keyData, "tui.select.up")) {
      this.row = this.row === 0 ? this.rowCount - 1 : this.row - 1;
      this.redraw();
      this.tui.requestRender();
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.row = this.row === this.rowCount - 1 ? 0 : this.row + 1;
      this.redraw();
      this.tui.requestRender();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      if (this.doneLabel && this.row === 0) {
        this.close({ action: "done" });
      } else {
        const value = this.filtered[this.row - (this.doneLabel ? 1 : 0)];
        if (value !== undefined) this.close({ action: "select", value });
      }
    } else {
      this.searchInput.handleInput(keyData);
      this.filter(this.searchInput.getValue());
      this.tui.requestRender();
    }
  }
}

/**
 * 可搜索的列表选择：从 options 里挑一项。
 *
 * - doneLabel 传入（如 "完成"、"取消"）时首行固定该项，返回 null 表示选择结束；
 *   不传则只做单选，永不返回 null。
 * - 取消（esc / 无 UI）返回 undefined。
 * - TUI 不可用（print 模式）回落 ctx.ui.select，完成项同样固定在顶部。
 */
export async function pickFromList(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined>;
export async function pickFromList(ctx: ExtensionCommandContext, title: string, options: string[], doneLabel: string): Promise<ListPick>;
export async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
  doneLabel?: string,
): Promise<ListPick> {
  if (options.length === 0) return undefined;
  try {
    const result = await ctx.ui.custom<ListPickResult>(
      (tui, theme, _keybindings, done) => new ListPickerComponent(tui, theme, done, title, options, { doneLabel }),
    );
    if (!result || result.action === "cancel") return undefined;
    if (result.action === "done") return null;
    return result.value;
  } catch {
    // 无 TUI（print 模式）：ctx.ui.custom 不可用，回落纯列表，完成项固定在顶部
    const selected = await ctx.ui.select(title, doneLabel ? [doneLabel, ...options] : [...options]);
    if (selected === undefined) return undefined;
    if (doneLabel && selected === doneLabel) return null;
    return selected;
  }
}

type ListPickResult = { action: "select"; value: string } | { action: "done" } | { action: "cancel" };
