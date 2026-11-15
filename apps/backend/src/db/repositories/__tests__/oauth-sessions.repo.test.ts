import type {
  OAuthClientInformation,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const valuesCalls: any[] = [];
const onConflictSetCalls: any[] = [];
const onConflictTargetCalls: any[] = [];
const updateSetCalls: any[] = [];

// In-memory store keyed by mcp_server_uuid that mimics
// `INSERT ... ON CONFLICT (mcp_server_uuid) DO UPDATE SET ...` semantics.
// Tests then assert both the persisted result AND the call shape passed
// to Drizzle, so we pin the conditional-spread behaviour directly.
const store = new Map<string, any>();

vi.mock("../../index", () => {
  return {
    db: {
      insert: () => ({
        values: (values: any) => {
          valuesCalls.push(values);
          return {
            onConflictDoUpdate: ({
              target,
              set,
            }: {
              target: unknown;
              set: any;
            }) => {
              onConflictTargetCalls.push(target);
              onConflictSetCalls.push(set);
              return {
                returning: async () => {
                  const key = values.mcp_server_uuid;
                  const now = new Date();
                  const existing = store.get(key);
                  if (existing) {
                    // ON CONFLICT DO UPDATE: merge only the keys present in `set`.
                    // Strip the sql`NOW()` updated_at because the fake can't
                    // execute SQL — overwrite with a Date instead.
                    const { updated_at: _ignored, ...applicable } = set;
                    const updated = {
                      ...existing,
                      ...applicable,
                      updated_at: now,
                    };
                    store.set(key, updated);
                    return [updated];
                  }
                  // Fresh insert: schema-defaulted columns are filled with
                  // their declared defaults (client_information => {}).
                  const row = {
                    uuid: `uuid-${store.size}`,
                    mcp_server_uuid: values.mcp_server_uuid,
                    client_information: values.client_information ?? {},
                    tokens: values.tokens ?? null,
                    code_verifier: values.code_verifier ?? null,
                    expected_state: values.expected_state ?? null,
                    created_at: now,
                    updated_at: now,
                  };
                  store.set(key, row);
                  return [row];
                },
              };
            },
          };
        },
      }),
      update: () => ({
        set: (set: any) => {
          updateSetCalls.push(set);
          return {
            where: () => ({
              returning: async () => {
                const key = [...store.keys()][0];
                if (!key) return [];
                const existing = store.get(key);
                const { updated_at: _ignored, ...applicable } = set;
                const updated = {
                  ...existing,
                  ...applicable,
                  updated_at: new Date(),
                };
                store.set(key, updated);
                return [updated];
              },
            }),
          };
        },
      }),
    },
  };
});

// Import AFTER vi.mock so the repo binds to the fake db.
const { OAuthSessionsRepository } = await import("../oauth-sessions.repo");

describe("OAuthSessionsRepository.upsert", () => {
  const repo = new OAuthSessionsRepository();
  const serverId = "00000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    store.clear();
    valuesCalls.length = 0;
    onConflictSetCalls.length = 0;
    onConflictTargetCalls.length = 0;
  });

  it("persists expected_state on insert and on conflict", async () => {
    // oauth.impl.ts forwards expected_state into this method and its own test
    // pins that forwarding. Nothing asserted the repo actually WROTE it, so it
    // was dropped here and the column stayed NULL. exchangeToken treats NULL as
    // "flow predates the column" and takes its back-compat bypass, which turns
    // the RFC 6749 10.12 CSRF check off silently for every flow.
    const fresh = await repo.upsert({
      mcp_server_uuid: serverId,
      expected_state: "state-one",
    });
    expect(fresh.expected_state).toBe("state-one");
    expect(valuesCalls[0].expected_state).toBe("state-one");

    const second = await repo.upsert({
      mcp_server_uuid: serverId,
      expected_state: "state-two",
    });
    expect(second.expected_state).toBe("state-two");
    expect(onConflictSetCalls[1].expected_state).toBe("state-two");
  });

  it("a partial upsert does not clear an existing expected_state", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      expected_state: "state-one",
    });
    const after = await repo.upsert({
      mcp_server_uuid: serverId,
      tokens: { access_token: "AT", token_type: "Bearer" } as OAuthTokens,
    });
    expect(after.expected_state).toBe("state-one");
    expect(onConflictSetCalls[1].expected_state).toBeUndefined();
  });

  it("uses a single ON CONFLICT statement (not check-then-insert)", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      client_information: { client_id: "client-A" } as OAuthClientInformation,
    });

    // Exactly one insert chain per call: this is what makes the upsert
    // atomic and removes the SELECT-then-INSERT race window.
    expect(valuesCalls).toHaveLength(1);
    expect(onConflictSetCalls).toHaveLength(1);
    expect(onConflictTargetCalls[0]).toBeDefined();
  });

  it("two sequential upserts produce a single row whose values reflect the last call", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      client_information: { client_id: "client-A" } as OAuthClientInformation,
    });
    const second = await repo.upsert({
      mcp_server_uuid: serverId,
      client_information: { client_id: "client-B" } as OAuthClientInformation,
    });

    expect(store.size).toBe(1);
    expect(second.client_information).toEqual({ client_id: "client-B" });
  });

  it("partial upsert with only tokens does not write code_verifier into the SET clause", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      tokens: { access_token: "tok", token_type: "Bearer" } as OAuthTokens,
    });

    const set = onConflictSetCalls[0];
    expect(set).toHaveProperty("tokens");
    expect(set).not.toHaveProperty("code_verifier");
    expect(set).not.toHaveProperty("client_information");
  });

  it("partial upsert with only code_verifier does not clear an existing tokens column", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      tokens: { access_token: "tok", token_type: "Bearer" } as OAuthTokens,
    });
    const second = await repo.upsert({
      mcp_server_uuid: serverId,
      code_verifier: "the-verifier",
    });

    expect(second.tokens).toEqual({
      access_token: "tok",
      token_type: "Bearer",
    });
    expect(second.code_verifier).toBe("the-verifier");

    // Second call's SET must NOT mention tokens — that's what would have
    // cleared the column if the conditional spread regressed.
    const setOnSecond = onConflictSetCalls[1];
    expect(setOnSecond).toHaveProperty("code_verifier");
    expect(setOnSecond).not.toHaveProperty("tokens");
    expect(setOnSecond).not.toHaveProperty("client_information");
  });

  it("partial upsert with only tokens does not clear an existing code_verifier", async () => {
    await repo.upsert({
      mcp_server_uuid: serverId,
      code_verifier: "the-verifier",
    });
    const second = await repo.upsert({
      mcp_server_uuid: serverId,
      tokens: { access_token: "tok", token_type: "Bearer" } as OAuthTokens,
    });

    expect(second.code_verifier).toBe("the-verifier");
    expect(second.tokens).toEqual({
      access_token: "tok",
      token_type: "Bearer",
    });
  });
});

