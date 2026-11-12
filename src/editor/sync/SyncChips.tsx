/**
 * Sync widgets on the top bar:
 * - "Conflict merge": always shown while the pending merge items list still has items to handle; click it
 *   to open the conflict merge window (`ConflictMerge.tsx`; user decision, 2026-10-18);
 * - "Sync paused": appears only when the offline batch cannot work out a baseline item by item in the
 *   transform table and falls back to handling the whole copy (c65-design.md section 8); click it to
 *   reopen the offline dialog;
 * - "Offline": the prompt when the document service cannot be reached (edits continue as usual and pile
 *   up on this machine).
 */
import { setOfflineOpen, useSync } from "./syncManager";
import "./sync.css";
import { ConflictMergeButton } from "./ConflictMerge";
import { tr } from "../../i18n/index.ts";

export function SyncChips() {
  const status = useSync((v) => v.status);
  const active = useSync((v) => v.active);
  const merge = <ConflictMergeButton />;
  if (!active) return merge;
  return (
    <>
      {merge}
      {status === "paused" ? (
        <button type="button" className="pc-sync-chip pc-sync-chip--paused" data-pc="sync-paused" title={tr("The project changed while you were offline. Click to decide how to handle it")} onClick={() => setOfflineOpen(true)}>
          <span className="pc-sync-chip-dot" />
          {tr("Sync paused")}
        </button>
      ) : status === "offline" ? (
        <span className="pc-sync-chip pc-sync-chip--offline" data-pc="sync-offline" title={tr("Cannot reach the document service: edits work as usual and are held on this machine, then submitted in order once it recovers")}>
          <span className="pc-sync-chip-dot" />
          {tr("Offline")}
        </span>
      ) : null}
    </>
  );
}
