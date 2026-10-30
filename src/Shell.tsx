import { useEffect, useState } from "react";
import type { JSX } from "react";
import Editor from "./Editor";
import { StartPage } from "./StartPage";
import { openDraft, setActiveDraftId } from "./editor/io/drafts";
import { openProcPath } from "./editor/io/openPath";
import { WindowTitleBar } from "./ui/WindowTitleBar";
import { useSkin } from "./skins/useSkin";

/**
 * 开始页和编辑器之间的门。
 *
 * 编辑器本身不知道有开始页这回事 —— 它照旧渲染 store 里的当前项目。开始页在
 * 切过来之前就已经把项目 load 进 store 了,所以这里只管换视图。
 *
 * 几个启动参数:
 *   `?editor`          直接进编辑器:导出、自动化脚本和老书签都还指着这条路;
 *   `?draft=<id>`      打开某份草稿再进编辑器;
 *   `?open=<路径>`     按磁盘路径打开一份 .proc(桌面壳双击文件时带过来),会先复制一份再读;
 *   `?join=<项目号>`   局域网里的第二块屏:同一个本机项目的第二个页面,直接进编辑器,内容以本机文档服务为准
 *                      (`product/platforms.md`「桌面应用」的「局域网里的第二块屏」;接上文档服务那一步在
 *                      `editor/sync/syncManager.ts` 的 `startSync`)。
 *   `?headless=1`      自动化页面(探针、测试):不塞演示卡、不接文档服务、不弹素材迁移框(各处自己认这个参数)。
 */
export function Shell(): JSX.Element {
  // Keep the shared --ui-* palette mounted on the start page as well as the editor.
  // The title bar is outside both routes, so its colors stay synchronized.
  useSkin();
  const [inEditor, setInEditor] = useState(() => {
    try {
      const q = new URLSearchParams(location.search);
      // `?join=` 是局域网里的第二块屏:那张页面只为进这个项目,不经开始页
      return q.has("editor") || q.has("join");
    } catch {
      return false;
    }
  });
  const [bootError, setBootError] = useState("");

  // 顶栏的「回到首页」在 window 上派发这个事件,免得给 Editor 加一层 props
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

  // 启动参数只看一次
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

  // 桌面壳在已经开着的窗口上又收到一个 .proc(双击了文件):走同一条「复制再打开」的路
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
        打不开:{bootError}
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
