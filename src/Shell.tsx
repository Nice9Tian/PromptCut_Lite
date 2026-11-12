import { useEffect, useState } from "react";
import type { JSX } from "react";
import Editor from "./Editor";
import { StartPage } from "./StartPage";
import { openDraft, setActiveDraftId } from "./editor/io/drafts";
import { openProcPath } from "./editor/io/openPath";
import { WindowTitleBar } from "./ui/WindowTitleBar";
import { useSkin } from "./skins/useSkin";
import { tr } from "./i18n/index.ts";

/**
 * The gate between the start page and the editor.
 *
 * The editor itself knows nothing about the start page: it just renders the current project in the
 * store. The start page has already loaded the project into the store before switching over, so
 * all that is left to do here is swap the view.
 *
 * Launch parameters:
 *   `?editor`          go straight to the editor: export, automation scripts and old bookmarks
 *                      all still point at this path;
 *   `?draft=<id>`      open a draft, then enter the editor;
 *   `?open=<path>`     open a .proc by disk path (passed in when the desktop shell opens a file by
 *                      double-click); it copies the file first, then reads the copy;
 *   `?join=<project id>`   second screen on the LAN: a second page for the same local project, goes
 *                      straight to the editor, and the content follows the local document service
 *                      (`product/platforms.md`, "Desktop app", "Second screen on the LAN"; the step
 *                      that connects to the document service is `startSync` in
 *                      `editor/sync/syncManager.ts`).
 *   `?headless=1`      automation pages (probes, tests): no demo cards, no document service, no
 *                      media migration dialog (each place recognizes this parameter on its own).
 */
export function Shell(): JSX.Element {
  // Keep the shared --ui-* palette mounted on the start page as well as the editor.
  // The title bar is outside both routes, so its colors stay synchronized.
  useSkin();
  const [inEditor, setInEditor] = useState(() => {
    try {
      const q = new URLSearchParams(location.search);
      // `?join=` is a second screen on the LAN: that page exists only to enter this project, skipping the start page
      return q.has("editor") || q.has("join");
    } catch {
      return false;
    }
  });
  const [bootError, setBootError] = useState("");

  // The "Back to home" button in the top bar dispatches this event on window, to avoid adding another layer of props to Editor
  useEffect(() => {
    const back = () => {
      const url = new URL(location.href);
      for (const key of ["editor", "open", "draft"]) url.searchParams.delete(key);
      history.replaceState(null, "", url);
      setInEditor(false);
    };
    window.addEventListener("pc-go-home", back);
    return () => window.removeEventListener("pc-go-home", back);
  }, []);

  // Launch parameters are only checked once
  useEffect(() => {
    let q: URLSearchParams;
    try {
      q = new URLSearchParams(location.search);
    } catch {
      return;
    }
    const draft = q.get("draft");
    const open = q.get("open");
    if (draft) {
      openDraft(draft)
        .then(() => {
          setActiveDraftId(draft);
          setInEditor(true);
        })
        .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    } else if (open) {
      openProcPath(open)
        .then(() => setInEditor(true))
        .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    }
  }, []);

  // The desktop shell received another .proc on an already open window (a file was double-clicked): take the same "copy, then open" path
  useEffect(() => {
    const tauri = (window as unknown as {
      __TAURI__?: { event?: { listen?: (e: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void> } };
    }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (!listen) return;
    let un: (() => void) | undefined;
    listen("pc-open-file", (ev) => {
      const p = typeof ev?.payload === "string" ? ev.payload : "";
      if (!p) return;
      openProcPath(p)
        .then(() => setInEditor(true))
        .catch((e) => alert(e instanceof Error ? e.message : String(e)));
    })
      .then((fn) => { un = fn; })
      .catch(() => {});
    return () => un?.();
  }, []);

  if (bootError) {
    return (
      <div style={{ padding: 24, color: "var(--ui-danger)", fontFamily: "var(--ui-font)" }}>
        {tr("Cannot open: {0}", bootError)}
      </div>
    );
  }
  return (
    <div className="pc-app-shell">
      <WindowTitleBar />
      <div className="pc-app-content">
        {inEditor ? <Editor /> : <StartPage onEnterEditor={() => setInEditor(true)} />}
      </div>
    </div>
  );
}

export default Shell;
