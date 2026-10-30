/**
 * 「项目」菜单「本地备份…」(c65-design.md 第 8 节裁定):按时间和实体列出草稿目录 `backups/` 里的备份,
 * 点「恢复」把那个实体以一次新写入写回去(照样进撤销栈、照样通知别人,不破坏「最后写的赢」)。
 *
 * 备份有两种(`docsync.ts` 的 `LocalBackup`):被别人覆盖之前自己那一版的实体;离线时选「丢弃」前的那批修改
 * (按它改到的实体各列一行,值取丢弃前那一份项目)。只有当前项目的备份能恢复。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { applyOps, entityValuePath, getAt, parsePath, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { actions, getState } from "../../store/project";
import { currentDocProjectId, displayNames, me, pushToast } from "./syncManager";
import { entityLabel, writerLabel } from "./labels";
import "./sync.css";

interface Summary {
  id: string;
  kind: "overwritten" | "offline-discard" | null;
  projectId: string | null;
  projectName: string | null;
  entity: string | null;
  entities: string[];
  by: unknown;
  rev: number | null;
  at: number;
  broken: boolean;
  /** 存这份备份的页面会话 */
  pageSession?: string | null;
}

interface Row {
  backup: Summary;
  entity: string;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把一个实体的值写回项目:原处还在就替换;原处没了(被别人删了)就插回去;备份里没有它就删掉 */
export function restoreInto(project: Project, entity: string, value: unknown): { ok: true; next: Project } | { ok: false; detail: string } {
  const path = entityValuePath(entity);
  if (path === "") return value && typeof value === "object" ? { ok: true, next: value as Project } : { ok: false, detail: "备份里没有项目内容" };
  const ops: PathOp[] = value === undefined ? [{ op: "remove", path }] : [{ op: "set", path, value }];
  const r = applyOps(project, ops);
  if (r.ok) return { ok: true, next: r.value };
  const segs = parsePath(path);
  const last = segs?.[segs.length - 1];
  if (value !== undefined && segs && last?.startsWith("@")) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    const arr = getAt(project, parent);
    if (Array.isArray(arr)) {
      // 片段按开始时间排着:插在第一个开始得比它晚的前面
      const start = (value as { start?: number }).start;
      let index = arr.length;
      if (typeof start === "number") {
        const i = arr.findIndex((x) => typeof (x as { start?: number }).start === "number" && (x as { start: number }).start > start);
        if (i >= 0) index = i;
      }
      const r2 = applyOps(project, [{ op: "insert", path: parent, index, value }]);
      if (r2.ok) return { ok: true, next: r2.value };
      return { ok: false, detail: r2.detail };
    }
  }
  return { ok: false, detail: r.detail };
}

export function BackupsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setErr("");
    fetch("/api/project-backups", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setItems(Array.isArray(j.backups) ? j.backups : []))
      .catch((e) => setErr(`读不到本地备份:${(e as Error).message}`));
  }, [open]);

  if (!open) return null;
  const project = getState().project;
  const current = currentDocProjectId();
  const rows: Row[] = (items ?? []).flatMap((b) => (b.kind === "overwritten" && b.entity ? [{ backup: b, entity: b.entity }] : b.entities.map((entity) => ({ backup: b, entity }))));

  const restore = async (row: Row) => {
    try {
      const r = await fetch(`/api/project-backups/${encodeURIComponent(row.backup.id)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const full = await r.json();
      const value = full.kind === "overwritten" ? full.value : getAt(full.project, entityValuePath(row.entity));
      const res = restoreInto(getState().project, row.entity, value);
      if (!res.ok) {
        pushToast(`恢复不了:${res.detail}`, "warn");
        return;
      }
      actions.editCardProject(() => res.next);
      pushToast(`已恢复 ${entityLabel(row.entity, res.next)}。`, "info", 4000);
    } catch (e) {
      pushToast(`恢复不了:${(e as Error).message}`, "warn");
    }
  };

  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog pc-sync-dialog--wide" role="dialog" aria-modal="true" data-pc="backups-dialog">
        <div className="pc-dialog-title">本地备份</div>
        <div className="pc-dialog-body">
          <div className="pc-sync-hint">被别人覆盖之前你那一版、离线时丢弃的修改都存在这里。点「恢复」会把那一处以一次新的修改写回当前项目。</div>
          {err ? <div className="pc-sync-err">{err}</div> : null}
          {items === null && !err ? <div className="pc-sync-hint">正在读取…</div> : null}
          {items && !rows.length ? <div className="pc-sync-hint">（还没有本地备份）</div> : null}
          <div className="pc-backups">
            {rows.map((row, i) => {
              const b = row.backup;
              const mine = b.projectId === current;
              // 「谁覆盖的」按备份的主人(被覆盖的那个页面)说:同一台机器上几个页面的备份都在这一个目录里
              const owner = { ...me(), session: b.pageSession ?? me().session };
              const who = b.kind === "overwritten" ? `被 ${writerLabel(b.by as never, owner, displayNames())} 覆盖` : "离线时丢弃";
              return (
                <div className="pc-backup-row" key={`${b.id}-${i}`} data-pc="backup-row" data-entity={row.entity}>
                  <span>{entityLabel(row.entity, mine ? project : null)}</span>
                  <small>
                    {fmtTime(b.at)} · {who}{b.rev !== null && b.rev !== undefined ? ` · 历史序号 ${b.rev}` : ""} · {b.projectName ?? b.projectId}
                    {mine ? "" : "(不是当前项目)"}
                  </small>
                  <button type="button" className="pc-dialog-opt" disabled={!mine} title={mine ? "以一次新的修改写回去" : "只能恢复到同一个项目"} onClick={() => void restore(row)}>
                    恢复
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
