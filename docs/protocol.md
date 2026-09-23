# 穹顶讲解协议（v1）

所有消息经同源 `BroadcastChannel('dome-presenter-v1')` 传递。图片**不**
经过消息通道：观众窗按冻结节目单中的 `blobId` 直接从 IndexedDB 读取。

## 消息

| 消息 | 方向 | 关键字段 |
| --- | --- | --- |
| `CMD` | 控制台 → 观众窗 | `sessionId`, `seq`, `action`, `page`, `blackout` |
| `ACK` (`ok:true`) | 观众窗 → 控制台 | `sessionId`, `seq`, 实际呈现的 `page`/`blackout` |
| `ACK` (`ok:false`) | 观众窗 → 控制台 | `reason:'IMAGE_FAILED'`，带回最后成功页 `page`/`blackout` |
| `SNAPSHOT_REQ` | 观众窗 → 控制台 | `viewerId`（启动/刷新后立即发，并每秒轮询直到拿到运行中会话） |
| `SNAPSHOT_RES` | 控制台 → 观众窗 | 定向 `viewerId`、`running`、`confirmed{seq,page,blackout}`、`pending` |
| `SESSION_ENDED` | 控制台 → 观众窗 | `sessionId` |

## 权威状态

控制台是唯一权威持有者：

- `lastConfirmed = { seq, page, blackout }`：最近一次被确认呈现的完整画面；
  会话初始为 `{ seq:0, page:0, blackout:false }`。
- `pending`：当前命令的生命周期 `pending → （ACK）清空`、
  `pending → unconfirmed（超时）→ 重试回 pending`、
  `pending → failed（IMAGE_FAILED）`。

序号规则：

- 新命令 `seq = lastConfirmed.seq + 1`，严格单调；
- `pending`/`unconfirmed` 期间不接受叠加的新命令（未确认可能已在穹顶成像，
  只能显式**重试且沿用原序号**）；
- `failed` 允许被讲解员的下一条命令取代（观众窗已回退到最后成功帧，新命令
  仍从上一权威序号递增），坏图不锁死放映；
- 控制台只接受 `sessionId` 相同、`seq === pending.seq`、**且成功确认回传的
  `page`/`blackout` 与 pending 目标完全一致**的 ACK。旧确认、其它会话确认、
  以及多观众窗交错时“同序号但画面不同”的确认一律丢弃——序号只表示新旧，
  不证明回传的就是当前待确认画面；权威画面不可能被迟到或错位确认拉回。

## 观众窗不变量

- 启动即 `recovering`：只接受**定向给本窗口**的 `SNAPSHOT_RES`；
  恢复期间所有 `CMD` 丢弃，画面保持全黑，杜绝“刷新后闪回旧星图”。
- 恢复后 `appliedSeq = confirmed.seq`、画面直接采用 `confirmed`
  （含遮黑状态）。
- 快照带 `pending` 时：仅当 `pending.status === 'pending'` 且
  `pending.seq === appliedSeq + 1`，观众窗立即承接该未决目标（控制台应答后
  重放的同序号 CMD 在恢复窗口到达会被丢弃，由快照自身保证收敛）；`failed`
  /`unconfirmed` 不自动承接（前者等讲解员的替代命令，后者等显式重试）。
  承接失败（坏图）仍回退到 confirmed 帧。
- `live` 期间：
  - `seq < appliedSeq`：更旧消息，忽略；
  - `seq === appliedSeq`：完全重复（典型：ACK 丢失后超时重发），画面不动，
    重放当前帧 ACK；
  - `seq === appliedSeq + 1`：接受并呈现；
  - 其它跳号：忽略。
- 呈现失败：`appliedSeq` 与画面回退到最后成功帧，回 `ok:false`；随后同序号
  重试可再次被接受。
- 画布提交代（render generation）：应用快照、接受命令、停映都会开启新代次。
  所有异步结果（恢复快照取图、命令解码、失败回退重绘、窗口缩放重绘）在真正
  画上画布/回送 ACK 前必须仍处于 `live`、代次未变、且目标帧仍是当前有效帧；
  代次已被取代的迟到结果整体作废（不画、不确认、不改状态）。因此恢复旧快照
  晚于后续切页、缩放旧帧晚于遮黑/停映、失败回退晚于同序号替代命令时，穹顶
  像素都不会倒退；失败仍保留最后成功帧，停映后持续黑屏。
- `sessionId` 不匹配的任何消息（含伪造的 `CMD`/`SESSION_ENDED`）一律无效。

## 持久化与恢复

- IndexedDB：
  - `blobs`：`{ blobId, blob(Blob), name }`；
  - `program`：`draft`（草稿）与 `frozen:<sessionId>`（随会话冻结的顺序）；
  - `session`：`current`（运行中会话的完整权威状态）。
- 控制台刷新：从 IDB 恢复会话；若存在未决命令，统一标记为 `unconfirmed`
  （不自动重发，由讲解员决定，序号不变）。
- 观众窗刷新/重开：`SNAPSHOT_REQ` → 读取该会话冻结节目单 → 应用
  `confirmed` 快照 → 进入 `live`。
- 收敛终点：控制台“已呈现（权威）”标记与穹顶实际画面始终等于同一个
  `lastConfirmed`。

## 超时

默认 ACK 超时 `1500ms`（`DEFAULT_ACK_TIMEOUT_MS`），控制台每 200ms 巡检。
超时只改标记，绝不改变 `lastConfirmed`。
