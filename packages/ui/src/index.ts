export const desktopShellNavigation = [
  { id: "models", label: "Models" },
  { id: "chat", label: "Chat" },
  { id: "downloads", label: "Downloads" },
  { id: "dashboard", label: "Dashboard" },
  { id: "settings", label: "Settings" },
] as const;

export const designTokens = {
  color: {
    canvas: "#f8f7f2",
    panel: "#ffffff",
    ink: "#111827",
    accent: "#115e59",
    muted: "#6b7280",
  },
  radius: {
    panel: 18,
    pill: 999,
  },
  spacing: {
    page: 24,
    panel: 20,
  },
} as const;
