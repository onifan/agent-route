"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-oauth-"));
process.env.AGENT_ROUTE_HOME = tempHome;
process.env.AGENT_ROUTE_DB = path.join(tempHome, "db", "data.sqlite");
process.env.AGENT_ROUTE_DISABLE_LOCAL_ENV = "1";

const oauthRuntime = require("./core/providers/oauth-runtime");
const providers = require("./core/providers");

async function testAuthorizeWithMeta() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "GET",
    provider: "gitlab",
    action: "authorize",
    searchParams: new URLSearchParams({
      redirect_uri: "http://localhost:20128/callback",
      clientId: "client-123",
      baseUrl: "https://gitlab.example.test"
    })
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.authUrl.includes("https://gitlab.example.test/oauth/authorize"));
  assert.ok(result.body.authUrl.includes("code_challenge="));
  assert.ok(result.body.codeVerifier);
  assert.ok(result.body.state);
  assert.equal(JSON.stringify(result.body).includes("secret"), false);
}

async function testAntigravityRequiresCustomClientConfig() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "GET",
    provider: "antigravity",
    action: "authorize",
    searchParams: new URLSearchParams({
      redirect_uri: "http://localhost:20128/callback"
    })
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "oauth_config_missing");
  assert.ok(result.body.missing.includes("clientId"));
  assert.ok(result.body.missing.includes("clientSecret"));
  assert.ok(result.body.error.includes("AGENT_ROUTE_OAUTH_ANTIGRAVITY"));
}

async function testAntigravityAuthorizeWithMetaConfig() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "GET",
    provider: "antigravity",
    action: "authorize",
    searchParams: new URLSearchParams({
      redirect_uri: "http://localhost:20128/callback",
      clientId: "antigravity-client-id"
    }),
    body: {
      meta: {
        clientSecret: "antigravity-client-secret"
      }
    }
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.authUrl.includes("https://accounts.google.com/o/oauth2/v2/auth"));
  assert.ok(result.body.authUrl.includes("client_id=antigravity-client-id"));
  assert.ok(result.body.authUrl.includes("cloud-platform"));
  assert.ok(result.body.authUrl.includes("experimentsandconfigs"));
  assert.ok(result.body.codeVerifier);
  assert.ok(result.body.state);
}

async function testGeminiCliRequiresClientSecretBeforeRedirect() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "GET",
    provider: "gemini-cli",
    action: "authorize",
    searchParams: new URLSearchParams({
      redirect_uri: "http://localhost:20128/callback"
    })
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "oauth_config_missing");
  assert.ok(result.body.missing.includes("clientSecret"));
  assert.ok(result.body.error.includes("AGENT_ROUTE_OAUTH_GEMINI_CLI"));
}

async function testExchangeStoresOnlySanitizedStatus() {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "access-token-secret",
        refresh_token: "refresh-token-secret",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "api read_user"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  try {
    const result = await oauthRuntime.handleOAuthRequest({
      method: "POST",
      provider: "gitlab",
      action: "exchange",
      body: {
        code: "auth-code",
        redirectUri: "http://localhost:20128/callback",
        codeVerifier: "verifier",
        meta: {
          baseUrl: "https://gitlab.example.test",
          clientId: "client-123"
        }
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    const serialized = JSON.stringify(result.body.providerSettings);
    assert.equal(serialized.includes("access-token-secret"), false);
    assert.equal(serialized.includes("refresh-token-secret"), false);

    const connection = providers.providerStatus().connections.find((item) => item.provider === "gitlab");
    assert.ok(connection);
    assert.equal(connection.hasOAuthToken, true);
    assert.equal(connection.oauthTokenType, "Bearer");
  } finally {
    global.fetch = originalFetch;
  }
}

async function testManualImportStoresOauthConnection() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "POST",
    provider: "kiro",
    action: "import",
    body: {
      refreshToken: "kiro-refresh-secret"
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const serialized = JSON.stringify(result.body.providerSettings);
  assert.equal(serialized.includes("kiro-refresh-secret"), false);
  const connection = providers.providerStatus().connections.find((item) => item.provider === "kiro");
  assert.ok(connection);
  assert.equal(connection.hasOAuthToken, true);
}

async function testAutoImportDoesNotReadLocalSecrets() {
  const result = await oauthRuntime.handleOAuthRequest({
    method: "GET",
    provider: "cursor",
    action: "auto-import"
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.found, false);
  assert.ok(result.body.error.includes("不会自动读取"));
}

(async () => {
  try {
    await testAuthorizeWithMeta();
    await testAntigravityRequiresCustomClientConfig();
    await testAntigravityAuthorizeWithMetaConfig();
    await testGeminiCliRequiresClientSecretBeforeRedirect();
    await testExchangeStoresOnlySanitizedStatus();
    await testManualImportStoresOauthConnection();
    await testAutoImportDoesNotReadLocalSecrets();
    console.log("provider-oauth-runtime tests passed");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
