import { Browser, BrowserContext, Page, expect } from '@playwright/test';

/** 1x1 红点 PNG，最小合法 PNG，供“正常图片”用。 */
export const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const GREEN_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 一个声称自己是 PNG 但无法解码的文件：用于“单张解码失败只标记该项”。 */
export const GARBAGE_PNG_BYTES = Buffer.from('this is definitely not a png', 'utf8');

export interface AddedImage {
  name: string;
  buffer: Buffer;
  mime: string;
}

export function pngImage(name: string, dataBase64 = RED_DOT_PNG): AddedImage {
  return { name, buffer: Buffer.from(dataBase64, 'base64'), mime: 'image/png' };
}

export function garbagePng(name: string): AddedImage {
  return { name, buffer: GARBAGE_PNG_BYTES, mime: 'image/png' };
}

/** 通过隐藏 input 选择文件，等待节目单行渲染。 */
export async function addImages(consolePage: Page, images: AddedImage[]) {
  const dataTransfers = images.map((img) => ({
    name: img.name,
    mimeType: img.mime,
    buffer: img.buffer
  }));
  await consolePage.locator('input[type=file]').first().setInputFiles(dataTransfers);
  // 缩略图（或失败标记）出现即说明该项落库完成
  await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(
    images.length
  );
}

/** 打开控制台并确认就绪。 */
export async function openConsole(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/console');
  await expect(page.getByTestId('start-show')).toBeVisible();
  return { context, page };
}

/**
 * 开始放映并接住观众窗弹窗。
 * 页面基址由 playwright.config 的 baseURL 决定。
 */
export async function startShowWithPopup(
  context: BrowserContext,
  consolePage: Page
): Promise<Page> {
  const popupPromise = context.waitForEvent('page');
  await consolePage.getByTestId('start-show').click();
  const viewer = await popupPromise;
  await viewer.waitForLoadState('load');
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
  return viewer;
}

/** 读取观众窗 HUD 文本（如“第 2 / 3 页”或“遮黑”）；恢复期间无 HUD 时返回空串。 */
export async function hudText(viewer: Page): Promise<string> {
  const hud = viewer.getByTestId('viewer-hud');
  if ((await hud.count()) === 0) return '';
  return (await hud.innerText()).replace(/\s+/g, ' ').trim();
}
