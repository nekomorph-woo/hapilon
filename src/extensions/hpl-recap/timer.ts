export type TimerHandle = ReturnType<typeof setTimeout>;

export interface RecapTimer {
  reset(delayMs: number): void;
  clear(): void;
}

/** 可注入 scheduler 的 session 级 timer，reset 必定取消上一轮。 */
export function createRecapTimer(
  onElapsed: () => void,
  schedule: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
  cancel: (handle: TimerHandle) => void = clearTimeout,
): RecapTimer {
  let handle: TimerHandle | undefined;
  const clear = (): void => {
    if (handle !== undefined) cancel(handle);
    handle = undefined;
  };
  return {
    reset(delayMs) {
      clear();
      handle = schedule(onElapsed, delayMs);
    },
    clear,
  };
}
