import React from "react";
import type { ChatSummary } from "../../ai/chatStore";
import "./ChatHistoryDrawer.css";

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
  /** 头部的「新对话」:清掉当前分页的消息、另起一段会话归档(「✦」菜单里也有同一项) */
  onNewChat?(): void;
}

/** 格式化会话更新时间：今天的显示 HH:MM，今年的显示 M月D日，更早显示 YYYY-M-D */
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
    return `${d.getMonth() + 1}月${d.getDate()}日`;
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
    <div className="chat-history-drawer" role="dialog" aria-label="对话历史">
      {/* 头部:标题、新对话、关闭 */}
      <div className="chat-drawer-header">
        <span className="chat-drawer-title">对话历史</span>
        <div className="chat-drawer-head-actions">
          {onNewChat && (
            <button type="button" className="chat-drawer-new-btn" data-pc="chat-new" onClick={onNewChat}>
              新对话
            </button>
          )}
          <button
            type="button"
            className="chat-drawer-close-btn"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="chat-drawer-search-wrap">
        <input
          type="text"
          className="chat-drawer-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="搜索对话…"
        />
      </div>

      {/* 会话列表 */}
      <div className="chat-drawer-list">
        {loading ? (
          <div className="chat-drawer-empty">读取中…</div>
        ) : items.length === 0 ? (
          <div className="chat-drawer-empty">还没有历史对话</div>
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
                    {formatChatTime(item.updatedAt)} · {item.messageCount} 条消息
                  </div>
                </div>
                <button
                  className="chat-drawer-delete-btn"
                  title="删除对话"
                  aria-label="删除对话"
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
