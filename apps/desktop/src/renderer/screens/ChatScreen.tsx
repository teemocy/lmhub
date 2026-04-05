import type {
  ChatMessage,
  ChatSession,
  DesktopShellState,
  ModelSummary,
  OpenAiMessageContentPart,
} from "@localhub/shared-contracts";
import {
  type ChangeEvent,
  type ReactNode,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ChatScreenProps = {
  shellState: DesktopShellState;
  models: ModelSummary[];
};

type AttachmentPreview = {
  id: string;
  name: string;
  mimeType: string;
  src: string;
};

const createTempMessage = (
  sessionId: string,
  role: ChatMessage["role"],
  content: ChatMessage["content"],
  metadata: ChatMessage["metadata"] = {},
): ChatMessage => ({
  id: `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  sessionId,
  role,
  content,
  toolCalls: [],
  metadata,
  createdAt: new Date().toISOString(),
});

const sortByUpdatedDesc = (sessions: ChatSession[]): ChatSession[] =>
  [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

const createClientRequestId = (): string =>
  window.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const parseMaxTokensDraft = (value: string): number | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("Max tokens must be a positive integer.");
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Max tokens must be a positive integer.");
  }

  return parsed;
};

const getClientRequestId = (message: ChatMessage): string | undefined =>
  typeof message.metadata.clientRequestId === "string"
    ? message.metadata.clientRequestId
    : undefined;

const getReasoningContent = (message: ChatMessage): string =>
  typeof message.metadata.reasoningContent === "string" ? message.metadata.reasoningContent : "";

const isTextPart = (
  part: OpenAiMessageContentPart,
): part is Extract<OpenAiMessageContentPart, { type: "text" }> => part.type === "text";

const isImagePart = (
  part: OpenAiMessageContentPart,
): part is Extract<OpenAiMessageContentPart, { type: "image_url" }> => part.type === "image_url";

const formatModelLabel = (model: ModelSummary): string =>
  model.capabilities.includes("vision") ? `${model.name} · Vision` : model.name;

const buildMessageContent = (
  draft: string,
  attachments: AttachmentPreview[],
): string | OpenAiMessageContentPart[] => {
  const normalizedDraft = draft.trim();
  if (attachments.length === 0) {
    return normalizedDraft;
  }

  const parts: OpenAiMessageContentPart[] = [];
  if (normalizedDraft.length > 0) {
    parts.push({
      type: "text",
      text: normalizedDraft,
    });
  }

  parts.push(
    ...attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: {
        url: attachment.src,
      },
    })),
  );

  return parts;
};

const createImagePreview = async (file: File): Promise<AttachmentPreview> => {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error(`Unable to read ${file.name}.`));
    };
    reader.onerror = () => {
      reject(new Error(`Unable to read ${file.name}.`));
    };
    reader.readAsDataURL(file);
  });

  return {
    id:
      window.crypto?.randomUUID?.() ??
      `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    mimeType: file.type || "image/*",
    src,
  };
};

const renderChatContent = (content: ChatMessage["content"]): ReactNode => {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? <p className="chat-message-text">{content}</p> : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content.filter(
    (part): part is OpenAiMessageContentPart => isTextPart(part) || isImagePart(part),
  );
  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="chat-message-content">
      {parts.map((part) => {
        if (isTextPart(part)) {
          return (
            <p className="chat-message-text" key={`text-${part.text}`}>
              {part.text}
            </p>
          );
        }

        const imageKey = part.image_url.detail
          ? `image-${part.image_url.url}-${part.image_url.detail}`
          : `image-${part.image_url.url}`;

        return (
          <figure className="chat-message-image" key={imageKey}>
            <img alt="Attachment" loading="lazy" src={part.image_url.url} />
            {part.image_url.detail ? (
              <figcaption>Detail: {part.image_url.detail}</figcaption>
            ) : null}
          </figure>
        );
      })}
    </div>
  );
};

