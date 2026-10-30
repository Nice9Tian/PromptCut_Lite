/**
 * 预览走哪条路:**回滚开关 `?preview=legacy` 与双舞台开关 `?preview=stage`**(D5 / F2)。
 *
 * **R7 已经把缺省翻过来了**:不带参数、带 `?preview=stage`、带任何别的值,走的都是
 * 跨源双舞台 —— 舞台 iframe 直接露出来,播放头由可见舞台按帧节拍推(K4),
 * 主文档只留音频。要回到老路得显式写 `?preview=legacy`:一个同源舞台 iframe、
 * 整帧 `<img>` 预览、播放头由 `Preview` 的 rAF 循环推。
 */

/** 舞台实例名。**只是实例名,和角色无关**(E1):谁当 `front` 由 `setRole` 定 */
export type StageId = "A" | "B";

export const STAGE_IDS: readonly StageId[] = ["A", "B"];

/** 起手的角色分派:A 当可见舞台,B 当后台舞台。K5 的互换之后这张表就不作数了 */
export const INITIAL_ROLE_OF: Record<StageId, "front" | "back"> = { A: "front", B: "back" };

export type PreviewMode = "legacy" | "stage";

const paramOf = (): string => (typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("preview") || "");

/**
 * **缺省是 stage(R7 的原子切换)**;只有显式 `?preview=legacy` 才退回单舞台 + 整帧那条路。
 */
export function previewMode(): PreviewMode {
  return paramOf() === "legacy" ? "legacy" : "stage";
}

/**
 * 编辑器进程真的起起来的舞台端口(`server/vite-plugin-stage-ports.ts` 注入)。
 * 端口被占、或者在没有这个插件的环境里(vite preview 的产物包),这里是空表。
 */
export function stagePorts(): number[] {
  const v = (window as unknown as { __PC_STAGE_PORTS__?: unknown }).__PC_STAGE_PORTS__;
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * 每个舞台实例该从哪个源加载。**按当前页面的 hostname 拼**(不是写死 127.0.0.1):
 * 用户从 `localhost` 打开时两个 iframe 也得是 `localhost` —— 同 host 不同端口 + OAC 头
 * 才是实测过的那条路(`docs/archive/restructure_planning/g0-a-webview2-probe.md`),换成别的 host 就成了另一件事。
 */
export function stageOrigins(): Record<StageId, string> | null {
  const ports = stagePorts();
  if (ports.length < STAGE_IDS.length) return null;
  const out = {} as Record<StageId, string>;
  STAGE_IDS.forEach((id, i) => { out[id] = `${location.protocol}//${location.hostname}:${ports[i]}`; });
  return out;
}

/**
 * 这一次到底开不开双舞台。两个条件都要:显式开了 `?preview=stage`,而且两个舞台端口都起来了。
 * 少一个就退回 legacy 的同源单舞台 —— 宁可少一个后台舞台,也不能让编辑台开不出画面。
 */
export function dualStage(): boolean {
  return previewMode() === "stage" && stageOrigins() !== null;
}

export function interimStage(): boolean {
  return false;
}

export function singleLiveStage(): boolean {
  return false;
}

/** 可见舞台渲 live 变体(双舞台):播放头跟舞台的 `frame`、快照 / 抑制经 RPC 投递 */
export function liveStage(): boolean {
  return dualStage();
}

/**
 * 舞台 iframe 的地址。legacy(或端口没起来)时是同源,只有 A 那一个。
 */
export function stageSrc(id: StageId, opts: { dual?: boolean } = {}): string {
  const dual = opts.dual ?? dualStage();
  const origins = dual ? stageOrigins() : null;
  const mode = dual ? "&preview=stage" : previewMode() === "legacy" ? "&preview=legacy" : "";
  const platform = new URLSearchParams(location.search).get("platform") === "browser" ? "&platform=browser" : "";
  const dualFlag = dual ? "&dual=1" : "";
  const path = location.pathname;
  return `${origins ? origins[id] : ""}${path}?stage=1&id=${id}${mode}${platform}${dualFlag}`;
}

/** 给 `createStageRpc` 的 `targetOrigin`:跨源时必须点名,不能用 `location.origin` */
export function stageTargetOrigin(id: StageId): string {
  const origins = dualStage() ? stageOrigins() : null;
  return origins ? origins[id] : location.origin;
}
