import { useEffect, useState } from "react";
import { DockHost } from "../dock/DockHost";
import { DockPages } from "../dock/DockPages";
import { RailBar } from "../dock/RailBar";
import { connectMcpExecutor } from "../../ai/mcpExecutor";
import { startUserEditing } from "../userEditing";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";

import { CollectLoginDialog } from "./CollectLoginDialog";
import { AgentBrowserFrame } from "./AgentBrowserFrame";

import { editorApi } from "../../mcp/api";

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    const cleanup = connectMcpExecutor(() => editorApi, (s) => setMcpConnected(s.connected));
    // Push "user is editing" to the same editor process (A2), so when the Agent reads or writes these clips
    // the tool results carry a hint
    const stopEditing = startUserEditing();
    return () => { stopEditing(); cleanup(); };
  }, []);

  // The whole right rail column: on the left a host card (showing the page of the item selected in the right
  // rail), on the right a vertical rail stuck to the window edge (free side layout, editor/dock/).

  return (
    <>
      <div className="pc-right" data-pc="right">
        <DockHost side="right" />
        <RailBar side="right" />
      </div>
      {/*
        All pages (five sections, script page, each AiPanel) are rendered once here, portaled into their
        respective fixed nodes; hosts on both sides only move DOM nodes. RightPanel always occupies the
        same sibling slot in the Editor grid and never unmounts, so dragging / switching / collapsing
        never causes AiPanel to unmount and rebuild. Positioned after the host: the host's layout effect
        runs first and registers first; when page content layout effects run, nodes are already mounted in
        the document.
      */}
      <DockPages mcpConnected={mcpConnected} />
      {/* Site login box: the card on the start page and the collect_login tool both open it; it is mounted here so it can appear in the editor */}
      <CollectLoginDialog />
      {/* Voiceover settings child window: opened by the "Voiceover settings" button on the top bar */}
      <VoiceSettingsDialog />
      {/* Overlay for when the agent hands over the browser in desktop shell mode (never opens with the Chrome approach) */}
      <AgentBrowserFrame />
    </>
  );
}
