"use strict";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3000";

function makeUrl(path) {
  return `${BASE_URL}${path}`;
}

async function request(path, options = {}) {
  const res = await fetch(makeUrl(path), options);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  const location = res.headers.get("location");

  let body = null;
  if (contentType.includes("application/json")) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } else {
    body = await res.text();
  }

  return {
    status: res.status,
    contentType,
    body,
    location
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJsonError(result, expectedStatus, expectedError, label) {
  assert(result.status === expectedStatus, `${label}: expected status ${expectedStatus}, got ${result.status}`);
  assert(result.contentType.includes("application/json"), `${label}: expected JSON response, got content-type '${result.contentType}'`);
  assert(result.body && typeof result.body === "object", `${label}: expected JSON object body`);
  assert(result.body.error === expectedError, `${label}: expected error '${expectedError}', got '${String(result.body.error)}'`);
}

async function run() {
  const checks = [
    {
      name: "health",
      run: async () => {
        const result = await request("/health", { method: "GET" });
        assert(result.status === 200, `health: expected status 200, got ${result.status}`);
        assert(result.contentType.includes("application/json"), `health: expected JSON response, got content-type '${result.contentType}'`);
        assert(result.body && result.body.status === "ok", `health: expected body.status to be 'ok'`);
      }
    },
    {
      name: "chat invalid shape",
      run: async () => {
        const result = await request("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: ["bad"],
            conversationId: "c_smoke_invalid"
          })
        });

        assertJsonError(result, 400, "Invalid chat request", "chat invalid shape");
      }
    },
    {
      name: "session close invalid flags",
      run: async () => {
        const result = await request("/session/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memory: "ok",
            flags: []
          })
        });

        assertJsonError(result, 400, "Invalid session close request", "session close invalid flags");
      }
    },
    {
      name: "admin login invalid payload",
      run: async () => {
        const result = await request("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: 123
          })
        });

        assertJsonError(result, 400, "Invalid admin login request", "admin login invalid payload");
      }
    },
    {
      name: "admin conversations requires auth",
      run: async () => {
        const result = await request("/api/admin/conversations", {
          method: "GET",
          redirect: "manual"
        });

        assert(result.status === 302, `admin conversations requires auth: expected status 302, got ${result.status}`);
        assert(typeof result.location === "string" && result.location.includes("/admin-login.html"), "admin conversations requires auth: expected redirect to /admin-login.html");
      }
    },
    {
      name: "admin messages requires auth",
      run: async () => {
        const result = await request("/api/admin/conversations/c_smoke/messages", {
          method: "GET",
          redirect: "manual"
        });

        assert(result.status === 302, `admin messages requires auth: expected status 302, got ${result.status}`);
        assert(typeof result.location === "string" && result.location.includes("/admin-login.html"), "admin messages requires auth: expected redirect to /admin-login.html");
      }
    },
    {
      name: "conversation title invalid id",
      run: async () => {
        const result = await request("/api/conversations/%20/title", { method: "GET" });
        assertJsonError(result, 400, "Conversation invalide", "conversation title invalid id");
      }
    },
    {
      name: "malformed json middleware",
      run: async () => {
        const result = await request("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{"
        });

        assertJsonError(result, 400, "Invalid JSON payload", "malformed json middleware");
      }
    },
    {
      name: "auth register invalid payload",
      run: async () => {
        const result = await request("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "not-an-email", password: 123 })
        });

        assert(result.status === 400, `auth register invalid payload: expected 400, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "auth register invalid payload: expected JSON");
        assert(result.body && typeof result.body.error === "string", "auth register invalid payload: expected error string");
      }
    },
    {
      name: "auth login wrong credentials",
      run: async () => {
        const result = await request("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "smoke_no_such_user@example.com", password: "wrongpassword" })
        });

        assert(result.status === 401, `auth login wrong credentials: expected 401, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "auth login wrong credentials: expected JSON");
        assert(result.body && typeof result.body.error === "string", "auth login wrong credentials: expected error string");
      }
    },
    {
      name: "auth session unauthenticated",
      run: async () => {
        const result = await request("/api/auth/session", { method: "GET" });

        assert(result.status === 200, `auth session unauthenticated: expected 200, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "auth session unauthenticated: expected JSON");
        assert(result.body && result.body.authenticated === false, "auth session unauthenticated: expected authenticated:false");
      }
    },
    {
      name: "premium capabilities unauthenticated",
      run: async () => {
        const result = await request("/api/premium/capabilities", { method: "GET" });

        assert(result.status === 200, `premium capabilities unauthenticated: expected 200, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "premium capabilities unauthenticated: expected JSON");
        assert(result.body && result.body.plan === "free", `premium capabilities unauthenticated: expected plan:free, got ${result.body?.plan}`);
      }
    },
    {
      name: "premium branches requires auth",
      run: async () => {
        const result = await request("/api/premium/branches", { method: "GET" });

        assert(result.status === 401, `premium branches requires auth: expected 401, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "premium branches requires auth: expected JSON");
      }
    },
    {
      name: "premium intersession memory requires auth",
      run: async () => {
        const result = await request("/api/premium/intersession-memory", { method: "GET" });

        assert(result.status === 401, `premium intersession memory requires auth: expected 401, got ${result.status}`);
        assert(result.contentType.includes("application/json"), "premium intersession memory requires auth: expected JSON");
      }
    }
  ];

  console.log(`[SMOKE] Base URL: ${BASE_URL}`);

  let passed = 0;
  for (const check of checks) {
    try {
      await check.run();
      passed += 1;
      console.log(`[PASS] ${check.name}`);
    } catch (err) {
      console.error(`[FAIL] ${check.name}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`[SMOKE] ${passed}/${checks.length} checks passed.`);
}

run().catch(err => {
  console.error(`[FAIL] smoke runtime: ${err.message}`);
  process.exitCode = 1;
});
