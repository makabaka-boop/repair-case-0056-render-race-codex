/**
 * 观众窗运行时：协议状态机 + BroadcastChannel + IndexedDB 取图 + Canvas 呈现。
 * 画面只允许从两个来源产生：
 *   1. 恢复完成时控制台快照里的 confirmed；
 *   2. live 期间被接受（严格相邻序号）的命令。
 */
import { MessageBus } from '../bus';
import { getBlob, loadFrozen } from '../db';
import { decodeBlob, drawCover } from '../image';
import {
  CommandMessage,
  SnapshotResponse,
  WireMessage
} from '../protocol/types';
import {
  ViewerState,
  applySnapshot,
  beginRecovery,
  initViewer,
  receiveCommand,
  receiveWire,
  resolveRender
} from '../protocol/viewer';

function makeViewerId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `viewer_${rand}`;
}

export type PresentStatus =
  | { phase: 'standby' }
  | { phase: 'recovering' }
  | { phase: 'live'; page: number; total: number; blackout: boolean; seq: number; imageError: boolean }
  | { phase: 'ended' };

export class ViewerRuntime {
  private bus: MessageBus;
  private state: ViewerState;
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<number, HTMLImageElement>();
  private blobIdByPage: string[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private total = 0;
  /** 当前呈现失败标记（imageError），用于 UI 提示，画面仍停留在最后成功页。 */
  private imageError = false;

  constructor(canvas: HTMLCanvasElement, bus?: MessageBus) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.bus = bus ?? new MessageBus();
    this.state = initViewer(makeViewerId());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  getStatus(): PresentStatus {
    switch (this.state.phase) {
      case 'standby':
        return { phase: 'standby' };
      case 'recovering':
        return { phase: 'recovering' };
      case 'ended':
        return { phase: 'ended' };
      case 'live':
        return {
          phase: 'live',
          page: this.state.frame?.page ?? 0,
          total: this.total,
          blackout: this.state.frame?.blackout ?? false,
          seq: this.state.frame?.seq ?? 0,
          imageError: this.imageError
        };
    }
  }

  start() {
    // React StrictMode 开发双挂载：dispose 关闭了总线，第二次挂载需重建。
    if (this.bus.closed) this.bus = new MessageBus();
    this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.state = beginRecovery(this.state);
    this.emit();
    this.requestSnapshot();
    // 重开后主动取得快照；控制台缺席时持续轮询，直到拿到运行中会话的快照。
    this.poll = setInterval(() => {
      if (this.state.phase === 'recovering' || this.state.phase === 'standby') {
        this.requestSnapshot();
      }
    }, 1000);
    window.addEventListener('resize', () => this.paintCurrent());
  }

  dispose() {
    this.unsubscribe?.();
    if (this.poll) clearInterval(this.poll);
    this.bus.close();
  }

  private requestSnapshot() {
    this.bus.post({ kind: 'SNAPSHOT_REQ', viewerId: this.state.viewerId });
  }

  private onMessage(msg: WireMessage) {
    switch (msg.kind) {
      case 'SNAPSHOT_RES':
        void this.handleSnapshot(msg);
        break;
      case 'CMD':
        void this.handleCommand(msg);
        break;
      case 'SESSION_ENDED': {
        const prev = this.state.phase;
        this.state = receiveWire(this.state, msg);
        if (prev !== this.state.phase) {
          this.cache.clear();
          this.blobIdByPage = [];
          this.paintEnded();
          this.emit();
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleSnapshot(res: SnapshotResponse) {
    if (res.viewerId !== this.state.viewerId) return;
    if (this.state.phase !== 'recovering') return;
    if (!res.running) return; // 保持待命，继续轮询

    // 节目单顺序在冻结时已随会话写入 IndexedDB；消息通道只传权威画面。
    const program =
      (await loadFrozen(res.sessionId).catch(() => null)) ??
      (await loadFrozen('latest').catch(() => null));
    const ids = program?.items.map((i) => i.blobId) ?? [];
    if (ids.length === 0) {
      // 本地存储缺失（如用户清了站点数据）：无法恢复，继续保持恢复态并重试。
      return;
    }
    this.total = ids.length;
    this.blobIdByPage = ids;
    this.state = applySnapshot(this.state, res);
    this.imageError = false;
    await this.paintCurrent();
    this.emit();
  }

  private async handleCommand(msg: CommandMessage) {
    // 恢复期间旧命令、其它会话消息在状态机内统一无效；这里再加一道保险。
    if (this.state.phase === 'recovering') return;
    const accept = receiveCommand(this.state, msg);
    this.state = accept.state;
    if (accept.resendAck) {
      // 重复命令：画面不动，只重放 ACK（控制台超时重试的常见收敛路径）。
      this.bus.post(accept.resendAck);
      return;
    }
    if (!accept.render) return;
    await this.present(accept.render.seq, accept.render.page, accept.render.blackout);
  }

  /** 呈现一帧：取 Blob -> 解码 -> 绘制；失败回传 IMAGE_FAILED，最后成功页不变。 */
  private async present(seq: number, page: number, blackout: boolean) {
    try {
      if (blackout) {
        this.paintBlack();
      } else {
        const img = await this.loadImage(page);
        this.drawImage(img);
      }
      const { state, ack } = resolveRender(this.state, { seq, page, blackout }, true);
      this.state = state;
      this.imageError = false;
      this.bus.post(ack);
      this.emit();
    } catch (err) {
      console.error('present failed', err);
      // 回退画面：重绘最后成功帧（可能本身是遮黑）。
      this.paintCurrent();
      const { state, ack } = resolveRender(this.state, { seq, page, blackout }, false);
      this.state = state;
      this.imageError = true;
      this.bus.post(ack);
      this.emit();
    }
  }

  private async loadImage(page: number): Promise<HTMLImageElement> {
    const cached = this.cache.get(page);
    if (cached) return cached;
    const blobId = this.blobIdByPage[page];
    if (!blobId) throw new Error('blob missing for page');
    const blob = await getBlob(blobId);
    if (!blob) throw new Error('blob not found in IndexedDB');
    const img = await decodeBlob(blob);
    this.cache.set(page, img);
    return img;
  }

  private paintCurrent() {
    if (this.state.phase !== 'live' || !this.state.frame) return;
    if (this.state.frame.blackout) this.paintBlack();
    else {
      const page = this.state.frame.page;
      this.loadImage(page)
        .then((img) => this.drawImage(img))
        .catch(() => this.paintBlack());
    }
  }

  private paintBlack() {
    const { width, height } = this.canvasSize();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
  }

  private paintEnded() {
    this.paintBlack();
  }

  private drawImage(img: HTMLImageElement) {
    const { width, height } = this.canvasSize();
    drawCover(this.ctx, img, width, height);
  }

  private canvasSize() {
    const canvas = this.ctx.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.floor(width * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height };
  }
}
