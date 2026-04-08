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

type ChatSessionSettingsState = {
  systemPrompt: string;
  temperature: string;
  maxMessagesInContext: string;
  maxOutputTokens: string;
  topP: string;
};

const createEmptyChatSessionSettingsState = (): ChatSessionSettingsState => ({
  systemPrompt: "",
  temperature: "",
  maxMessagesInContext: "",
  maxOutputTokens: "",
  topP: "",
});

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

const CHAT_REQUEST_CANCELLED_MESSAGE = "Chat request cancelled.";

const normalizeSessionTitle = (value: string): string => value.trim();

const formatSessionFileName = (title: string, sessionId: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `chat-session-${slug || sessionId}`;
};

const downloadJson = (fileName: string, payload: unknown): void => {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const toDraftNumber = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0 && Number.isFinite(Number(normalized))) {
      return normalized;
    }
  }

  return "";
};

const parseOptionalNumberDraft = (
  value: string,
  label: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number | undefined => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number.`);
  }

  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`${label} must be at least ${options.min}.`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${label} must be at most ${options.max}.`);
  }

  if (options.integer && !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer.`);
  }

  return parsed;
};

const getChatSessionSettingsState = (session: ChatSession | null): ChatSessionSettingsState => {
  const rawSettings = session?.metadata?.chatSettings;
  const record =
    rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
      ? (rawSettings as Record<string, unknown>)
      : {};

  return {
    systemPrompt: session?.systemPrompt ?? "",
    temperature: toDraftNumber(record.temperature),
    maxMessagesInContext: toDraftNumber(record.maxMessagesInContext),
    maxOutputTokens: toDraftNumber(record.maxOutputTokens),
    topP: toDraftNumber(record.topP ?? record.top_p),
  };
};

const normalizeChatSessionSettingsState = (
  settings: ChatSessionSettingsState,
): ChatSessionSettingsState => ({
  systemPrompt: settings.systemPrompt.trim(),
  temperature: settings.temperature.trim(),
  maxMessagesInContext: settings.maxMessagesInContext.trim(),
  maxOutputTokens: settings.maxOutputTokens.trim(),
  topP: settings.topP.trim(),
});

const buildChatSessionMetadata = (
  settings: ChatSessionSettingsState,
): Record<string, unknown> => {
  const chatSettings: Record<string, unknown> = {};
  const temperature = parseOptionalNumberDraft(settings.temperature, "Temperature", {
    min: 0,
    max: 2,
  });
  if (temperature !== undefined) {
    chatSettings.temperature = temperature;
  }

  const topP = parseOptionalNumberDraft(settings.topP, "Top P", {
    min: 0,
    max: 1,
  });
  if (topP !== undefined) {
    chatSettings.topP = topP;
  }

  const maxMessagesInContext = parseOptionalNumberDraft(
    settings.maxMessagesInContext,
    "Max messages in context",
    {
      integer: true,
      min: 1,
    },
  );
  if (maxMessagesInContext !== undefined) {
    chatSettings.maxMessagesInContext = maxMessagesInContext;
  }

  const maxOutputTokens = parseOptionalNumberDraft(settings.maxOutputTokens, "Max output tokens", {
    integer: true,
    min: 1,
  });
  if (maxOutputTokens !== undefined) {
    chatSettings.maxOutputTokens = maxOutputTokens;
  }

  return chatSettings;
};

const getClientRequestId = (message: ChatMessage): string | undefined =>
  typeof message.metadata.clientRequestId === "string"
    ? message.metadata.clientRequestId
    : undefined;

const getReasoningContent = (message: ChatMessage): string =>
  typeof message.metadata.reasoningContent === "string" ? message.metadata.reasoningContent : "";

const isChatCancellationError = (reason: unknown): boolean => {
  if (!reason || typeof reason !== "object") {
    return false;
  }

  const candidate = reason as { message?: unknown };
  return (
    typeof candidate.message === "string" && candidate.message === CHAT_REQUEST_CANCELLED_MESSAGE
  );
};

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
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameSessionDraft, setRenameSessionDraft] = useState("");
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(models[0]?.id ?? "");
  const [sessionSettings, setSessionSettings] = useState<ChatSessionSettingsState>(
    createEmptyChatSessionSettingsState(),
  );
  const [settingsDraft, setSettingsDraft] = useState<ChatSessionSettingsState>(
    createEmptyChatSessionSettingsState(),
  );
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const selectedModelSessionIdRef = useRef<string | null>(null);
  const activeChatRequestIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const hadChatDeltaRef = useRef(false);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const renameSessionTarget = useMemo(
    () => sessions.find((session) => session.id === renameSessionId) ?? null,
    [sessions, renameSessionId],
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
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (sessionListRef.current?.contains(target)) {
        return;
      }

      setOpenSessionMenuId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenSessionMenuId(null);
        closeRenameSessionDialog(true);
        closeSettingsDialog();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
    if (!activeSessionId) {
      selectedModelSessionIdRef.current = null;
      return;
    }

    if (!activeSession) {
      return;
    }

    if (selectedModelSessionIdRef.current === activeSessionId) {
      return;
    }

    selectedModelSessionIdRef.current = activeSessionId;

    if (activeSession.modelId && models.some((model) => model.id === activeSession.modelId)) {
      setSelectedModelId(activeSession.modelId);
    }
  }, [activeSession, activeSessionId, models]);

  useEffect(() => {
    if (!activeSession) {
      setSessionSettings(createEmptyChatSessionSettingsState());
      setSettingsDraft(createEmptyChatSessionSettingsState());
      return;
    }

    const nextSettings = getChatSessionSettingsState(activeSession);
    setSessionSettings(nextSettings);
    setSettingsDraft(nextSettings);
  }, [activeSession]);

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

        if (event.clientRequestId === activeChatRequestIdRef.current) {
          hadChatDeltaRef.current = true;
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
    const normalizedSettings = normalizeChatSessionSettingsState(sessionSettings);
    let metadata: Record<string, unknown>;
    try {
      metadata = buildChatSessionMetadata(normalizedSettings);
    } catch (reason) {
      throw reason instanceof Error ? reason : new Error("Unable to validate chat settings.");
    }
    const next = await window.desktopApi.gateway.upsertChatSession({
      ...(activeSessionId ? { id: activeSessionId } : {}),
      ...(selectedModelId ? { modelId: selectedModelId } : {}),
      systemPrompt: normalizedSettings.systemPrompt,
      metadata: {
        ...(activeSession?.metadata ?? {}),
        chatSettings: metadata,
      },
    });
    startTransition(() => {
      setSessions((current) =>
        sortByUpdatedDesc([next, ...current.filter((item) => item.id !== next.id)]),
      );
      setActiveSessionId(next.id);
    });
    return next;
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

    setBusy(true);
    setError(null);
    const clientRequestId = createClientRequestId();
    activeChatRequestIdRef.current = clientRequestId;
    cancelRequestedRef.current = false;
    hadChatDeltaRef.current = false;

    let tempAssistant: ChatMessage | undefined;

    try {
      const session = await ensureSession();
      if (cancelRequestedRef.current) {
        throw new Error(CHAT_REQUEST_CANCELLED_MESSAGE);
      }

      setDraft("");
      setAttachments([]);

      const createdTempUser = createTempMessage(session.id, "user", messageContent);
      const createdTempAssistant = createTempMessage(session.id, "assistant", "", {
        clientRequestId,
      });
      tempAssistant = createdTempAssistant;
      setMessages((current) => [...current, createdTempUser, createdTempAssistant]);

      const result = await window.desktopApi.gateway.runChat({
        sessionId: session.id,
        model: selectedModelId,
        message: messageContent,
        clientRequestId,
      });

      setMessages((current) =>
        current.map((message) => {
          if (message.id === createdTempUser.id) {
            return result.userMessage;
          }
          if (message.id === createdTempAssistant.id) {
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
      const cancelled = cancelRequestedRef.current || isChatCancellationError(reason);
      const assistantMessageToRemove = tempAssistant;
      if (cancelled && assistantMessageToRemove && !hadChatDeltaRef.current) {
        setMessages((current) =>
          current.filter((message) => message.id !== assistantMessageToRemove.id),
        );
      } else if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "Unable to run chat.");
      }
    } finally {
      if (activeChatRequestIdRef.current === clientRequestId) {
        activeChatRequestIdRef.current = null;
      }
      cancelRequestedRef.current = false;
      hadChatDeltaRef.current = false;
      setBusy(false);
    }
  };

  const stopMessage = async () => {
    cancelRequestedRef.current = true;
    const requestId = activeChatRequestIdRef.current;
    if (!requestId) {
      return;
    }

    await window.desktopApi.gateway.cancelChat(requestId).catch(() => undefined);
  };

  const createSession = async () => {
    if (sessionActionBusy) {
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      const normalizedSettings = normalizeChatSessionSettingsState(sessionSettings);
      let metadata: Record<string, unknown>;
      try {
        metadata = buildChatSessionMetadata(normalizedSettings);
      } catch (reason) {
        throw reason instanceof Error ? reason : new Error("Unable to validate chat settings.");
      }
      const next = await window.desktopApi.gateway.upsertChatSession({
        modelId: selectedModelId || undefined,
        systemPrompt: normalizedSettings.systemPrompt,
        metadata: {
          chatSettings: metadata,
        },
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

  const openSettingsDialog = () => {
    if (sessionActionBusy) {
      return;
    }

    setSettingsDraft(sessionSettings);
    setSettingsModalOpen(true);
  };

  const closeSettingsDialog = () => {
    if (sessionActionBusy) {
      return;
    }

    setSettingsModalOpen(false);
  };

  const saveSettingsDialog = async () => {
    if (sessionActionBusy) {
      return;
    }

    const normalizedSettings = normalizeChatSessionSettingsState(settingsDraft);
    let metadata: Record<string, unknown>;
    try {
      metadata = buildChatSessionMetadata(normalizedSettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to validate chat settings.");
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      if (activeSessionId) {
        const next = await window.desktopApi.gateway.upsertChatSession({
          id: activeSessionId,
          ...(selectedModelId ? { modelId: selectedModelId } : {}),
          systemPrompt: normalizedSettings.systemPrompt,
          metadata: {
            ...(activeSession?.metadata ?? {}),
            chatSettings: metadata,
          },
        });
        startTransition(() => {
          setSessions((current) =>
            sortByUpdatedDesc([next, ...current.filter((item) => item.id !== next.id)]),
          );
        });
      }
      setSessionSettings(normalizedSettings);
      setSettingsModalOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save chat settings.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const openRenameSessionDialog = (session: ChatSession) => {
    if (sessionActionBusy) {
      return;
    }

    setOpenSessionMenuId(null);
    setRenameSessionId(session.id);
    setRenameSessionDraft(session.title ?? "Untitled chat");
  };

  const closeRenameSessionDialog = (force = false) => {
    if (sessionActionBusy && !force) {
      return;
    }

    setRenameSessionId(null);
    setRenameSessionDraft("");
  };

  const saveRenamedSession = async () => {
    if (!renameSessionTarget || sessionActionBusy) {
      return;
    }

    const normalizedTitle = normalizeSessionTitle(renameSessionDraft);
    if (normalizedTitle.length === 0) {
      setError("Session title cannot be empty.");
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      const next = await window.desktopApi.gateway.upsertChatSession({
        id: renameSessionTarget.id,
        title: normalizedTitle,
        ...(renameSessionTarget.modelId ? { modelId: renameSessionTarget.modelId } : {}),
        ...(renameSessionTarget.systemPrompt !== undefined
          ? { systemPrompt: renameSessionTarget.systemPrompt }
          : {}),
      });
      startTransition(() => {
        setSessions((current) =>
          sortByUpdatedDesc([next, ...current.filter((item) => item.id !== next.id)]),
        );
      });
      closeRenameSessionDialog(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to rename session.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const exportSession = async (session: ChatSession) => {
    if (sessionActionBusy) {
      return;
    }

    setSessionActionBusy(true);

    try {
      setError(null);
      const response = await window.desktopApi.gateway.listChatMessages(session.id);
      const fileName = `${formatSessionFileName(session.title || "chat-session", session.id)}-${
        session.updatedAt.slice(0, 10)
      }.json`;
      downloadJson(fileName, {
        exportedAt: new Date().toISOString(),
        session,
        messages: response.data,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to export session.");
    } finally {
      setSessionActionBusy(false);
    }
  };

  const deleteSession = async (session: ChatSession) => {
    if (sessionActionBusy) {
      return;
    }

    const deletingActiveSession = session.id === activeSessionId;
    const sessionLabel = session.title?.trim() || "Untitled chat";
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
      await window.desktopApi.gateway.deleteChatSession(session.id);
          const response = await window.desktopApi.gateway.listChatSessions();
          if (renameSessionTarget?.id === session.id) {
            closeRenameSessionDialog(true);
          }

      startTransition(() => {
        const sorted = sortByUpdatedDesc(response.data);
        setSessions(sorted);
        setActiveSessionId((current) => {
          if (current && sorted.some((candidate) => candidate.id === current)) {
            return current;
          }

          return sorted[0]?.id ?? null;
        });
        if (deletingActiveSession) {
          setMessages([]);
        }
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
            <h3>Chats</h3>
          </div>
          <button
            className="secondary-button"
            disabled={shellState.phase !== "connected" || busy || sessionActionBusy}
            onClick={() => void createSession()}
            type="button"
          >
            NEW
          </button>
        </div>
        <div className="model-list">
          {sessions.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>No saved sessions yet.</strong>
              <p>Send a prompt to start your first chat transcript.</p>
            </div>
          ) : (
            <div className="chat-session-items" ref={sessionListRef}>
              {sessions.map((session) => (
                <div className="chat-session-item" key={session.id}>
                  <button
                    className={
                      session.id === activeSessionId
                        ? "model-list-item model-list-item-active chat-session-select"
                        : "model-list-item chat-session-select"
                    }
                    disabled={shellState.phase !== "connected" || busy || sessionActionBusy}
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setOpenSessionMenuId(null);
                    }}
                    type="button"
                    >
                      <h4>{session.title ?? "Untitled chat"}</h4>
                    </button>
                  <div className="chat-session-menu-shell">
                    <button
                      aria-expanded={openSessionMenuId === session.id}
                      aria-haspopup="menu"
                      aria-label={`Session actions for ${session.title ?? "Untitled chat"}`}
                      className="session-menu-trigger"
                      disabled={shellState.phase !== "connected" || busy || sessionActionBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenSessionMenuId((current) =>
                          current === session.id ? null : session.id,
                        );
                      }}
                      type="button"
                    >
                      ...
                    </button>
                    {openSessionMenuId === session.id ? (
                      <div
                        className="session-menu-panel"
                        role="menu"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          className="session-menu-action"
                          onClick={() => {
                            setOpenSessionMenuId(null);
                            openRenameSessionDialog(session);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Rename
                        </button>
                        <button
                          className="session-menu-action"
                          onClick={() => {
                            setOpenSessionMenuId(null);
                            void exportSession(session);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Export
                        </button>
                        <button
                          className="session-menu-action session-menu-action-danger"
                          onClick={() => {
                            setOpenSessionMenuId(null);
                            void deleteSession(session);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </article>

      <article className="info-card chat-main-panel">
        <div className="chat-session-banner">
          <div className="chat-session-copy">
            <span className="section-label">{sessionStatusLabel}</span>
            <h4 className="chat-session-active-title">{activeSessionTitle}</h4>
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

        {renameSessionTarget ? (
          <div
            className="model-detail-modal-backdrop chat-rename-backdrop"
            onClick={() => closeRenameSessionDialog()}
            role="presentation"
          >
            <form
              aria-labelledby="chat-rename-modal-title"
              aria-modal="true"
              className="model-detail-modal chat-rename-modal"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void saveRenamedSession();
              }}
              role="dialog"
            >
              <div className="modal-shell-header">
                <div>
                  <span className="section-label">Rename session</span>
                  <h3 id="chat-rename-modal-title">Update the session title</h3>
                  <p>Choose a new label for this chat thread.</p>
                </div>
                <div className="modal-shell-actions">
                  <button
                    className="secondary-button"
                    onClick={() => closeRenameSessionDialog()}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <div className="modal-panel">
                <label className="field-stack">
                  <span className="section-label">Session name</span>
                  <input
                    autoFocus
                    className="text-input"
                    disabled={sessionActionBusy}
                    onChange={(event) => setRenameSessionDraft(event.target.value)}
                    placeholder="Untitled chat"
                    value={renameSessionDraft}
                  />
                </label>
                <div className="detail-actions">
                  <button
                    className="primary-button"
                    disabled={sessionActionBusy || renameSessionDraft.trim().length === 0}
                    type="submit"
                  >
                    {sessionActionBusy ? "Saving..." : "Rename"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : null}

        {settingsModalOpen ? (
          <div
            className="model-detail-modal-backdrop chat-settings-backdrop"
            onClick={() => closeSettingsDialog()}
            role="presentation"
          >
            <form
              aria-labelledby="chat-settings-modal-title"
              aria-modal="true"
              className="model-detail-modal chat-settings-modal"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void saveSettingsDialog();
              }}
              role="dialog"
            >
              <div className="modal-shell-header">
                <div>
                  <span className="section-label">Chat settings</span>
                  <h3 id="chat-settings-modal-title">Session configuration</h3>
                  <p>Store the system prompt and generation controls for this chat.</p>
                </div>
                <div className="modal-shell-actions">
                  <button
                    className="secondary-button"
                    onClick={() => closeSettingsDialog()}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <div className="modal-panel chat-settings-panel">
                <label className="field-stack">
                  <span className="section-label">System prompt</span>
                  <textarea
                    autoFocus
                    className="text-input"
                    disabled={sessionActionBusy}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        systemPrompt: event.target.value,
                      }))
                    }
                    placeholder="Optional system instruction"
                    rows={5}
                    value={settingsDraft.systemPrompt}
                  />
                </label>
                <div className="chat-settings-grid">
                  <label className="field-stack">
                    <span className="section-label">Temperature</span>
                    <input
                      className="text-input"
                      disabled={sessionActionBusy}
                      inputMode="decimal"
                      min={0}
                      max={2}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          temperature: event.target.value,
                        }))
                      }
                      placeholder="Model default"
                      step={0.1}
                      type="number"
                      value={settingsDraft.temperature}
                    />
                  </label>
                  <label className="field-stack">
                    <span className="section-label">Top P</span>
                    <input
                      className="text-input"
                      disabled={sessionActionBusy}
                      inputMode="decimal"
                      min={0}
                      max={1}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          topP: event.target.value,
                        }))
                      }
                      placeholder="Model default"
                      step={0.01}
                      type="number"
                      value={settingsDraft.topP}
                    />
                  </label>
                  <label className="field-stack">
                    <span className="section-label">Max messages in context</span>
                    <input
                      className="text-input"
                      disabled={sessionActionBusy}
                      inputMode="numeric"
                      min={1}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          maxMessagesInContext: event.target.value,
                        }))
                      }
                      placeholder="Unlimited"
                      step={1}
                      type="number"
                      value={settingsDraft.maxMessagesInContext}
                    />
                  </label>
                  <label className="field-stack">
                    <span className="section-label">Max output tokens</span>
                    <input
                      className="text-input"
                      disabled={sessionActionBusy}
                      inputMode="numeric"
                      min={1}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          maxOutputTokens: event.target.value,
                        }))
                      }
                      placeholder="Model default"
                      step={1}
                      type="number"
                      value={settingsDraft.maxOutputTokens}
                    />
                  </label>
                </div>
                <div className="detail-actions">
                  <button
                    className="primary-button"
                    disabled={sessionActionBusy}
                    type="submit"
                  >
                    {sessionActionBusy ? "Saving..." : "Save settings"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : null}

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
          <p className="chat-composer-note">
            {supportsVision
              ? "Add screenshots or photos to ground your prompt."
              : "Switch to a vision-capable model before attaching images."}
          </p>
          <div className="chat-composer-footer">
            <div className="chat-composer-actions">
              <button
                aria-label={busy ? "Stop generating response" : "Send message"}
                className={busy ? "secondary-button danger-button" : "primary-button"}
                disabled={
                  !busy &&
                  (shellState.phase !== "connected" ||
                    sessionActionBusy ||
                    !selectedModelId ||
                    (draft.trim().length === 0 && attachments.length === 0) ||
                    (attachments.length > 0 && !supportsVision))
                }
                onClick={() => void (busy ? stopMessage() : sendMessage())}
                type="button"
              >
                {busy ? "Stop" : "Send"}
              </button>
              <button
                className="secondary-button"
                disabled={busy || sessionActionBusy}
                onClick={openSettingsDialog}
                type="button"
              >
                Settings
              </button>
              <div className="chat-model-field">
                <select
                  aria-label="Model"
                  className="text-input chat-model-select"
                  onChange={(event) => setSelectedModelId(event.target.value)}
                  value={selectedModelId}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {formatModelLabel(model)}
                    </option>
                  ))}
                </select>
              </div>
              {error ? <span className="status-pill status-pill-negative">{error}</span> : null}
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
