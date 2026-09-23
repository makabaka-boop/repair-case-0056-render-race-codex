import { chromium, expect, type Page, test } from '@playwright/test';
import {
  addImages,
  garbagePng,
  GREEN_DOT_PNG,
  hudText,
  openConsole,
  pngImage,
  RED_DOT_PNG,
  startShowWithPopup
} from './helpers';
import {
  canvasPixel,
  gateOn,
  installDecodeGate,
  releaseAll,
  releaseOne,
  waitForPending
} from './gate';

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  test.setTimeout(60_000);
});

/** 放行某页一次“解码 -> 上屏”的完整受控取图（顺序敏感处请直接用底层门控）。 */
async function settleImage(viewer: Page, page: number): Promise<void> {
  await waitForPending(viewer, 'decode', 1, page);
  await releaseOne(viewer, 'decode', page);
  await waitForPending(viewer, 'paint', 1, page);
  await releaseOne(viewer, 'paint', page);
}

async function enableGate(viewer: Page): Promise<void> {
  await gateOn(viewer);
}

async function flushGates(viewer: Page): Promise<void> {
  // 多轮放行直到两队稳定为空（解码放行后才可能产生上屏排队；
  // 刷新后取图入队也需要一点时间）。
  let idle = 0;
  for (let i = 0; i < 30 && idle < 2; i++) {
    const d = await releaseAll(viewer, 'decode');
    const p = await releaseAll(viewer, 'paint');
    if (d === 0 && p === 0) idle += 1;
    else idle = 0;
    await viewer.waitForTimeout(15);
  }
}

/**
 * 异步竞态验收：以可控提交顺序逐项复现
 *  1) 恢复快照（旧页）晚于后续切页完成（解码都完成，仅上屏顺序反转）；
 *  2) 窗口缩放的旧帧重绘晚于遮黑；
 *  3) 停映后迟到的旧帧绘制；
 *  4) 坏图失败回退（异步重绘最后成功页）晚于同序号替代命令；
 *  5) 两个观众窗同序号回传不同画面，控制台只让匹配目标的确认推进权威；
 *  6) 同序号确认遮黑状态不符不解除遮黑。
 * 每项均核对：穹顶像素、HUD/控制台状态、持久化、刷新恢复。
 */
