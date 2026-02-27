"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MessageCircle, Send, X, Loader2, ChevronDown } from "lucide-react";
import { getLocalAuthToken } from "@/auth/localAuth";
import { Markdown } from "@/components/atoms/Markdown";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

type WsStatus = "connecting" | "connected" | "disconnected" | "error";

function statusLabel(s: WsStatus): string {
  switch (s) {
    case "connecting":
      return "Connecting...";
    case "connected":
      return "Online";
    case "disconnected":
      return "Offline";
    case "error":
      return "Error";
  }
}

function statusColor(s: WsStatus): string {
  switch (s) {
    case "connected":
      return "bg-emerald-400";
    case "connecting":
      return "bg-amber-400 animate-pulse";
    default:
      return "bg-slate-400";
  }
}

export default function FranzChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to bottom
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Build WS URL
  const buildWsUrl = useCallback(() => {
    const token = getLocalAuthToken();
    if (!token) return null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/v1/chat/ws?token=${encodeURIComponent(token)}`;
  }, []);

  // Load history via REST
  const loadHistory = useCallback(async () => {
    const token = getLocalAuthToken();
    if (!token) return;
    try {
      const res = await fetch(
        `/api/v1/chat/history?token=${encodeURIComponent(token)}&limit=50`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        const mapped: ChatMessage[] = data.messages.map(
          (m: { role?: string; content?: string; timestamp?: string }) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.content ?? "",
            timestamp: m.timestamp ?? new Date().toISOString(),
          }),
        );
        setMessages(mapped);
      }
    } catch {
      // Ignore – history is best-effort
    }
  }, []);

  // Connect WS
  const connect = useCallback(() => {
    const url = buildWsUrl();
    if (!url) return;

    if (wsRef.current) {
      wsRef.current.close();
    }

    setWsStatus("connecting");
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Wait for "connected" message from backend
    };

    ws.onmessage = (evt) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }

      switch (data.type) {
        case "connected":
          setWsStatus("connected");
          break;

        case "delta":
          setIsThinking(false);
          setStreaming((prev) => prev + (data.content as string));
          break;

        case "final": {
          setIsThinking(false);
          const finalContent = data.content as string;
          setStreaming((prevStreaming) => {
            const content = finalContent || prevStreaming || "...";
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content,
                timestamp: new Date().toISOString(),
              },
            ]);
            return "";
          });
          break;
        }

        case "status":
          if (data.status === "thinking") {
            setIsThinking(true);
          } else if (data.status === "idle") {
            setIsThinking(false);
          }
          break;

        case "error":
          setIsThinking(false);
          setStreaming("");
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Error: ${data.message ?? "Unknown error"}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
      }
    };

    ws.onclose = () => {
      setWsStatus("disconnected");
      wsRef.current = null;
      // Auto-reconnect after 3s if panel is open
      reconnectTimer.current = setTimeout(() => {
        if (open) connect();
      }, 3000);
    };

    ws.onerror = () => {
      setWsStatus("error");
    };
  }, [buildWsUrl, open, streaming]);

  // Connect when panel opens, disconnect when it closes
  useEffect(() => {
    if (open) {
      loadHistory();
      connect();
    }
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      return;

    // Add user message immediately
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, timestamp: new Date().toISOString() },
    ]);
    setInput("");
    setStreaming("");
    setIsThinking(true);

    wsRef.current.send(JSON.stringify({ type: "send", content: text }));
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Floating chat bubble (closed state)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition hover:bg-blue-700 hover:shadow-xl active:scale-95"
        aria-label="Open Franz Chat"
      >
        <MessageCircle className="h-6 w-6" />
      </button>
    );
  }

  // Open chat panel
  return (
    <div className="fixed bottom-6 right-6 z-50 flex h-[600px] w-[420px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
            F
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Franz</h3>
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${statusColor(wsStatus)}`}
              />
              <span className="text-xs text-slate-400">
                {statusLabel(wsStatus)}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          aria-label="Close chat"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && !isThinking && !streaming && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessageCircle className="mb-3 h-10 w-10 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">
              Chat with Franz
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Send a message to get started
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-800"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-sm max-w-none prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1">
                  <Markdown content={msg.content} variant="comment" />
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl bg-slate-100 px-4 py-2.5 text-sm leading-relaxed text-slate-800">
              <div className="prose prose-sm max-w-none prose-p:my-1 prose-pre:my-2">
                <Markdown content={streaming} variant="comment" />
              </div>
            </div>
          </div>
        )}

        {/* Thinking indicator */}
        {isThinking && !streaming && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Franz is thinking...</span>
            </div>
          </div>
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {scrollRef.current &&
        scrollRef.current.scrollHeight - scrollRef.current.scrollTop >
          scrollRef.current.clientHeight + 100 && (
          <button
            onClick={() =>
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "smooth",
              })
            }
            className="absolute bottom-[76px] left-1/2 -translate-x-1/2 rounded-full bg-white p-1.5 shadow-md border border-slate-200 text-slate-500 hover:text-slate-700"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}

      {/* Input area */}
      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Franz..."
            rows={1}
            className="max-h-24 min-h-[40px] flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <button
            onClick={sendMessage}
            disabled={
              !input.trim() ||
              wsStatus !== "connected"
            }
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-slate-400">
          Enter to send &middot; Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
