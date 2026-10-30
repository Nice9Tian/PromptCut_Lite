/**
 * 打开项目文件与缺失素材这两件事里给用户看的提示文字。
 */
export const UNSUPPORTED_PROC_TEXT = (version: unknown) =>
  `这个项目文件是更新版本的 PromptCut 保存的（格式版本 ${String(version)}），这一版打不开；原文件没有改动。`;

export const MISSING_MATERIALS_TEXT = {
  title: "找不到素材",
  missing: (n: number) => `下面 ${n} 个素材在这台电脑上找不到文件。用到它们的片段位置和编排都保留着，画面显示「找不到素材」和文件名，声音放一次「找不到素材」的提示音；把文件导入回来后会自动恢复。`,
  changed: "原位置的文件内容已经变了",
  ok: "知道了",
} as const;