describe("OAuthSessionsRepository.clearCredentials", () => {
  const repo = new OAuthSessionsRepository();
  const serverId = "00000000-0000-0000-0000-000000000001";

  beforeEach(async () => {
    store.clear();
    updateSetCalls.length = 0;
    await repo.upsert({
      mcp_server_uuid: serverId,
      client_information: { client_id: "client-A" } as OAuthClientInformation,
      tokens: { access_token: "dead", token_type: "Bearer" } as OAuthTokens,
      code_verifier: "pkce",
    });
  });

  it("nulls tokens and tokens_issued_at without touching client_information", async () => {
    const cleared = await repo.clearCredentials(serverId, "tokens");

    expect(cleared?.tokens).toBeNull();
    expect(cleared?.client_information).toEqual({ client_id: "client-A" });
    expect(cleared?.code_verifier).toBe("pkce");

    const set = updateSetCalls[0];
    expect(set).toMatchObject({ tokens: null, tokens_issued_at: null });
    expect(set).not.toHaveProperty("client_information");
    expect(set).not.toHaveProperty("code_verifier");
  });

  it("clears tokens, client, and verifier together for scope all", async () => {
    const cleared = await repo.clearCredentials(serverId, "all");

    expect(cleared?.tokens).toBeNull();
    expect(cleared?.client_information).toEqual({});
    expect(cleared?.code_verifier).toBeNull();
  });
});
