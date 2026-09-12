/**
 * snapshot.ts — 结构化限额快照（quota-cache 文件通道的数据模型）
 *
 * footer / 浮层共享：providers 原始解析各出一份 snapshot，
 * 落 JSON 文件供其它扩展读取（pi loader 模块隔离，不能走模块状态）。
 */

export interface QuotaWindowSnapshot {
  /** 窗口标签：5h / mo / wk（footer 显示 "18%/5h"） */
  window: string;
  /** 已用百分比（API 原义） */
  percent: number;
  /** 重置时刻 epoch ms（比秒数好——读取端无需知道缓存写入时刻） */
  resetAt: number | undefined;
}

export interface QuotaSnapshot {
  provider: string;
  /** 余额型显示（deepseek 人民币），有才带 */
  balanceCny?: string;
  windows: QuotaWindowSnapshot[];
  /** 缓存写入时刻 epoch ms */
  timestamp: number;
}

export function snapshotHot(snapshot: QuotaSnapshot): boolean {
  return snapshot.windows.some((w) => w.percent >= 90);
}

/** footer 紧凑双窗口段："18%/5h~2h 76%/mo~9d" / "¥327" */
export function formatFooterSegment(snapshot: QuotaSnapshot, now: number): string {
  if (snapshot.balanceCny !== undefined) {
    return `¥${snapshot.balanceCny}`;
  }
  return snapshot.windows
    .map((w) => {
      const base = `${Math.round(w.percent)}%/${w.window}`;
      if (w.resetAt === undefined) return base;
      const remainingMs = w.resetAt - now;
      if (remainingMs <= 0) return base;
      const minutes = Math.floor(remainingMs / 60000);
      const count = minutes < 60
        ? `${minutes}m`
        : minutes < 60 * 48
          ? `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`
          : `${Math.floor(minutes / 1440)}d`;
      return `${base}~${count}`;
    })
    .join(" ");
}
