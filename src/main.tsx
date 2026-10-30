// 渲染面的时钟必须比 motion 先装好,所以这一行必须排在最前面(见 render/stageClockEntry.ts)
import "./render/stageClockEntry";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./skins/skins.css";
import App from "./App";
import Shell from "./Shell";
import ExportView from "./ExportView";
import AudioMixView from "./AudioMixView";
import StageView from "./StageView";
import { installFocusZoomReset } from "./ui/focusZoomReset";

// 不包 StrictMode:它的双重挂载会打断 Motion 带 delay 的进场动画(卡片停在 initial 不动)。
const q = new URLSearchParams(location.search);
const view = q.has("audioMix") ? <AudioMixView /> : q.has("export") ? <ExportView /> : q.has("stage") ? <StageView /> : q.has("proto") ? <App /> : <Shell />;
installFocusZoomReset();
createRoot(document.getElementById("root")!).render(view);
