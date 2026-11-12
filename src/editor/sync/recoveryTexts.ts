import { tr } from "../../i18n/index.ts";
/**
 * User-facing messages for opening a project file and missing media.
 */
export const UNSUPPORTED_PROC_TEXT = (version: unknown) =>
  tr("This project file was saved by a newer version of PromptCut (format version {0}) and cannot be opened by this version; the original file was not changed.", String(version));

export const MISSING_MATERIALS_TEXT = {
  title: tr("Media not found"),
  missing: (n: number) => tr("The files for the {0} media items below could not be found on this computer. The positions and arrangement of the clips that use them are kept; the picture shows \"Media not found\" and the file name, and the audio plays a \"Media not found\" prompt tone once. Import the files back and they will be restored automatically.", n),
  changed: tr("The file at the original location has changed"),
  ok: tr("Got it"),
} as const;
