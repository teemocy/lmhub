import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildControlHeaders,
  resolveControlBearerToken,
  resolveGatewayLaunchCommand,
  waitForChildExit,
} from "./gateway-manager";

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
      buildControlHeaders("control-secret", "authorization", {
        "content-type": "application/json",
      }),
    ).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer control-secret",
    });

    expect(buildControlHeaders("control-secret", "x-api-key")).toEqual({
      "x-api-key": "control-secret",
    });

    expect(buildControlHeaders("control-secret", "api-key")).toEqual({
      "api-key": "control-secret",
    });

    expect(buildControlHeaders(undefined, "authorization")).toEqual({});
  });

  it("prefers an explicit node executable for development launches", () => {
    expect(
      resolveGatewayLaunchCommand(
        "development",
        {
          LOCAL_LLM_HUB_GATEWAY_NODE_EXECUTABLE: "/opt/homebrew/bin/node",
        },
        "/Applications/Electron.app/Contents/MacOS/Electron",
      ),
    ).toEqual({
      command: "/opt/homebrew/bin/node",
      useElectronRunAsNode: false,
    });
  });

  it("keeps using the current executable outside development when no override applies", () => {
    expect(
      resolveGatewayLaunchCommand(
        "packaged",
        {
          LOCAL_LLM_HUB_GATEWAY_NODE_EXECUTABLE: "/opt/homebrew/bin/node",
        },
        "/Applications/Electron.app/Contents/MacOS/Electron",
      ),
    ).toEqual({
      command: "/Applications/Electron.app/Contents/MacOS/Electron",
      useElectronRunAsNode: true,
    });
  });

  it("waits for a child process to exit within the graceful timeout", async () => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      "setTimeout(() => process.exit(0), 50);",
    ]);

    await expect(waitForChildExit(child, 500)).resolves.toBe(true);
  });

  it("returns false when a child process stays alive past the timeout", async () => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      "setTimeout(() => process.exit(0), 500);",
    ]);

    await expect(waitForChildExit(child, 25)).resolves.toBe(false);

    child.kill("SIGTERM");
    await waitForChildExit(child, 500);
  });
});