test.describe('异步提交竞态：任一时刻只有当前有效画面能提交', () => {
  test('恢复快照旧页比新命令更晚完成：旧快照不得上屏覆盖已确认新页', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [
      pngImage('p1-red.png', RED_DOT_PNG),
      pngImage('p2-green.png', GREEN_DOT_PNG),
      pngImage('p3-green.png', GREEN_DOT_PNG)
    ]);
    const viewer = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 3 页');
    await enableGate(viewer);

    // 确认到第 2 页（绿）
    await consolePage.getByTestId('next').click();
    await settleImage(viewer, 1);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');

    // 第 3 页命令（seq=2）发出后立即刷新观众窗：必须赶在控制台 ACK 超时
    // （pending -> unconfirmed）之前，使快照仍携带 status='pending' 的未决命令。
    await consolePage.getByTestId('next').click();
    await viewer.reload();
    await viewer.waitForSelector('[data-testid=viewer-hud]', { timeout: 10_000 });

    // 恢复快照：confirmed=第2页（旧）；pending seq=2=第3页（新），两路取图都排队
    await waitForPending(viewer, 'decode', 1, 1); // 旧快照 confirmed 帧
    await waitForPending(viewer, 'decode', 1, 2); // 快照承接的未决新命令
    await releaseOne(viewer, 'decode', 2);
    await releaseOne(viewer, 'decode', 1);
    // 解码均完成，上屏顺序反转：新命令（第3页）先上屏
    await waitForPending(viewer, 'paint', 1, 2);
    await waitForPending(viewer, 'paint', 1, 1);
    await releaseOne(viewer, 'paint', 2);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 旧快照帧（第2页）此刻才上屏：必须被提交代闸门丢弃
    await releaseOne(viewer, 'paint', 1);
    await viewer.waitForTimeout(150);
    expect(await hudText(viewer)).toContain('第 3 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 刷新恢复：像素/状态/持久化仍是第 3 页
    await flushGates(viewer);
    await viewer.reload();
    await flushGates(viewer);
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 3 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('遮黑后窗口缩放的旧帧重绘晚完成：穹顶保持黑屏，状态仍是遮黑', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [
      pngImage('p1-red.png', RED_DOT_PNG),
      pngImage('p2-green.png', GREEN_DOT_PNG)
    ]);
    const viewer = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 2 页');
    await enableGate(viewer);

    await consolePage.getByTestId('next').click();
    await settleImage(viewer, 1);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    expect(await canvasPixel(viewer)).toBe('green');

    // 触发一次缩放重绘（旧帧第2页取图在途），随后立即遮黑
    await viewer.setViewportSize({ width: 900, height: 700 });
    await waitForPending(viewer, 'decode', 1, 1);
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');
    expect(await canvasPixel(viewer)).toBe('black');

    // 迟到的旧帧重绘走完解码/上屏：不得把图片重新画出
    await flushGates(viewer);
    await viewer.waitForTimeout(150);
    expect(await canvasPixel(viewer)).toBe('black');
    expect(await hudText(viewer)).toContain('遮黑');

    // 再缩放一次也必须重绘黑而不是图
    await viewer.setViewportSize({ width: 800, height: 600 });
    await viewer.waitForTimeout(200);
    expect(await canvasPixel(viewer)).toBe('black');

    // 解除遮黑后第 2 页正常恢复；刷新后一致
    await consolePage.getByTestId('blackout').click();
    await flushGates(viewer);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    expect(await canvasPixel(viewer)).toBe('green');

    await viewer.reload();
    await flushGates(viewer);
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 2 / 2 页');
    expect(await canvasPixel(viewer)).toBe('green');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('停映后迟到的旧帧解码/重绘：持续黑屏，迟到结果不复活画面', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [
      pngImage('p1-red.png', RED_DOT_PNG),
      pngImage('p2-green.png', GREEN_DOT_PNG)
    ]);
    const viewer = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 2 页');
    await enableGate(viewer);

    await consolePage.getByTestId('next').click();
    await waitForPending(viewer, 'decode', 1, 1); // 第2页解码在途
    await consolePage.getByTestId('end-show').click();
    await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 5000 });
    expect(await canvasPixel(viewer)).toBe('black');

    // 迟到解码/上屏全部作废；resize 也不能把图画回来
    await flushGates(viewer);
    await viewer.setViewportSize({ width: 700, height: 500 });
    await viewer.waitForTimeout(150);
    expect(await canvasPixel(viewer)).toBe('black');
    await expect(viewer.getByTestId('viewer-ended')).toBeVisible();

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('坏图失败的异步回退晚于同序号替代命令：新页不被最后成功帧覆盖', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [
      pngImage('good-red.png', RED_DOT_PNG),
      garbagePng('bad-garbage.png'),
      pngImage('good-green.png', GREEN_DOT_PNG)
    ]);
    const viewer = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 3 页');
    await expect.poll(() => canvasPixel(viewer), { timeout: 5000 }).toBe('red');
    await enableGate(viewer);

    // 第 2 页坏图：放行其解码后回 IMAGE_FAILED，随后要异步回绘最后成功页（第1页/红）
    await consolePage.getByTestId('next').click();
    await waitForPending(viewer, 'decode', 1, 1);
    await releaseOne(viewer, 'decode', 1);
    await expect(consolePage.getByTestId('status-failed')).toBeVisible({ timeout: 5000 });
    // 回退绘制（第1页/红）排队，卡住不放
    await waitForPending(viewer, 'decode', 1, 0);

    // 同序号替代命令（跳到第3页，seq 仍为 1）先完成
    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await waitForPending(viewer, 'decode', 1, 2);
    await releaseOne(viewer, 'decode', 2);
    await waitForPending(viewer, 'paint', 1, 2);
    await releaseOne(viewer, 'paint', 2);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 旧失败的回退绘制（红）晚到：不得覆盖新页
    await flushGates(viewer);
    await viewer.waitForTimeout(150);
    expect(await canvasPixel(viewer)).toBe('green');
    expect(await hudText(viewer)).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 刷新恢复：像素与状态仍是第 3 页
    await viewer.reload();
    await flushGates(viewer);
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 3 / 3 页');
    expect(await canvasPixel(viewer)).toBe('green');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('两个观众窗同序号不同画面：不匹配目标的确认不推进权威', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [
      pngImage('p1-red.png', RED_DOT_PNG),
      pngImage('p2-green.png', GREEN_DOT_PNG)
    ]);
    const viewerA = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewerA), { timeout: 5000 }).toContain('第 1 / 2 页');
    const viewerB = await context.newPage();
    await viewerB.goto('/viewer');
    await expect(viewerB.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewerB)).toContain('第 1 / 2 页');

    const sessionId = (await consolePage.getByTestId('session-id').innerText()).trim();
    await enableGate(viewerA);
    await enableGate(viewerB);

    await consolePage.getByTestId('next').click();
    await waitForPending(viewerA, 'decode', 1, 1);
    await waitForPending(viewerB, 'decode', 1, 1);

    // B 抢先回传“同 seq=1 但画面仍是旧页 0”的确认（多窗交错）
    await viewerB.evaluate(
      (sid) => {
        const ch = new BroadcastChannel('dome-presenter-v1');
        ch.postMessage({
          kind: 'ACK',
          sessionId: sid,
          seq: 1,
          viewerId: 'viewer-stale-B',
          ok: true,
          page: 0,
          blackout: false
        });
        ch.close();
      },
      sessionId
    );
    await viewerB.waitForTimeout(300);
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect(consolePage.getByTestId('presented-1')).toHaveCount(0);

    // 真正呈现目标的 A 完成：权威才前进
    await releaseOne(viewerA, 'decode', 1);
    await waitForPending(viewerA, 'paint', 1, 1);
    await releaseOne(viewerA, 'paint', 1);
    await expect.poll(() => hudText(viewerA), { timeout: 5000 }).toContain('第 2 / 2 页');
    expect(await canvasPixel(viewerA)).toBe('green');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    // B 自身完成后也确认（目标一致，幂等）
    await releaseOne(viewerB, 'decode', 1);
    await waitForPending(viewerB, 'paint', 1, 1);
    await releaseOne(viewerB, 'paint', 1);
    await expect.poll(() => hudText(viewerB), { timeout: 5000 }).toContain('第 2 / 2 页');
    expect(await canvasPixel(viewerB)).toBe('green');

    // 控制台刷新：持久化权威仍是第 2 页
    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();

    // 两窗刷新恢复：像素与状态一致
    for (const v of [viewerA, viewerB]) {
      await v.reload();
      await flushGates(v);
      await expect(v.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => hudText(v), { timeout: 10_000 }).toContain('第 2 / 2 页');
      expect(await canvasPixel(v)).toBe('green');
    }

    await viewerA.close();
    await viewerB.close();
    await context.close();
    await browser.close();
  });

  test('同序号确认遮黑状态不符：控制台不解除遮黑，匹配目标的确认才收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    installDecodeGate(context);
    await addImages(consolePage, [pngImage('p1-red.png', RED_DOT_PNG)]);
    const viewer = await startShowWithPopup(context, consolePage);
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 1 页');
    const sessionId = (await consolePage.getByTestId('session-id').innerText()).trim();

    // 在观众窗拦截真实 ACK（先扣住），以便控制台停留在“待确认”时插入错位确认
    await viewer.evaluate(() => {
      const proto = BroadcastChannel.prototype as unknown as {
        postMessage: (m: unknown) => void;
        __origPost?: (m: unknown) => void;
      };
      if (!proto.__origPost) proto.__origPost = proto.postMessage;
      const held: { ch: BroadcastChannel; msg: unknown }[] = [];
      const w = window as unknown as {
        __holdAck: boolean;
        __heldAcks: typeof held;
        __releaseHeldAcks: () => void;
        __origAckPost: (ch: BroadcastChannel, m: unknown) => void;
      };
      w.__holdAck = true;
      w.__heldAcks = held;
      w.__origAckPost = (ch, m) => proto.__origPost!.call(ch, m);
      w.__releaseHeldAcks = () => {
        w.__holdAck = false;
        held.forEach(({ ch, msg }) => proto.__origPost!.call(ch, msg));
        held.length = 0;
      };
      proto.postMessage = function (this: BroadcastChannel, m: unknown) {
        if (w.__holdAck && (m as { kind?: string })?.kind === 'ACK') {
          const ch = this;
          held.push({ ch, msg: m });
          return;
        }
        return proto.__origPost!.call(this, m);
      };
    });

    await consolePage.getByTestId('blackout').click();
    await expect(consolePage.getByTestId('status-pending')).toBeVisible({ timeout: 3000 });

    // 穹顶实际已遮黑（绘制不依赖 ACK），但真实 ACK 被扣住，控制台仍待确认
    expect(await canvasPixel(viewer)).toBe('black');

    // 交错确认：同序号却声称未遮黑——必须丢弃（用原始发送绕开拦截器）
    await viewer.evaluate((sid) => {
      const w = window as unknown as {
        __origAckPost: (ch: BroadcastChannel, m: unknown) => void;
      };
      const ch = new BroadcastChannel('dome-presenter-v1');
      w.__origAckPost(ch, {
        kind: 'ACK',
        sessionId: sid,
        seq: 1,
        viewerId: 'viewer-stale-blackout',
        ok: true,
        page: 0,
        blackout: false
      });
      ch.close();
    }, sessionId);
    await viewer.waitForTimeout(250);
    await expect(consolePage.getByTestId('status-pending')).toBeVisible();
    await expect(consolePage.locator('.badge-dark')).toHaveCount(0);
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 放行真实（匹配遮黑目标的）确认后才收敛
    await viewer.evaluate(() => {
      (window as unknown as { __releaseHeldAcks: () => void }).__releaseHeldAcks();
    });
    await expect(consolePage.locator('.badge-dark')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
