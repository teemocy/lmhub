import { gatewayEventTypeSchema } from "@localhub/shared-contracts";
import { designTokens, desktopShellNavigation } from "@localhub/ui";

export const rendererShellSections = desktopShellNavigation.map((section) => section.id);
export const rendererEventTypes = gatewayEventTypeSchema.options;
export const rendererDesignTokens = designTokens;
