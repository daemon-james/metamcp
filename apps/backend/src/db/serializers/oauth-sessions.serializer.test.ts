import { describe, expect, it } from "vitest";

import { OAuthSessionsSerializer } from "./oauth-sessions.serializer";

const base = {
  uuid: "00000000-0000-4000-8000-000000000001",
  mcp_server_uuid: "00000000-0000-4000-8000-000000000002",
  tokens: null,
  code_verifier: null,
  created_at: new Date("2026-11-16T00:00:00Z"),
  updated_at: new Date("2026-11-16T00:00:00Z"),
};

describe("OAuthSessionsSerializer", () => {
  it("reports a cleared registration ({}) as none", () => {
    const out = OAuthSessionsSerializer.serializeOAuthSession({
      ...base,
      client_information: {} as never,
    });
    expect(out.client_information).toBeNull();
  });

  it("keeps a registered client", () => {
    const out = OAuthSessionsSerializer.serializeOAuthSession({
      ...base,
      client_information: { client_id: "abc" },
    });
    expect(out.client_information).toEqual({ client_id: "abc" });
  });
});
