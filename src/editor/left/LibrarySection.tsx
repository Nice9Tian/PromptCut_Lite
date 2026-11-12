import { useCallback, useRef, useState } from "react";
import { IconImport } from "../../ui/icons";
import { KIND_LABEL, MEDIA_ACCEPT, importMediaFiles, type AssetKind } from "./importAssets";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { FlashBar, useFlash } from "./useFlash";
import { useOpenGroup } from "./stored";
import { KIND_GROUP, LIBRARY_GROUPS, LIBRARY_GROUP_IDS, type GroupData } from "./library/groups";
import { GroupBrowser } from "./library/GroupBrowser";
import { useMediaGroup, useMediaMenu } from "./library/mediaGroups";
import { useCutsGroup } from "./library/cutsGroup";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

/**
 * "Media library" section: import media → search → category pills → groups (video / image / audio).
 * Cards and parts are in the "Animations" section (AnimationsSection).
 *
 * The context menu, delete confirm dialog and bottom hint bar are all mounted and rendered
 * persistently at this level,
 * not following the detail of some group: right-clicking in the overview, group detail and search
 * results all pops them up.
 * pc.left.group.library used to store card group ids: ones not in LIBRARY_GROUP_IDS are read by
 * useOpenGroup as the overview.
 */
export function LibrarySection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q !== "";
  const [openGroup, setOpenGroup] = useOpenGroup("library", LIBRARY_GROUP_IDS);
  const [msg, flash] = useFlash();
  const mediaInputRef = useRef<HTMLInputElement>(null);

  // The three media groups share one context menu
  const mediaMenu = useMediaMenu(flash);
  const videos = useMediaGroup("video", q, mediaMenu.openMenu);
  const images = useMediaGroup("image", q, mediaMenu.openMenu);
  const music = useMediaGroup("audio", q, mediaMenu.openMenu);

  const cuts = useCutsGroup(q, flash);

  const data: Record<string, GroupData> = { videos, images, music, cuts: cuts.data };

  const ro = useReadOnly();
  const importMedia = useCallback(() => { if (!ro.locked) mediaInputRef.current?.click(); }, [ro.locked]);

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { counts, skipped, firstKind, rejected } = await importMediaFiles(files);
      // After an import, take the user to the group where the media landed, so they can see it came in
      if (firstKind) setOpenGroup(KIND_GROUP[firstKind]);
      if (skipped.length > 0) {
        const done = (Object.keys(counts) as AssetKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
          .join(tr(", "));
        const details = rejected.length ? `\n\n${rejected.join("\n")}` : "";
        alert(tr("{0}These files are not video / audio / images and were skipped:\n{1}{2}", done ? tr("Imported: {0}.\n\n", done) : "", skipped.join("\n"), details));
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      alert(tr("Failed to import media: {0}", m));
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="library" className="pc-left-section">
      <SectionHead title={tr("Media library")}>
        {/* Always-visible import: selected files are sorted by type into the video / image / audio groups */}
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="media"
          title={ro.locked ? ro.why : tr("Import media (video / audio / images, filed automatically by type)")}
          disabled={ro.locked}
          onClick={importMedia}
        >
          <IconImport size={16} />
          <span>{tr("Import media")}</span>
        </button>
        <SearchBox value={search} onChange={setSearch} placeholder={tr("Search media…")} dataPc="search" />
      </SectionHead>

      <GroupBrowser
        groups={LIBRARY_GROUPS}
        data={data}
        searching={searching}
        openId={openGroup}
        onOpen={setOpenGroup}
        onImport={ro.locked ? undefined : importMedia}
        noMatch={tr("No matching media")}
      />

      <FlashBar msg={msg} />

      {mediaMenu.overlay}
      {cuts.overlay}

      <input ref={mediaInputRef} type="file" accept={MEDIA_ACCEPT} multiple style={{ display: "none" }} onChange={handleMediaFileChange} />
    </div>
  );
}
