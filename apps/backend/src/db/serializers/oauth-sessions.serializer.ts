import { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import { UpstreamTokenResponse } from "@repo/zod-types";

type DatabaseOAuthSession = {
  uuid: string;
  mcp_server_uuid: string;
  client_information: OAuthClientInformation | null;
  tokens: UpstreamTokenResponse | null;
  code_verifier: string | null;
  created_at: Date;
  updated_at: Date;
};

type SerializedOAuthSession = {
  uuid: string;
  mcp_server_uuid: string;
  client_information: OAuthClientInformation | null;
  tokens: UpstreamTokenResponse | null;
  code_verifier: string | null;
  created_at: string;
  updated_at: string;
};

export class OAuthSessionsSerializer {
  static serializeOAuthSession(
    dbSession: DatabaseOAuthSession,
  ): SerializedOAuthSession {
    return {
      uuid: dbSession.uuid,
      mcp_server_uuid: dbSession.mcp_server_uuid,
      // Clearing a registration writes `{}` (the column is NOT NULL).
      // Report that as no registration: `{}` fails the response schema's
      // required client_id, and the 500 made the page skip server-side
      // registration and call the provider from the browser instead.
      client_information: dbSession.client_information?.client_id
        ? dbSession.client_information
        : null,
      tokens: dbSession.tokens,
      code_verifier: dbSession.code_verifier,
      created_at: dbSession.created_at.toISOString(),
      updated_at: dbSession.updated_at.toISOString(),
    };
  }
}
