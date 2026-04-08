import type {
  ChatMessage,
  OpenAiMessageContentPart,
} from "@localhub/shared-contracts";

type ChatContent = ChatMessage["content"];

type DescribedChatContent = {
  text: string;
  imageCount: number;
};

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();
const EAST_ASIAN_TOKEN_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

const isTextPart = (
  part: OpenAiMessageContentPart,
): part is Extract<OpenAiMessageContentPart, { type: "text" }> => part.type === "text";

const isImagePart = (
  part: OpenAiMessageContentPart,
): part is Extract<OpenAiMessageContentPart, { type: "image_url" }> =>
  part.type === "image_url";

export function describeChatContent(content: ChatContent): DescribedChatContent {
  if (typeof content === "string") {
    return {
      text: normalizeText(content),
      imageCount: 0,
    };
  }

  if (!Array.isArray(content)) {
    return {
      text: "",
      imageCount: 0,
    };
  }

  const text = content
    .filter(isTextPart)
    .map((part) => normalizeText(part.text))
    .filter((value) => value.length > 0)
    .join(" ");

  return {
    text,
    imageCount: content.filter(isImagePart).length,
  };
}

export function chatContentHasImages(content: ChatContent): boolean {
  return describeChatContent(content).imageCount > 0;
}

export function formatChatContentSummary(content: ChatContent): string {
  const { text, imageCount } = describeChatContent(content);

  if (text.length > 0 && imageCount > 0) {
    return `${text} • ${imageCount} image${imageCount === 1 ? "" : "s"}`;
  }

  if (text.length > 0) {
    return text;
  }

  if (imageCount > 0) {
    return `${imageCount} image${imageCount === 1 ? "" : "s"}`;
  }

  return "";
}

export function estimateTextTokens(value: string | string[]): number {
  const text = Array.isArray(value) ? value.join(" ") : value;
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return 1;
  }

  const eastAsianChars = normalized.match(EAST_ASIAN_TOKEN_REGEX) ?? [];
  const remainingText = normalized.replace(EAST_ASIAN_TOKEN_REGEX, "");
  const remainingChars = [...remainingText.replace(/\s+/g, "")].length;

  return Math.max(1, eastAsianChars.length + Math.ceil(remainingChars / 4));
}

export function countChatContentTokens(content: ChatContent): number {
  const summary = formatChatContentSummary(content);
  return estimateTextTokens(summary);
}

export function createChatSessionTitle(content: ChatContent): string {
  const { text, imageCount } = describeChatContent(content);
  if (text.length === 0 && imageCount > 0) {
    return "Image prompt";
  }

  const summary = formatChatContentSummary(content);
  if (summary.length === 0) {
    return "Chat prompt";
  }

  return summary.length <= 56 ? summary : `${summary.slice(0, 53).trimEnd()}...`;
}
