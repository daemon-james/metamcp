// Per-request OAuth bearer injection for the upstream HTTP transports. Kept
// out of `client.ts` so it can be unit tested without importing the
// repositories, which open the database at import time.

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { getCurrentAccessToken } from "../oauth-upstream/access-token-store";
import { mergeSdkHeaders } from "./header-merge";

export interface OAuthFetchOptions {
  serverUuid: string;
  /**
   * The token the connection was built with. Used only until the token store
   * holds one for this server.
   */
  initialAccessToken: string;
  /**
   * Called when the upstream rejects a request with 401. Receives the token
   * that was rejected and returns a different one to retry with, or
   * `undefined` when there is nothing better to offer.
   */
  recover: (rejectedAccessToken: string) => Promise<string | undefined>;
  /** Defaults to the global `fetch`, resolved at call time. */
  baseFetch?: FetchLike;
}

/**
 * A `fetch` for the SDK transports that sends the server's current access
 * token on every request rather than the one the transport was created with.
 *
 * Fixing `Authorization` in `requestInit.headers` at creation meant a pooled
 * connection kept presenting its original token after the hourly refresh had
 * replaced it, and every request on it failed with 401 until something
 * happened to rebuild it. Reading the token per request lets a long-lived
 * connection follow the refreshes.
 *
 * On a 401 the request is retried once with whatever `recover` returns, so
 * a token that expired or was rotated between refreshes costs the caller a
 * second round trip instead of a failure. A request whose body cannot be
 * replayed is not retried.
 */
export function createOAuthFetch(options: OAuthFetchOptions): FetchLike {
  const send = (
    url: string | URL,
    init: RequestInit | undefined,
    token: string,
  ) =>
    (options.baseFetch ?? fetch)(url, {
      ...init,
      // See mergeSdkHeaders: the SDK's headers carry Accept, the session id
      // and the protocol version, and must not be replaced or naively spread.
      headers: mergeSdkHeaders(init?.headers, {
        Authorization: `Bearer ${token}`,
      }),
    });

  return async (url, init) => {
    const token =
      getCurrentAccessToken(options.serverUuid) ?? options.initialAccessToken;
    const response = await send(url, init, token);
    if (response.status !== 401 || !isReplayable(init?.body)) {
      return response;
    }

    let retryToken: string | undefined;
    try {
      retryToken = await options.recover(token);
    } catch {
      retryToken = undefined;
    }
    if (!retryToken || retryToken === token) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    return send(url, init, retryToken);
  };
}

// The SDK sends JSON-RPC messages as strings and GETs without a body; a
// stream would already be consumed by the first attempt.
const isReplayable = (body: RequestInit["body"]): boolean =>
  body === undefined || body === null || typeof body === "string";
