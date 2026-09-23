/**
 * 观众窗运行时：协议状态机 + BroadcastChannel + IndexedDB 取图 + Canvas 呈现。
 * 画面只允许从两个来源产生：
 *   1. 恢复完成时控制台快照里的 confirmed；
 *   2. live 期间被接受（严格相邻序号）的命令。
 *
 * 提交代（renderGen）：每当“允许提交的画面”发生切换——应用快照、接受命令、
 * 停映——代次 +1，并记录当前允许提交的帧（activeTarget）。一切异步结果
 * （快照取图、命令解码、失败回退、窗口缩放重绘）回灌画布前都必须通过
 * canCommit：仍为 live、代次未变、且回灌帧正是当前目标帧。
 * 因此旧快照晚完成、旧缩放重绘、旧失败回退、停映前迟到的解码都不可能再
 * 改动画布，也不会再产生 ACK 或失败标记——任一时刻只有当前有效画面能提交。
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

/** 一帧的完整身份：序号 + 页 + 遮黑，任一不同即为不同画面。 */
interface FrameRef {
  seq: number;
  page: number;
  blackout: boolean;
}

function sameFrame(a: FrameRef | null, b: FrameRef): boolean {
  return (
    !!a && a.seq === b.seq && a.page === b.page && a.blackout === b.blackout
  );
}

/**
 * 测试专用：可控提交闸门（仅当 E2E 通过 initScript 安装时存在）。
 * - decodeGate：每个取图请求（含缓存命中）入队；
 * - paintGate：每次真正 drawImage 上屏前入队。
 * 测试按页显式放行，从而精确构造“快照晚于新命令”“缩放晚于遮黑”
 * “失败回退晚于替代命令”等完成顺序（含解码都完成、仅上屏顺序反转）。
 */
export interface DomeGateChannel {
  enabled: boolean;
  enter(page: number): Promise<void>;
  releaseOne(matchPage?: number): boolean;
  releaseAll(matchPage?: number): number;
  pendingCount(matchPage?: number): number;
}
export interface DomeDecodeGate {
  decodeGate: DomeGateChannel;
  paintGate: DomeGateChannel;
}

