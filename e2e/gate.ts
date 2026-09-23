import { BrowserContext, Page } from '@playwright/test';

/**
 * 安装“可控提交闸门”：观众窗 ViewerRuntime 的
 *  - 每次取图（含缓存命中）进入 decodeGate（按页排队）；
 *  - 每次真正上屏 drawImage 前进入 paintGate（按页排队）。
 * 测试用 releaseOne/releaseAll 决定完成顺序，从而反向构造
 *  - “旧快照绘制晚于新命令”（解码先都完成、上屏顺序反转）；
 *  - “窗口缩放的旧帧重绘晚于遮黑”；
 *  - “失败回退绘制晚于同序号替代命令”。
 *
 * 必须在观众窗脚本执行前注入（addInitScript）。未安装/未启用时 ViewerRuntime
 * 完全按正常路径运行，对生产代码无行为影响。
 */
type GateState = {
  enabled: boolean;
  enter(page: number): Promise<void>;
  releaseOne(matchPage?: number): boolean;
  releaseAll(matchPage?: number): number;
  pendingCount(matchPage?: number): number;
};

type InstalledGate = {
  decodeGate: GateState;
  paintGate: GateState;
};

function gateScript() {
  type Waiter = { page: number; release: () => void };
  const STORAGE_KEY = '__domeDecodeGateEnabled';

  function makeGate(): GateState {
    const waiters: Waiter[] = [];
    return {
      get enabled(): boolean {
        try {
          return sessionStorage.getItem(STORAGE_KEY) === '1';
        } catch {
          return false;
        }
      },
      set enabled(v: boolean) {
        try {
          if (v) sessionStorage.setItem(STORAGE_KEY, '1');
          else sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      },
      enter(page: number): Promise<void> {
        return new Promise<void>((resolve) => {
          waiters.push({ page, release: resolve });
        });
      },
      releaseOne(matchPage?: number): boolean {
        const idx = waiters.findIndex((w) => matchPage === undefined || w.page === matchPage);
        if (idx < 0) return false;
        const [w] = waiters.splice(idx, 1);
        w.release();
        return true;
      },
      releaseAll(matchPage?: number): number {
        const ready = waiters.filter((w) => matchPage === undefined || w.page === matchPage);
        [...ready].forEach((w) => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
        });
        ready.forEach((w) => w.release());
        return ready.length;
      },
      pendingCount(matchPage?: number): number {
        return waiters.filter((w) => matchPage === undefined || w.page === matchPage).length;
      }
    };
  }

  const installed: InstalledGate = { decodeGate: makeGate(), paintGate: makeGate() };
  (window as unknown as { __domeDecodeGate?: InstalledGate }).__domeDecodeGate = installed;
}

export function installDecodeGate(context: BrowserContext): void {
  // addInitScript 的回调在页面环境中执行；这里靠 toString 注入同一份实现。
  void context.addInitScript(`(${gateScript.toString()})();`);
}

export type GateKind = 'decode' | 'paint';

function gateRef(viewer: Page, kind: GateKind): string {
  return kind === 'decode' ? 'decodeGate' : 'paintGate';
}

export async function gateOn(viewer: Page): Promise<void> {
  await viewer.evaluate(() => {
    const g = (window as unknown as { __domeDecodeGate?: InstalledGate }).__domeDecodeGate;
    if (g) g.decodeGate.enabled = true;
  });
}

export async function releaseOne(
  viewer: Page,
  kind: GateKind,
  page?: number
): Promise<boolean> {
  return viewer.evaluate(
    ({ ref, p }) => {
      const g = (window as unknown as { __domeDecodeGate?: InstalledGate }).__domeDecodeGate!;
      return g[ref].releaseOne(p);
    },
    { ref: gateRef(viewer, kind), p: page }
  );
}

export async function releaseAll(
  viewer: Page,
  kind: GateKind,
  page?: number
): Promise<number> {
  return viewer.evaluate(
    ({ ref, p }) => {
      const g = (window as unknown as { __domeDecodeGate?: InstalledGate }).__domeDecodeGate!;
      return g[ref].releaseAll(p);
    },
    { ref: gateRef(viewer, kind), p: page }
  );
}

export async function pendingCount(
  viewer: Page,
  kind: GateKind,
  page?: number
): Promise<number> {
  return viewer.evaluate(
    ({ ref, p }) => {
      const g = (window as unknown as { __domeDecodeGate?: InstalledGate }).__domeDecodeGate!;
      return g[ref].pendingCount(p);
    },
    { ref: gateRef(viewer, kind), p: page }
  );
}

export async function waitForPending(
  viewer: Page,
  kind: GateKind,
  count: number,
  page?: number,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await pendingCount(viewer, kind, page);
    if (n >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`等待 ${kind} 门 ${count} 个排队(页${page ?? '*'})超时，实际 ${n}`);
    }
    await viewer.waitForTimeout(20);
  }
}

export type PixelKind = 'red' | 'green' | 'black' | 'other';

/** 采样穹顶画布中心像素，区分红/绿/黑/其它。 */
export async function canvasPixel(viewer: Page): Promise<PixelKind> {
  return viewer.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid=dome-canvas]'
    ) as HTMLCanvasElement;
    const c = canvas.getContext('2d')!;
    const d = c.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1
    ).data;
    const [r, g, b] = [d[0], d[1], d[2]];
    const dark = r < 24 && g < 24 && b < 24;
    const red = r > 90 && g < 60 && b < 60;
    const green = g > 90 && r < 60 && b < 60;
    if (dark) return 'black' as const;
    if (red) return 'red' as const;
    if (green) return 'green' as const;
    return 'other' as const;
  });
}