export function ChatScreen({ shellState, models }: ChatScreenProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [maxTokensDraft, setMaxTokensDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const supportsVision = selectedModel?.capabilities.includes("vision") ?? false;
  const activeSessionTitle = activeSession?.title ?? "Untitled chat";
  const activeSessionUpdatedAt = activeSession
    ? new Date(activeSession.updatedAt).toLocaleString()
    : "Create a session or send a prompt to start one.";
  const sessionStatusLabel = activeSession ? "Active session" : "No session selected";

  useEffect(() => {
    if (models.length === 0) {
      setSelectedModelId("");
      return;
    }

    setSelectedModelId((current) =>
      current && models.some((model) => model.id === current) ? current : (models[0]?.id ?? ""),
    );
  }, [models]);

  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const response = await window.desktopApi.gateway.listChatSessions();
        if (cancelled) {
          return;
        }

        const sorted = sortByUpdatedDesc(response.data);
        setSessions(sorted);
        setActiveSessionId((current) => {
          if (current && sorted.some((session) => session.id === current)) {
            return current;
          }

          return sorted[0]?.id ?? null;
        });
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unable to load sessions.");
        }
      }
    };

    void refreshSessions();
    return () => {
      cancelled = true;
    };
  }, [shellState.phase]);

  useEffect(() => {
    if (!activeSessionId || shellState.phase !== "connected") {
      setMessages([]);
      return;
    }

    let cancelled = false;
    const refreshMessages = async () => {
      try {
        const response = await window.desktopApi.gateway.listChatMessages(activeSessionId);
        if (cancelled) {
          return;
        }

        setMessages(response.data);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unable to load messages.");
        }
      }
    };

    void refreshMessages();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, shellState.phase]);

  useEffect(() => {
    if (!activeSession) {
      setSystemPrompt("");
      setSessionTitleDraft("");
      return;
    }

    if (activeSession.modelId && models.some((model) => model.id === activeSession.modelId)) {
      setSelectedModelId(activeSession.modelId);
    }
    setSystemPrompt(activeSession.systemPrompt ?? "");
    setSessionTitleDraft(activeSession.title ?? "");
  }, [activeSession, models]);

  useEffect(
    () =>
      window.desktopApi.gateway.subscribeChatStream((event) => {
        if (event.type === "error") {
          setError(event.errorMessage);
          return;
        }

        if (event.type !== "delta") {
          return;
        }

        setMessages((current) =>
          current.map((message) => {
            if (getClientRequestId(message) !== event.clientRequestId) {
              return message;
            }

            const nextReasoning = `${getReasoningContent(message)}${event.reasoningDelta ?? ""}`;
            const nextContent =
              typeof message.content === "string"
                ? `${message.content}${event.contentDelta ?? ""}`
                : (message.content ?? event.contentDelta ?? "");

            return {
              ...message,
              content: nextContent,
              toolCalls: event.toolCalls ?? message.toolCalls,
              metadata: {
                ...message.metadata,
                ...(nextReasoning.length > 0 ? { reasoningContent: nextReasoning } : {}),
              },
            };
          }),
        );
      }),
    [],
  );

  const openAttachmentPicker = () => {
    attachmentInputRef.current?.click();
  };

  const handleAttachmentPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    try {
      const nextAttachments = await Promise.all(files.map((file) => createImagePreview(file)));
      setAttachments((current) => [...current, ...nextAttachments]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to attach images.");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const ensureSession = async (): Promise<ChatSession> => {
    const next = await window.desktopApi.gateway.upsertChatSession({
      ...(activeSessionId ? { id: activeSessionId } : {}),
      ...(selectedModelId ? { modelId: selectedModelId } : {}),
      title: sessionTitleDraft.trim(),
      systemPrompt: systemPrompt.trim(),
    });
    startTransition(() => {
      setSessions((current) =>
        sortByUpdatedDesc([next, ...current.filter((item) => item.id !== next.id)]),
      );
      setActiveSessionId(next.id);
    });
    return next;
  };

  const saveSessionConfig = async () => {
    if (sessionActionBusy) {
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      await ensureSession();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save session settings.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const sendMessage = async () => {
    const prompt = draft.trim();
    const messageContent = buildMessageContent(prompt, attachments);
    const hasImages = attachments.length > 0;

    if (
      busy ||
      sessionActionBusy ||
      shellState.phase !== "connected" ||
      !selectedModelId ||
      (prompt.length === 0 && !hasImages) ||
      (hasImages && !supportsVision)
    ) {
      if (hasImages && !supportsVision) {
        setError("Select a vision-capable model to send image attachments.");
      }
      return;
    }

    let maxTokens: number | undefined;
    try {
      maxTokens = parseMaxTokensDraft(maxTokensDraft);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid max token limit.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const session = await ensureSession();
      const clientRequestId = createClientRequestId();
      setDraft("");
      setAttachments([]);

      const tempUser = createTempMessage(session.id, "user", messageContent);
      const tempAssistant = createTempMessage(session.id, "assistant", "", {
        clientRequestId,
      });
      setMessages((current) => [...current, tempUser, tempAssistant]);

      const result = await window.desktopApi.gateway.runChat({
        sessionId: session.id,
        model: selectedModelId,
        systemPrompt: systemPrompt.trim(),
        message: messageContent,
        clientRequestId,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      setMessages((current) =>
        current.map((message) => {
          if (message.id === tempUser.id) {
            return result.userMessage;
          }
          if (message.id === tempAssistant.id) {
            return result.assistantMessage;
          }
          return message;
        }),
      );
      setSessions((current) =>
        sortByUpdatedDesc([
          result.session,
          ...current.filter((item) => item.id !== result.session.id),
        ]),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to run chat.");
    } finally {
      setBusy(false);
    }
  };

  const createSession = async () => {
    if (sessionActionBusy) {
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      const next = await window.desktopApi.gateway.upsertChatSession({
        modelId: selectedModelId || undefined,
        title: sessionTitleDraft.trim(),
        systemPrompt: systemPrompt.trim(),
      });
      setSessions((current) =>
        sortByUpdatedDesc([next, ...current.filter((item) => item.id !== next.id)]),
      );
      setActiveSessionId(next.id);
      setMessages([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create session.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const deleteSession = async () => {
    if (!activeSessionId || sessionActionBusy) {
      return;
    }

    const sessionLabel = sessionTitleDraft.trim() || activeSessionTitle;
    if (
      !window.confirm(
        `Delete "${sessionLabel}"? This will remove the session and all of its messages.`,
      )
    ) {
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      await window.desktopApi.gateway.deleteChatSession(activeSessionId);
      const response = await window.desktopApi.gateway.listChatSessions();

      startTransition(() => {
        const sorted = sortByUpdatedDesc(response.data);
        setSessions(sorted);
        setActiveSessionId((current) => {
          if (current && sorted.some((session) => session.id === current)) {
            return current;
          }

          return sorted[0]?.id ?? null;
        });
        setMessages([]);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete session.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  return (
    <section className="chat-layout">
      <article className="info-card chat-session-list">
        <div className="panel-header">
          <div>
            <span className="section-label">Sessions</span>
            <h3>Persistent history</h3>
            <p>Keep recent sessions within reach and switch without losing context.</p>
          </div>
          <button
            className="secondary-button"
            disabled={shellState.phase !== "connected" || busy || sessionActionBusy}
            onClick={() => void createSession()}
            type="button"
          >
            New session
          </button>
        </div>
        <div className="model-list">
          {sessions.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>No saved sessions yet.</strong>
              <p>Send a prompt to start your first chat transcript.</p>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                className={
                  session.id === activeSessionId
                    ? "model-list-item model-list-item-active"
                    : "model-list-item"
                }
                disabled={shellState.phase !== "connected" || busy || sessionActionBusy}
                key={session.id}
                onClick={() => setActiveSessionId(session.id)}
                type="button"
              >
                <h4>{session.title ?? "Untitled chat"}</h4>
                <p>{new Date(session.updatedAt).toLocaleString()}</p>
              </button>
            ))
          )}
        </div>
      </article>

      <article className="info-card chat-main-panel">
        <div className="chat-session-banner">
          <div className="chat-session-copy">
            <span className="section-label">{sessionStatusLabel}</span>
            <input
              className="text-input chat-session-title-input"
              onChange={(event) => setSessionTitleDraft(event.target.value)}
              placeholder={activeSessionTitle}
              value={sessionTitleDraft}
            />
            <p>{activeSessionUpdatedAt}</p>
          </div>
          <div className="chat-session-meta">
            <span className="status-pill status-pill-neutral">
              {selectedModel?.name ?? "No model selected"}
            </span>
            <span
              className={
                supportsVision
                  ? "status-pill status-pill-positive"
                  : "status-pill status-pill-caution"
              }
            >
              {supportsVision ? "Vision enabled" : "Text only"}
            </span>
            <span className="meta-pill meta-pill-muted">{messages.length} messages</span>
          </div>
        </div>

        <div className="chat-session-actions">
          <button
            className="secondary-button"
            disabled={
              shellState.phase !== "connected" || !activeSession || busy || sessionActionBusy
            }
            onClick={() => void saveSessionConfig()}
            type="button"
          >
            Save session
          </button>
          <button
            className="secondary-button danger-button"
            disabled={
              shellState.phase !== "connected" || !activeSession || busy || sessionActionBusy
            }
            onClick={() => void deleteSession()}
            type="button"
          >
            Delete session
          </button>
        </div>

        <div className="chat-controls">
          <label className="field-stack">
            <span className="section-label">Model</span>
            <select
              className="text-input"
              onChange={(event) => setSelectedModelId(event.target.value)}
              value={selectedModelId}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {formatModelLabel(model)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-stack">
            <span className="section-label">System prompt</span>
            <textarea
              className="text-input"
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Optional system instruction"
              rows={3}
              value={systemPrompt}
            />
          </label>
          <label className="field-stack">
            <span className="section-label">Max tokens</span>
            <input
              className="text-input"
              inputMode="numeric"
              min={1}
              onChange={(event) => setMaxTokensDraft(event.target.value)}
              placeholder="Model default"
              step={1}
              type="number"
              value={maxTokensDraft}
            />
            <p className="chat-control-note">Leave blank to use the model default.</p>
          </label>
          <div className="button-row">
            <span className="status-chip">Gateway {shellState.phase}</span>
          </div>
        </div>

        <div className="chat-thread">
          {messages.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>Chat sandbox is ready.</strong>
              <p>Choose a model, enter a prompt, and your transcript will persist per session.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className="chat-bubble" data-role={message.role} key={message.id}>
                <strong>{message.role}</strong>
                {getReasoningContent(message) ? (
                  <details className="chat-thinking-block" open>
                    <summary>Thinking</summary>
                    <pre>{getReasoningContent(message)}</pre>
                  </details>
                ) : null}
                {renderChatContent(message.content)}
              </article>
            ))
          )}
        </div>

        <div className="chat-composer">
          <div className="chat-composer-toolbar">
            <button
              className="secondary-button"
              disabled={
                shellState.phase !== "connected" ||
                busy ||
                sessionActionBusy ||
                !selectedModelId ||
                !supportsVision
              }
              onClick={openAttachmentPicker}
              type="button"
            >
              Attach images
            </button>
            <span
              className={
                supportsVision
                  ? "status-pill status-pill-positive"
                  : "status-pill status-pill-caution"
              }
            >
              {supportsVision ? "Ready for images" : "Select a vision model"}
            </span>
          </div>
          {attachments.length > 0 ? (
            <div className="chat-attachment-grid">
              {attachments.map((attachment) => (
                <article className="chat-attachment-card" key={attachment.id}>
                  <img alt={attachment.name} loading="lazy" src={attachment.src} />
                  <div className="chat-attachment-card-meta">
                    <strong>{attachment.name}</strong>
                    <p>{attachment.mimeType}</p>
                  </div>
                  <button
                    className="secondary-button chat-attachment-remove"
                    onClick={() => removeAttachment(attachment.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
          ) : null}
          <input
            ref={attachmentInputRef}
            className="chat-attachment-input"
            multiple
            accept="image/*"
            onChange={(event) => void handleAttachmentPick(event)}
            type="file"
          />
          <textarea
            className="text-input"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Send a message"
            rows={3}
            value={draft}
          />
          <div className="button-row">
            <button
              className="primary-button"
              disabled={
                shellState.phase !== "connected" ||
                busy ||
                sessionActionBusy ||
                !selectedModelId ||
                (draft.trim().length === 0 && attachments.length === 0) ||
                (attachments.length > 0 && !supportsVision)
              }
              onClick={() => void sendMessage()}
              type="button"
            >
              {busy ? "Generating..." : "Send"}
            </button>
            {error ? <span className="status-pill status-pill-negative">{error}</span> : null}
          </div>
          <p className="chat-composer-note">
            {supportsVision
              ? "Add screenshots or photos to ground your prompt."
              : "Switch to a vision-capable model before attaching images."}
          </p>
        </div>
      </article>
    </section>
  );
}
