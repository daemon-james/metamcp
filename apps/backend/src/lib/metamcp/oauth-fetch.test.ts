import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCurrentAccessTokens,
  setCurrentAccessToken,
} from "../oauth-upstream/access-token-store";
import { createOAuthFetch } from "./oauth-fetch";

const SERVER_UUID = "00000000-0000-0000-0000-0000000000dd";
const URL_ = "https://mcp.example.com/mcp";

const authorizationOf = (init?: RequestInit): string | null =>
  new Headers(init?.headers).get("authorization");

// Answers every request with `status`, recording the Authorization header it
// was sent.
const recordingFetch = (statuses: number[] = []) => {
  const seen: Array<string | null> = [];
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    seen.push(authorizationOf(init));
    const status = statuses.shift() ?? 202;
    return new Response(status === 202 ? null : "{}", { status });
  });
  return { fetchFn, seen };
};

describe("createOAuthFetch", () => {
  beforeEach(() => {
    clearCurrentAccessTokens();
  });

  it("sends the token it was created with until a newer one is known", async () => {
    const { fetchFn, seen } = recordingFetch();
    const oauthFetch = createOAuthFetch({
      serverUuid: SERVER_UUID,
      initialAccessToken: "A",
      recover: vi.fn(),
      baseFetch: fetchFn,
    });

    await oauthFetch(URL_, { method: "POST", body: "{}" });
    setCurrentAccessToken(SERVER_UUID, "B");
    await oauthFetch(URL_, { method: "POST", body: "{}" });

    expect(seen).toEqual(["Bearer A", "Bearer B"]);
  });

  it("moves an SDK transport created with token A on to token B after a refresh", async () => {
    const { fetchFn } = recordingFetch();
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      requestInit: { headers: { "X-Custom": "kept" } },
      fetch: createOAuthFetch({
        serverUuid: SERVER_UUID,
        initialAccessToken: "A",
        recover: vi.fn(),
        baseFetch: fetchFn,
      }),
    });
    await transport.start();

    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
    };
    await transport.send(notification);
    setCurrentAccessToken(SERVER_UUID, "B");
    await transport.send(notification);

    // The initialized notification also opens the GET stream; only the
    // POSTs are in order.
    const posts = fetchFn.mock.calls
      .map(([, init]) => init)
      .filter((init) => init?.method === "POST");
    expect(posts.map(authorizationOf)).toEqual(["Bearer A", "Bearer B"]);
    // The SDK's own headers and the configured ones survive the injection.
    const headers = new Headers(posts[1]?.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("kept");
    await transport.close();
  });

  it("retries a rejected request once with the recovered token", async () => {
    const { fetchFn, seen } = recordingFetch([401, 200]);
    const recover = vi.fn().mockResolvedValue("B");
    const oauthFetch = createOAuthFetch({
      serverUuid: SERVER_UUID,
      initialAccessToken: "A",
      recover,
      baseFetch: fetchFn,
    });

    const response = await oauthFetch(URL_, { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(recover).toHaveBeenCalledExactlyOnceWith("A");
    expect(seen).toEqual(["Bearer A", "Bearer B"]);
  });

  it("does not retry the retry", async () => {
    const { fetchFn } = recordingFetch([401, 401]);
    const recover = vi.fn().mockResolvedValue("B");
    const oauthFetch = createOAuthFetch({
      serverUuid: SERVER_UUID,
      initialAccessToken: "A",
      recover,
      baseFetch: fetchFn,
    });

    const response = await oauthFetch(URL_, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
  });

  it.each([
    ["nothing", () => Promise.resolve(undefined)],
    ["the rejected token", () => Promise.resolve("A")],
    ["an error", () => Promise.reject(new Error("refresh failed"))],
  ])(
    "returns the original 401 when recovery yields %s",
    async (_label, recoverImpl) => {
      const { fetchFn } = recordingFetch([401]);
      const oauthFetch = createOAuthFetch({
        serverUuid: SERVER_UUID,
        initialAccessToken: "A",
        recover: vi.fn(recoverImpl),
        baseFetch: fetchFn,
      });

      const response = await oauthFetch(URL_, { method: "POST", body: "{}" });

      expect(response.status).toBe(401);
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("leaves other failures alone", async () => {
    const { fetchFn } = recordingFetch([403]);
    const recover = vi.fn();
    const oauthFetch = createOAuthFetch({
      serverUuid: SERVER_UUID,
      initialAccessToken: "A",
      recover,
      baseFetch: fetchFn,
    });

    const response = await oauthFetch(URL_, { method: "POST", body: "{}" });

    expect(response.status).toBe(403);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not replay a body that has already been consumed", async () => {
    const { fetchFn } = recordingFetch([401]);
    const recover = vi.fn().mockResolvedValue("B");
    const oauthFetch = createOAuthFetch({
      serverUuid: SERVER_UUID,
      initialAccessToken: "A",
      recover,
      baseFetch: fetchFn,
    });

    const response = await oauthFetch(URL_, {
      method: "POST",
      body: new ReadableStream(),
    });

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });
});