declare global {
  interface Window {
    __domeDecodeGate?: DomeDecodeGate;
  }
}

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
  /** 提交代：画面来源每切换一次 +1，过期异步结果一律丢弃。 */
  private renderGen = 0;
  /** 当前代次允许提交的帧；null 表示无有效画面（恢复中/待命/停映）。 */
  private activeTarget: FrameRef | null = null;
  private readonly onResize = () => {
    // 缩放只重绘“当前”帧：代次/目标校验在 repaintFrame 内完成，
    // 遮黑后或停映后迟到的 resize 不会再把旧图片画出来。
    void this.repaintFrame(this.renderGen);
  };

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
    // 新恢复周期使任何旧异步结果立即过期。
    this.renderGen += 1;
    this.activeTarget = null;
    this.emit();
    this.requestSnapshot();
    // 重开后主动取得快照；控制台缺席时持续轮询，直到拿到运行中会话的快照。
    this.poll = setInterval(() => {
      if (this.state.phase === 'recovering' || this.state.phase === 'standby') {
        this.requestSnapshot();
      }
    }, 1000);
    window.addEventListener('resize', this.onResize);
  }

  dispose() {
    this.unsubscribe?.();
    if (this.poll) clearInterval(this.poll);
    window.removeEventListener('resize', this.onResize);
    // 释放后所有在途结果一律失效。
    this.renderGen += 1;
    this.activeTarget = null;
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
          // 停映即终结当前提交代：在途解码/回退/缩放重绘全部作废，持续黑屏。
          this.renderGen += 1;
          this.activeTarget = null;
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
    // 取节目单期间可能已经停映或进入了新的恢复周期：状态机仍要求 recovering，
    // 但提交代会随 start()/SESSION_ENDED 递增；这里再核验一次避免覆盖。
    if (this.state.phase !== 'recovering') return;
    this.total = ids.length;
    this.blobIdByPage = ids;
    this.state = applySnapshot(this.state, res);
    this.imageError = false;
    // 快照成为新的唯一可提交画面：此前在途的任何取图结果即刻过期。
    this.renderGen += 1;
    this.activeTarget = { ...res.confirmed };
    const confirmedGen = this.renderGen;
    this.emit();

    // 快照中带“仍在等待确认”的未决命令，且序号严格相邻时立即承接：
    // 控制台在应答后重放的同序号 CMD 可能在本窗口恢复期间到达而被丢弃，
    // 这里以权威快照为准直接呈现该目标（失败仍回退到上面的 confirmed 帧）。
    // failed/unconfirmed 不自动承接——前者讲解员会另发替代命令，后者由人显式重试。
    const p = res.pending;
    const adoptPending =
      !!p &&
      p.status === 'pending' &&
      p.seq === this.state.appliedSeq + 1 &&
      this.state.phase === 'live';

    if (adoptPending && p) {
      // 有未决命令时：confirmed 首绘与 pending 承接依次开启各自提交代
      // （pending 立即令 confirmed 代次过期），confirmed 首绘不 await，
      // 否则在取图受控/缓慢时 pending 承接会被无限推迟。
      void this.repaintFrame(confirmedGen);
      await this.handleCommand({
        kind: 'CMD',
        sessionId: res.sessionId,
        seq: p.seq,
        action: p.action,
        page: p.target.page,
        blackout: p.target.blackout
      });
    } else {
      // 无未决命令：快照帧就是终点，正常等待首绘完成。
      await this.repaintFrame(confirmedGen);
    }
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
    // 命令被接受即开启新提交代：旧快照绘制、旧失败回退、旧缩放重绘全部作废。
    this.renderGen += 1;
    this.activeTarget = {
      seq: accept.render.seq,
      page: accept.render.page,
      blackout: accept.render.blackout
    };
    await this.present(
      accept.render.seq,
      accept.render.page,
      accept.render.blackout,
      this.renderGen
    );
  }

  /**
   * 异步结果回灌闸门：必须仍是 live、代次未变、且回灌帧仍是当前允许提交的
   * 目标帧。任一不满足都说明该结果已被更新的画面（或停映）取代，必须丢弃。
   */
  private canCommit(gen: number, target: FrameRef): boolean {
    return (
      this.state.phase === 'live' &&
      gen === this.renderGen &&
      sameFrame(this.activeTarget, target)
    );
  }

  /** 呈现一帧：取 Blob -> 解码 -> 绘制；失败回传 IMAGE_FAILED，最后成功页不变。 */
  private async present(seq: number, page: number, blackout: boolean, gen: number) {
    const target: FrameRef = { seq, page, blackout };
    try {
      if (blackout) {
        if (!this.canCommit(gen, target)) return;
        this.paintBlack();
      } else {
        const img = await this.loadImage(page);
        // 解码期间若已切页/遮黑/停映，无需再排队上屏；但若只是要验证“迟到
        // 上屏被否决”，继续走到上屏门——门放行后的 canCommit 是最终裁决。
        await this.awaitPaintGate(page);
        if (!this.canCommit(gen, target)) return; // 上屏前最终裁决
        this.drawImage(img);
      }
      if (!this.canCommit(gen, target)) return;
      const { state, ack } = resolveRender(this.state, target, true);
      this.state = state;
      this.imageError = false;
      this.bus.post(ack);
      this.emit();
    } catch (err) {
      console.error('present failed', err);
      // 失败结果晚到（替代命令已接受、已遮黑或已停映）：静默丢弃，
      // 不回退状态、不发失败确认、不重绘旧页。
      if (!this.canCommit(gen, target)) return;
      // 失败 ACK 先于回退绘制发出：权威状态（最后成功页）不依赖回退绘制完成。
      const { state, ack } = resolveRender(this.state, target, false);
      this.state = state;
      this.imageError = true;
      this.bus.post(ack);
      this.emit();
      // 回退到最后成功帧：以该帧开启新提交代并作为当前有效目标
      // （取代失败命令代次）。随后到达的同序号替代命令会再开一代，
      // 使这次仍在途的回退绘制在上屏点自然过期，不会覆盖新页。
      if (this.state.phase === 'live' && this.state.frame) {
        this.renderGen += 1;
        this.activeTarget = { ...this.state.frame };
        void this.repaintFrame(this.renderGen);
      }
    }
  }

  private async loadImage(page: number): Promise<HTMLImageElement> {
    // 测试闸门先于缓存检查：缓存命中也可控“晚到”，用于复现回退绘制竞态。
    const gate =
      typeof window !== 'undefined' ? window.__domeDecodeGate : undefined;
    if (gate?.decodeGate.enabled) {
      await gate.decodeGate.enter(page);
    }
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

  /**
   * 重绘“当前权威帧”。用于快照恢复首绘、失败回退、窗口缩放。
   * 调用携带其观察时的代次；回灌时代次/画面已变则什么都不画
   * （遮黑或停映后的迟到重绘因此不可能把图片重新画上穹顶）。
   */
  private async repaintFrame(gen: number): Promise<void> {
    // 入口仅要求仍有可绘帧；代次/目标的最终裁决在上屏点完成——这样被取代的
    // 旧帧仍会排队走到上屏门，便于（且保证）它在真正绘制前一刻被否决。
    if (this.state.phase !== 'live' || !this.state.frame) {
      return;
    }
    const frame: FrameRef = {
      seq: this.state.frame.seq,
      page: this.state.frame.page,
      blackout: this.state.frame.blackout
    };
    if (frame.blackout) {
      if (this.canCommit(gen, frame)) this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      await this.awaitPaintGate(frame.page);
      // 上屏前最终裁决：代次/目标已被遮黑、切页、停映取代则放弃绘制。
      if (!this.canCommit(gen, frame)) return;
      this.drawImage(img);
    } catch {
      if (this.canCommit(gen, frame)) this.paintBlack();
    }
  }

  /** 测试用：上屏前闸门；启用时每次 drawImage 都先按页排队等待放行。 */
  private async awaitPaintGate(page: number): Promise<void> {
    const gate =
      typeof window !== 'undefined' ? window.__domeDecodeGate : undefined;
    if (gate?.paintGate.enabled) {
      await gate.paintGate.enter(page);
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
