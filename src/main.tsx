// The render surface's clock must be installed before motion, so this line must come first (see render/stageClockEntry.ts)
import "./render/stageClockEntry";
import { createRoot } from "react-dom/client";
import { installLocaleHeader } from "./i18n/index.ts";
import "./index.css";
import "./skins/skins.css";
import App from "./App";
import Shell from "./Shell";
import ExportView from "./ExportView";
import AudioMixView from "./AudioMixView";
import StageView from "./StageView";
import ThumbStageView from "./ThumbStageView";
import { installFocusZoomReset } from "./ui/focusZoomReset";

// No StrictMode: its double mount interrupts Motion entrance animations with a delay (the card stays at initial and does not move).
const q = new URLSearchParams(location.search);
const view = q.has("audioMix") ? <AudioMixView /> : q.has("export") ? <ExportView /> : q.has("stage") ? (q.has("thumb") ? <ThumbStageView /> : <StageView />) : q.has("proto") ? <App /> : <Shell />;
installFocusZoomReset();
installLocaleHeader();
createRoot(document.getElementById("root")!).render(view);
