/**
 * 控制台侧协议状态机（纯函数，便于 Vitest 核验）。
 */
import {
  CommandAction,
  CommandMessage,
  ConfirmedFrame,
  DEFAULT_ACK_TIMEOUT_MS,
  FailAckMessage,
  PendingCommand,
  SessionRecord,
  Ack,
  initialConfirmed
} from './types';

export interface StartResult {
  session: SessionRecord;
}

export function startSession(
  sessionId: string,
  pageCount: number,
  startedAt = Date.now()
): SessionRecord {
  if (pageCount <= 0) throw new Error('节目单为空，无法开始放映');
  // 骨架占位：真实 SlideItem 由调用方（ConsoleController）在落库时替换。
  const items = Array.from({ length: pageCount }, (_, i) => ({
    id: `page_${i}`,
    blobId: `page_${i}`,
    name: `page ${i + 1}`,
    type: 'image/*',
    size: 0
  }));
  return {
    sessionId,
    startedAt,
    running: true,
    frozenProgram: { items },
    lastConfirmed: initialConfirmed(pageCount),
    pending: null
  };
}

function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (page < 0) return 0;
  if (page > pageCount - 1) return pageCount - 1;
  return page;
}

/** 把讲解员操作应用到“当前权威画面”，计算命令所指向的完整画面。 */
export function propose(
  current: ConfirmedFrame,
  action: CommandAction,
  pageCount: number
): { page: number; blackout: boolean } {
  const page = current.page;
  switch (action.type) {
    case 'next':
      return { page: clampPage(page + 1, pageCount), blackout: false };
    case 'prev':
      return { page: clampPage(page - 1, pageCount), blackout: false };
    case 'goto':
      return { page: clampPage(action.page, pageCount), blackout: false };
    case 'setBlackout':
      return { page, blackout: action.blackout };
  }
}

export interface IssueResult {
  session: SessionRecord;
  command: CommandMessage | null;
  /** true 表示操作与当前画面相同（空操作），不会产生命令。 */
  noop?: boolean;
}

/**
 * 讲解员发出一条命令。
 * - 仍在“待确认/未确认”时拒绝叠加（未确认可能已在穹顶呈现，只能显式重试同序号）；
 * - 上一条“呈现失败”时允许新命令取代它（观众窗已回退到最后成功帧，
 *   新命令沿用上一权威序号是安全的），避免一次坏图锁死整场放映；
 * - 序号严格递增（相对最后已确认帧）；重试沿用原序号（见 retryPending）；
 * - 指向画面与当前权威画面相同时为空操作。
 */
export function issue(
  session: SessionRecord,
  action: CommandAction,
  now = Date.now(),
  pageCount = session.frozenProgram.items.length
): IssueResult {
  if (!session.running) throw new Error('会话未在放映中');
  if (session.pending && session.pending.status !== 'failed') {
    return { session, command: null };
  }

  const target = propose(session.lastConfirmed, action, pageCount);
  if (
    target.page === session.lastConfirmed.page &&
    target.blackout === session.lastConfirmed.blackout
  ) {
    return { session, command: null, noop: true };
  }

  const seq = session.lastConfirmed.seq + 1;
  const pending: PendingCommand = {
    seq,
    action,
    target,
    status: 'pending',
    issuedAt: now,
    attempts: 1
  };
  const command: CommandMessage = {
    kind: 'CMD',
    sessionId: session.sessionId,
    seq,
    action,
    page: target.page,
    blackout: target.blackout
  };
  return { session: { ...session, pending }, command };
}

/** 重试必须沿用原序号。未决/未确认/失败状态都可重试。 */
export function retryPending(session: SessionRecord, now = Date.now()): IssueResult {
  const p = session.pending;
  if (!p) return { session, command: null };
  const next: SessionRecord = {
    ...session,
    pending: { ...p, status: 'pending', attempts: p.attempts + 1, issuedAt: now }
  };
  return {
    session: next,
    command: {
      kind: 'CMD',
      sessionId: session.sessionId,
      seq: p.seq,
      action: p.action,
      page: p.target.page,
      blackout: p.target.blackout
    }
  };
}

/** 把超时的待确认命令标记为“未确认”；权威画面保持不变。 */
export function expirePending(
  session: SessionRecord,
  now = Date.now(),
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS
): SessionRecord {
  const p = session.pending;
  if (!p || p.status !== 'pending') return session;
  if (now - p.issuedAt < timeoutMs) return session;
  return { ...session, pending: { ...p, status: 'unconfirmed' } };
}

/**
 * 处理观众窗回传的确认。
 * 只接受“当前未决命令、相同序号、且回传画面与命令目标完全一致”的成功确认：
 *   - 旧确认（序号 <= 权威序号或与未决序号不符）一律忽略，画面不会跳回旧星图；
 *   - 序号相同但 page/blackout 与待确认目标不同（如多观众窗交错时另一窗口
 *     回传的同序号旧画面）同样忽略：序号只解决新旧，不证明画面就是当前目标，
 *     权威状态只能由真正呈现了目标画面的确认推进；
 *   - ok：权威画面前进到该序号；
 *   - 失败：未决标记 failed，权威画面（最后成功页）不变。
 */
export function receiveAck(session: SessionRecord, ack: Ack): SessionRecord {
  if (ack.sessionId !== session.sessionId) return session;
  const p = session.pending;
  if (!p || ack.seq !== p.seq) return session;

  if (!ack.ok) {
    const reason = (ack as FailAckMessage).reason;
    void reason;
    return { ...session, pending: { ...p, status: 'failed' } };
  }

  // 成功确认还必须逐字段匹配当前待确认目标；多窗口交错时同序号不同画面的
  // 确认不具备权威性，直接丢弃，等待真正呈现目标的窗口确认。
  if (ack.page !== p.target.page || ack.blackout !== p.target.blackout) {
    return session;
  }

  const confirmed: ConfirmedFrame = {
    seq: ack.seq,
    page: ack.page,
    blackout: ack.blackout
  };
  return { ...session, lastConfirmed: confirmed, pending: null };
}

/** 停映：会话结束，节目单解除冻结（编辑只影响草稿/下一会话）。 */
export function endSession(session: SessionRecord): SessionRecord {
  return { ...session, running: false, pending: null };
}
