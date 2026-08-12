import { describe, expect, it } from "vitest";

import { mergeSdkHeaders } from "./header-merge";

// Regression cover for a 401 that looked exactly like a bad credential.
//
// The SDK's SSE transport folds `requestInit.headers` into its own header set
// and lower-cases every name. Overlaying our record on top with an object
// spread therefore produced both `authorization` and `Authorization`; `fetch`
// joins duplicates with a comma, so the server received
// `Bearer <token>, Bearer <token>` and rejected it. Nothing in the logs
// distinguished that from a genuinely expired token.
describe("mergeSdkHeaders", () => {
  it("replaces a lower-cased SDK header rather than duplicating it", () => {
    const merged = mergeSdkHeaders(
      new Headers({
        authorization: "Bearer sdk-copy",
        accept: "text/event-stream",
      }),
      { Authorization: "Bearer ours" },
    );

    expect(merged.get("authorization")).toBe("Bearer ours");
    expect(
      [...merged.keys()].filter((k) => k === "authorization"),
    ).toHaveLength(1);
    // A comma means two values survived and were joined — the actual bug.
    expect(merged.get("authorization")).not.toContain(",");
  });

  it("preserves SDK headers we do not override", () => {
    const merged = mergeSdkHeaders(
      new Headers({
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      }),
      { Authorization: "Bearer ours" },
    );

    expect(merged.get("accept")).toBe("text/event-stream");
    expect(merged.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(merged.get("authorization")).toBe("Bearer ours");
  });

  it("is insensitive to the casing of our own configured names", () => {
    for (const name of ["Authorization", "AUTHORIZATION", "authorization"]) {
      const merged = mergeSdkHeaders(new Headers({ authorization: "old" }), {
        [name]: "new",
      });
      expect(merged.get("authorization")).toBe("new");
    }
  });

  it("adds headers the SDK did not set", () => {
    const merged = mergeSdkHeaders(
      new Headers({ accept: "text/event-stream" }),
      {
        "X-Api-Key": "secret",
      },
    );

    expect(merged.get("x-api-key")).toBe("secret");
    expect(merged.get("accept")).toBe("text/event-stream");
  });

  it("tolerates absent SDK headers", () => {
    const merged = mergeSdkHeaders(undefined, { Authorization: "Bearer ours" });
    expect(merged.get("authorization")).toBe("Bearer ours");
  });

  it("accepts a plain object as the SDK header source", () => {
    const merged = mergeSdkHeaders(
      { accept: "text/event-stream" },
      { Authorization: "Bearer ours" },
    );
    expect(merged.get("accept")).toBe("text/event-stream");
    expect(merged.get("authorization")).toBe("Bearer ours");
  });
});
