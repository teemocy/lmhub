import { describe, expect, it } from "vitest";

import { buildControlHeaders, resolveControlBearerToken } from "./gateway-manager";

describe("gateway manager auth helpers", () => {
  it("matches gateway control-token precedence", () => {
    expect(
      resolveControlBearerToken({
        GATEWAY_PUBLIC_BEARER_TOKEN: "public-fallback",
        LOCAL_LLM_HUB_AUTH_TOKEN: "shared-fallback",
      }),
    ).toBe("public-fallback");

    expect(
      resolveControlBearerToken({
        GATEWAY_CONTROL_BEARER_TOKEN: "control-env",
        GATEWAY_PUBLIC_BEARER_TOKEN: "public-fallback",
        LOCAL_LLM_HUB_AUTH_TOKEN: "shared-fallback",
      }),
    ).toBe("control-env");

    expect(
      resolveControlBearerToken({
        LOCAL_LLM_HUB_GATEWAY_CONTROL_BEARER_TOKEN: "control-override",
        GATEWAY_CONTROL_BEARER_TOKEN: "control-env",
        LOCAL_LLM_HUB_GATEWAY_PUBLIC_BEARER_TOKEN: "public-override",
        LOCAL_LLM_HUB_AUTH_TOKEN: "shared-fallback",
      }),
    ).toBe("control-override");
  });

  it("adds bearer auth without dropping existing request headers", () => {
    expect(
      buildControlHeaders("control-secret", {
        "content-type": "application/json",
      }),
    ).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer control-secret",
    });

    expect(buildControlHeaders(undefined)).toEqual({});
  });
});
