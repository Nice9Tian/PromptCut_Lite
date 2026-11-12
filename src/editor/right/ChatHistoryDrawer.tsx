import React from "react";
import type { ChatSummary } from "../../ai/chatStore";
import "./ChatHistoryDrawer.css";
import { tr } from "../../i18n/index.ts";

export interface ChatHistoryDrawerProps {
  open: boolean;
  onClose(): void;
  items: ChatSummary[];
  loading: boolean;
  query: string;
  onQueryChange(q: string): void;
  currentId: string;
  onPick(id: string): void;
  onDelete(id: string): void;
  /** The "New chat" in the header: clears the messages of the current tab and starts a new session archive (the same item is also in the "✦" menu) */
  onNewChat?(): void;
}

/** Format a session's update time: today shows HH:MM, this year shows M/D, earlier shows YYYY-M-D */
function formatChatTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const isThisYear = d.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return tr("{0}/{1}", d.getMonth() + 1, d.getDate());
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function ChatHistoryDrawer(props: ChatHistoryDrawerProps) {
  const {
    open,
    onClose,
    items,
    loading,
    query,
    onQueryChange,
    currentId,
    onPick,
    onDelete,
    onNewChat,
  } = props;

  if (!open) return null;

  return (
    <div className="chat-history-drawer" role="dialog" aria-label={tr("Chat history")}>
      {/* Header: title, new chat, close */}
      <div className="chat-drawer-header">
        <span className="chat-drawer-title">{tr("Chat history")}</span>
        <div className="chat-drawer-head-actions">
          {onNewChat && (
            <button type="button" className="chat-drawer-new-btn" data-pc="chat-new" onClick={onNewChat}>
              {tr("New chat")}
            </button>
          )}
          <button
            type="button"
            className="chat-drawer-close-btn"
            title={tr("Close")}
            aria-label={tr("Close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Search box */}
      <div className="chat-drawer-search-wrap">
        <input
          type="text"
          className="chat-drawer-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={tr("Search chats…")}
        />
      </div>

      {/* Session list */}
      <div className="chat-drawer-list">
        {loading ? (
          <div className="chat-drawer-empty">{tr("Loading…")}</div>
        ) : items.length === 0 ? (
          <div className="chat-drawer-empty">{tr("No chat history yet")}</div>
        ) : (
          items.map((item) => {
            const isCurrent = item.id === currentId;
            return (
              <div
                key={item.id}
                className={`chat-drawer-item ${isCurrent ? "is-current" : ""}`}
                onClick={() => onPick(item.id)}
              >
                <div className="chat-drawer-item-body">
                  <div className="chat-drawer-item-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="chat-drawer-item-meta">
                    {tr("{0} · {1} messages", formatChatTime(item.updatedAt), item.messageCount)}
                  </div>
                </div>
                <button
                  className="chat-drawer-delete-btn"
                  title={tr("Delete chat")}
                  aria-label={tr("Delete chat")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(item.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
