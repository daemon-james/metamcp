import { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  DatabaseOAuthSession,
  OAuthSessionCreateInput,
  OAuthSessionUpdateInput,
} from "@repo/zod-types";
import { eq, sql } from "drizzle-orm";

import { db } from "../index";
import { oauthSessionsTable } from "../schema";

export class OAuthSessionsRepository {
  async findByMcpServerUuid(
    mcpServerUuid: string,
  ): Promise<DatabaseOAuthSession | undefined> {
    const [session] = await db
      .select()
      .from(oauthSessionsTable)
      .where(eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid))
      .limit(1);

    return session;
  }

  async create(input: OAuthSessionCreateInput): Promise<DatabaseOAuthSession> {
    const [createdSession] = await db
      .insert(oauthSessionsTable)
      .values({
        mcp_server_uuid: input.mcp_server_uuid,
        ...(input.client_information && {
          client_information: input.client_information,
        }),
        ...(input.tokens && { tokens: input.tokens }),
        ...(input.code_verifier && { code_verifier: input.code_verifier }),
        ...(input.expected_state && {
          expected_state: input.expected_state,
        }),
      })
      .returning();

    return createdSession;
  }

  async update(
    input: OAuthSessionUpdateInput,
  ): Promise<DatabaseOAuthSession | undefined> {
    const [updatedSession] = await db
      .update(oauthSessionsTable)
      .set({
        ...(input.client_information && {
          client_information: input.client_information,
        }),
        ...(input.tokens && {
          tokens: input.tokens,
          tokens_issued_at: sql`NOW()`,
        }),
        ...(input.code_verifier && { code_verifier: input.code_verifier }),
        ...(input.expected_state && {
          expected_state: input.expected_state,
        }),
        updated_at: sql`NOW()`,
      })
      .where(eq(oauthSessionsTable.mcp_server_uuid, input.mcp_server_uuid))
      .returning();

    return updatedSession;
  }

  // Dedicated clear path for stored credentials. The truthy-spread upsert
  // cannot write NULL (a `null` value is elided by the `&&` guard), so
  // dropping a rejected grant — the step that lets Connect start a new
  // authorize redirect — goes through this method. Returns the updated
  // row, or undefined if no row exists for the server.
  //
  // `client_information` is NOT NULL with a `{}` default, so 'client'
  // writes the empty object rather than NULL.
  async clearCredentials(
    mcpServerUuid: string,
    scope: "tokens" | "client" | "verifier" | "all",
  ): Promise<DatabaseOAuthSession | undefined> {
    const [updatedSession] = await db
      .update(oauthSessionsTable)
      .set({
        ...((scope === "tokens" || scope === "all") && {
          tokens: null,
          tokens_issued_at: null,
        }),
        ...((scope === "client" || scope === "all") && {
          // Column is NOT NULL with a `{}` default. The SDK type wants
          // client_id; an empty object is the registered-cleared state.
          client_information: {} as OAuthClientInformation,
        }),
        ...((scope === "verifier" || scope === "all") && {
          code_verifier: null,
        }),
        updated_at: sql`NOW()`,
      })
      .where(eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid))
      .returning();

    return updatedSession;
  }

  // Dedicated clear path for `expected_state`. The truthy-spread upsert
  // cannot write NULL through `input.expected_state` (a `null` value would
  // be elided by the `&&` guard), so the one-shot clear after a successful
  // token exchange goes through this method instead. Returns the updated
  // row, or undefined if no row exists for the server.
  async clearExpectedState(
    mcpServerUuid: string,
  ): Promise<DatabaseOAuthSession | undefined> {
    const [updatedSession] = await db
      .update(oauthSessionsTable)
      .set({
        expected_state: null,
        updated_at: sql`NOW()`,
      })
      .where(eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid))
      .returning();

    return updatedSession;
  }

  async upsert(input: OAuthSessionUpdateInput): Promise<DatabaseOAuthSession> {
    // Single-statement atomic upsert. Concurrent callers for the same
    // mcp_server_uuid resolve via ON CONFLICT instead of racing a
    // SELECT-then-INSERT, which previously crashed the loser with a
    // unique-constraint violation. Only fields present on `input` are written
    // so a partial update (e.g. tokens only) does not clear unrelated columns
    // such as code_verifier.
    //
    // `tokens_issued_at` is stamped here rather than by callers so every path
    // that writes tokens — authorization_code exchange, refresh_token grant,
    // manual upsert — records the access_token's true age. `updated_at` cannot
    // stand in for it: it also moves for code_verifier and expected_state
    // writes, which would make an hour-old token look freshly minted and
    // suppress the proactive refresh that depends on it.
    const [row] = await db
      .insert(oauthSessionsTable)
      .values({
        mcp_server_uuid: input.mcp_server_uuid,
        ...(input.client_information && {
          client_information: input.client_information,
        }),
        ...(input.tokens && {
          tokens: input.tokens,
          tokens_issued_at: sql`NOW()`,
        }),
        ...(input.code_verifier && { code_verifier: input.code_verifier }),
        ...(input.expected_state && { expected_state: input.expected_state }),
      })
      .onConflictDoUpdate({
        target: oauthSessionsTable.mcp_server_uuid,
        set: {
          ...(input.client_information && {
            client_information: input.client_information,
          }),
          ...(input.tokens && {
            tokens: input.tokens,
            tokens_issued_at: sql`NOW()`,
          }),
          ...(input.code_verifier && { code_verifier: input.code_verifier }),
          // `expected_state` was accepted by this method's input type and
          // forwarded by oauth.impl.ts, but never written. The column stayed
          // NULL, and exchangeToken reads NULL as "flow predates this column"
          // and skips validation, so the RFC 6749 10.12 CSRF check was off for
          // every flow. `clearExpectedState()` remains the only path that
          // writes NULL, since a truthy spread cannot.
          ...(input.expected_state && { expected_state: input.expected_state }),
          updated_at: sql`NOW()`,
        },
      })
      .returning();

    if (!row) {
      throw new Error("Failed to upsert OAuth session");
    }

    return row;
  }

  async deleteByMcpServerUuid(
    mcpServerUuid: string,
  ): Promise<DatabaseOAuthSession | undefined> {
    const [deletedSession] = await db
      .delete(oauthSessionsTable)
      .where(eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid))
      .returning();

    return deletedSession;
  }
}

export const oauthSessionsRepository = new OAuthSessionsRepository();
