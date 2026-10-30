/**
 * 顶栏上的同步小部件:
 * - 「冲突合并」:待合并表里还有待处理的项时一直显示,点它打开冲突合并窗口(`ConflictMerge.tsx`;2026-10-18 用户定);
 * - 「同步已暂停」:离线批次逐项转表算不出基准、退回整份处理时才会出现(c65-design.md 第 8 节),点它重新打开离线对话框;
 * - 「离线」:连不上文档服务时的提示(修改照常,先攒在本机)。
 */
import { setOfflineOpen, useSync } from "./syncManager";
import "./sync.css";
import { ConflictMergeButton } from "./ConflictMerge";

export function SyncChips() {
  const status = useSync((v) => v.status);
  const active = useSync((v) => v.active);
  const merge = <ConflictMergeButton />;
  if (!active) return merge;
  return (
    <>
      {merge}
      {status === "paused" ? (
        <button type="button" className="pc-sync-chip pc-sync-chip--paused" data-pc="sync-paused" title="断网期间项目有新改动，点开决定怎么处理" onClick={() => setOfflineOpen(true)}>
          <span className="pc-sync-chip-dot" />
          同步已暂停
        </button>
      ) : status === "offline" ? (
        <span className="pc-sync-chip pc-sync-chip--offline" data-pc="sync-offline" title="连不上文档服务：修改照常，先攒在本机，恢复后按顺序提交">
          <span className="pc-sync-chip-dot" />
          离线
        </span>
      ) : null}
    </>
  );
}
