import { describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";

describe("Logger", () => {
  it("emits structured JSON with the recommended fields", () => {
    const lines: string[] = [];
    const logger = new Logger((line) => lines.push(line));
    logger.log({ eventType: "task.completed", taskId: "t1", duration: 42, result: "success" });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.eventType).toBe("task.completed");
    expect(parsed.taskId).toBe("t1");
    expect(parsed.duration).toBe(42);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("Public Proof E: redacts secret-shaped fields at any nesting depth", () => {
    const sink = vi.fn();
    const logger = new Logger(sink);
    logger.log({
      eventType: "integration.call",
      apiKey: "sk-live-should-never-appear", // secret-scan:allow (fake fixture value, not a real key)
      nested: { accessToken: "should-also-be-redacted", safeField: "ok" } // secret-scan:allow (fake fixture value)
    } as never);

    const line = sink.mock.calls[0]![0] as string;
    expect(line).not.toContain("sk-live-should-never-appear"); // secret-scan:allow (fake fixture value, not a real key)
    expect(line).not.toContain("should-also-be-redacted");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("ok"); // non-sensitive nested field is preserved
  });

  describe("P1 fix (6th independent review round): authentication/credential headers no longer leak through logging", () => {
    it("redacts an Authorization Bearer value", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        headers: { Authorization: "Bearer fake-token-should-not-appear" } // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-token-should-not-appear");
      expect(line).toContain("[REDACTED]");
    });

    it("redacts a Proxy-Authorization value", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        headers: { "Proxy-Authorization": "Basic fake-proxy-secret" } // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-proxy-secret");
      expect(line).toContain("[REDACTED]");
    });

    it("redacts Cookie and Set-Cookie values", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.response",
        headers: {
          Cookie: "sessionid=fake-cookie-value-should-not-appear", // secret-scan:allow (fake fixture value)
          "Set-Cookie": "sid=fake-set-cookie-value; HttpOnly" // secret-scan:allow (fake fixture value)
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-cookie-value-should-not-appear");
      expect(line).not.toContain("fake-set-cookie-value");
    });

    it("redacts session/sessionId fields", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "auth.check",
        sessionId: "fake-session-id-should-not-appear", // secret-scan:allow (fake fixture value)
        session: "fake-session-value" // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-session-id-should-not-appear");
      expect(line).not.toContain("fake-session-value");
    });

    it("redacts access-token and refresh-token fields in every separator style", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "oauth.refresh",
        "access-token": "fake-access-token-hyphen", // secret-scan:allow (fake fixture value)
        access_token: "fake-access-token-underscore", // secret-scan:allow (fake fixture value)
        "refresh-token": "fake-refresh-token-hyphen", // secret-scan:allow (fake fixture value)
        refresh_token: "fake-refresh-token-underscore" // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-access-token-hyphen");
      expect(line).not.toContain("fake-access-token-underscore");
      expect(line).not.toContain("fake-refresh-token-hyphen");
      expect(line).not.toContain("fake-refresh-token-underscore");
    });

    it("redacts api-key fields in every separator style, including x-api-key", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "integration.call",
        "api-key": "fake-api-key-hyphen", // secret-scan:allow (fake fixture value)
        api_key: "fake-api-key-underscore", // secret-scan:allow (fake fixture value)
        "x-api-key": "fake-x-api-key-value" // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-api-key-hyphen");
      expect(line).not.toContain("fake-api-key-underscore");
      expect(line).not.toContain("fake-x-api-key-value");
    });

    it("redacts nested headers inside a request-metadata object", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        requestMetadata: {
          url: "https://example.com/api",
          headers: { authorization: "Bearer fake-nested-token" } // secret-scan:allow (fake fixture value)
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-nested-token");
      expect(line).toContain("https://example.com/api"); // non-sensitive sibling field preserved
    });

    it("redacts mixed-case header names (AUTHORIZATION, Cookie, X-Api-Key)", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        AUTHORIZATION: "Bearer fake-uppercase-token", // secret-scan:allow (fake fixture value)
        Cookie: "fake-titlecase-cookie", // secret-scan:allow (fake fixture value)
        "X-Api-Key": "fake-titlecase-api-key" // secret-scan:allow (fake fixture value)
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-uppercase-token");
      expect(line).not.toContain("fake-titlecase-cookie");
      expect(line).not.toContain("fake-titlecase-api-key");
    });

    it("redacts arrays containing credential-bearing objects", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "batch.requests",
        requests: [
          { url: "https://a.example.com", headers: { Authorization: "Bearer fake-token-a" } }, // secret-scan:allow
          { url: "https://b.example.com", headers: { Cookie: "fake-cookie-b" } } // secret-scan:allow
        ]
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-token-a");
      expect(line).not.toContain("fake-cookie-b");
      expect(line).toContain("https://a.example.com");
      expect(line).toContain("https://b.example.com");
    });

    it("leaves non-sensitive values fully readable", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({ eventType: "task.completed", taskId: "t1", result: "success", duration: 12 });

      const line = sink.mock.calls[0]![0] as string;
      expect(line).toContain("task.completed");
      expect(line).toContain("t1");
      expect(line).toContain("success");
      expect(line).toContain("12");
      expect(line).not.toContain("[REDACTED]");
    });

    it("does not mutate the caller's original logging payload", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      const original = {
        eventType: "http.request",
        headers: { Authorization: "Bearer fake-token-should-stay-in-original" }, // secret-scan:allow
        items: [{ Cookie: "fake-cookie-should-stay-in-original" }] // secret-scan:allow
      };
      const originalHeadersRef = original.headers;
      const originalItemsRef = original.items;

      logger.log(original as never);

      // The caller's own object graph must be completely untouched.
      expect(original.headers).toBe(originalHeadersRef);
      expect(original.items).toBe(originalItemsRef);
      expect(original.headers.Authorization).toBe("Bearer fake-token-should-stay-in-original");
      expect((original.items[0] as { Cookie: string }).Cookie).toBe("fake-cookie-should-stay-in-original");
    });

    it("cross-cutting audit fix: a field literally named '__proto__' is preserved, not silently dropped (same bug class as the FileCache finding)", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      // Simulates logging a raw JSON.parse'd payload that happens to
      // contain a "__proto__" field as a genuine own property.
      const payload = JSON.parse('{"eventType":"raw.payload","__proto__":"not-a-secret-value"}');
      logger.log(payload as never);

      const line = sink.mock.calls[0]![0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.__proto__).toBe("not-a-secret-value");
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype); // no pollution occurred
    });

    it("existing logging behavior (recommended fields, timestamp) remains intact", () => {
      const lines: string[] = [];
      const logger = new Logger((line) => lines.push(line));
      logger.log({ eventType: "task.completed", taskId: "t1", duration: 42, result: "success" });

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.eventType).toBe("task.completed");
      expect(parsed.taskId).toBe("t1");
      expect(parsed.duration).toBe(42);
      expect(typeof parsed.timestamp).toBe("string");
    });
  });

  describe("P1 fix (8th independent review round): serialization hooks (toJSON) cannot bypass redaction", () => {
    it("a nested enumerable toJSON() cannot reintroduce a redacted Authorization value", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        headers: {
          Authorization: "Bearer fake-token-should-stay-redacted", // secret-scan:allow (fake fixture value)
          toJSON() {
            return { Authorization: "fixture-serialization-credential" }; // secret-scan:allow (fake fixture value)
          }
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-token-should-stay-redacted");
      expect(line).not.toContain("fixture-serialization-credential");
      expect(line).toContain("[REDACTED]");
    });

    it("toJSON() cannot reintroduce Cookie/session credentials", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.response",
        session: {
          sessionId: "fake-session-should-stay-redacted", // secret-scan:allow (fake fixture value)
          toJSON() {
            return { Cookie: "fixture-cookie-from-serialization-hook" }; // secret-scan:allow (fake fixture value)
          }
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-session-should-stay-redacted");
      expect(line).not.toContain("fixture-cookie-from-serialization-hook");
    });

    it("a serialization hook buried deep inside nested structure cannot bypass recursive redaction", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "deep.nesting",
        level1: {
          level2: {
            level3: {
              apiKey: "fake-deep-key-should-stay-redacted", // secret-scan:allow (fake fixture value)
              toJSON() {
                return { apiKey: "fixture-deep-serialization-key" }; // secret-scan:allow (fake fixture value)
              }
            }
          }
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-deep-key-should-stay-redacted");
      expect(line).not.toContain("fixture-deep-serialization-key");
    });

    it("arrays containing objects with toJSON() remain safe", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "batch.requests",
        requests: [
          {
            url: "https://a.example.com",
            headers: { Authorization: "Bearer fake-array-token" }, // secret-scan:allow
            toJSON() {
              return { headers: { Authorization: "fixture-array-serialization-token" } }; // secret-scan:allow
            }
          }
        ]
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("fake-array-token");
      expect(line).not.toContain("fixture-array-serialization-token");
      expect(line).toContain("https://a.example.com");
    });

    it("does not mutate the caller's original payload, including the toJSON function itself", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      const toJsonFn = function toJSON() {
        return { Authorization: "fixture-untouched" }; // secret-scan:allow
      };
      const original = {
        eventType: "http.request",
        headers: { Authorization: "Bearer fake-should-remain-in-original", toJSON: toJsonFn } // secret-scan:allow
      };

      logger.log(original as never);

      expect(original.headers.Authorization).toBe("Bearer fake-should-remain-in-original");
      expect(original.headers.toJSON).toBe(toJsonFn);
    });

    it("plaintext fixture credentials from a toJSON() hook never reach the sink verbatim", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "auth.check",
        credentials: {
          toJSON() {
            return { password: "should-never-appear-anywhere" }; // secret-scan:allow (fake fixture value)
          }
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      expect(line).not.toContain("should-never-appear-anywhere");
    });

    it("normal non-sensitive logging is unaffected by the function-stripping fix", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({ eventType: "task.completed", taskId: "t1", result: "success", duration: 12 });

      const line = sink.mock.calls[0]![0] as string;
      expect(line).toContain("task.completed");
      expect(line).toContain("t1");
      expect(line).not.toContain("[REDACTED]");
    });

    it("prototype-key preservation (round 6 fix) still works alongside the toJSON fix", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      const payload = JSON.parse('{"eventType":"raw.payload","__proto__":"not-a-secret-value"}');
      logger.log(payload as never);

      const line = sink.mock.calls[0]![0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.__proto__).toBe("not-a-secret-value");
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    });

    it("stripping a toJSON function does not introduce prototype pollution", () => {
      const sink = vi.fn();
      const logger = new Logger(sink);
      logger.log({
        eventType: "http.request",
        headers: {
          toJSON() {
            return {};
          }
        }
      } as never);

      const line = sink.mock.calls[0]![0] as string;
      const parsed = JSON.parse(line);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect(parsed.headers.toJSON).toBe("[FUNCTION_REMOVED]");
    });
  });

  describe(
    "P1 fix (28th independent review round, finding 5, 'redact credentials embedded inside string values'): " +
      "secret-shaped CONTENT inside an ordinary string value is redacted even though the field's own KEY name " +
      "is completely innocuous",
    () => {
      it("BLOCKER regression, exact reproduction: an 'Authorization: Bearer ...' header embedded inside a plain 'description' field", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description: "curl -H 'Authorization: Bearer fake-embedded-token-should-not-appear' https://api.example.com" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-embedded-token-should-not-appear");
        expect(line).toContain("[REDACTED]");
        // The surrounding, genuinely useful log text is preserved.
        expect(line).toContain("curl");
        expect(line).toContain("https://api.example.com");
      });

      it("redacts a bare 'Bearer <token>' with no preceding 'Authorization:' label, inside an innocuous field", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "debug",
          message: "sent header value Bearer fake-bare-token-should-not-appear to upstream" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-bare-token-should-not-appear");
        expect(line).toContain("Bearer [REDACTED]");
      });

      it("redacts provider/API credentials embedded in a URL's userinfo section, preserving the username", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "outbound.call",
          targetUrl: "https://svc-account:fake-embedded-password-should-not-appear@internal.example.com/api" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-embedded-password-should-not-appear");
        expect(line).toContain("[REDACTED]");
        expect(line).toContain("svc-account"); // username preserved — often not itself secret
        expect(line).toContain("internal.example.com/api");
      });

      it.each([
        ["password=", "password=fake-embedded-secret-should-not-appear"], // secret-scan:allow (fake fixture value)
        ["api_key:", "api_key: fake-embedded-secret-should-not-appear"], // secret-scan:allow (fake fixture value)
        ["api-key=", "api-key=fake-embedded-secret-should-not-appear"], // secret-scan:allow (fake fixture value)
        ["secret=", "secret=fake-embedded-secret-should-not-appear"] // secret-scan:allow (fake fixture value)
      ])("redacts a common secret assignment form embedded in prose text: %s", (_label, snippet) => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "config.dump",
          rawConfigLine: `export SOME_VAR=1; ${snippet}; export OTHER=2`
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-embedded-secret-should-not-appear");
        expect(line).toContain("[REDACTED]");
        // Surrounding, non-secret text is preserved.
        expect(line).toContain("SOME_VAR=1");
        expect(line).toContain("OTHER=2");
      });

      it("redacts secret-shaped content nested inside an array of strings", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "batch.request",
          requestLines: ["GET /health", "Authorization: Bearer fake-nested-array-token-should-not-appear"] // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-nested-array-token-should-not-appear");
        expect(line).toContain("[REDACTED]");
        expect(line).toContain("GET /health");
      });

      it("does not redact ordinary, non-secret-shaped log text (no false positives on normal messages)", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "task.completed",
          description: "Bootstrap finished for project 'shop-1' in 240ms with no errors."
        });

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("[REDACTED]");
        expect(line).toContain("Bootstrap finished for project 'shop-1' in 240ms with no errors.");
      });

      it("a field whose KEY is already sensitive still gets the STRONGER full-value redaction (no regression — key-based redaction is not weakened to pattern-only)", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          apiKey: "just some innocuous-looking string with no recognizable secret pattern inside it" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("innocuous-looking string");
        expect(line).toContain("[REDACTED]");
      });
    }
  );

  describe(
    "P1 fix (29th independent review round, finding 4, 'redact complete credential-bearing header values'): " +
      "multi-component/multi-segment header values are redacted through their COMPLETE value boundary, not just " +
      "the first one or two tokens",
    () => {
      it("BLOCKER regression, exact reproduction: 'Cookie: a=abc; sessionid=SECRET' fully redacts the trailing session id, not just the first pair", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description: "Cookie: a=abc; sessionid=SECRET" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("SECRET");
        expect(line).not.toContain("a=abc");
        expect(line).toContain("[REDACTED]");
      });

      it("redacts a 'Set-Cookie: ...' response header through its complete value", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.response",
          description: "Set-Cookie: session=fake-session-value-should-not-appear; Path=/; HttpOnly" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-session-value-should-not-appear");
        expect(line).toContain("[REDACTED]");
      });

      it("BLOCKER regression, exact reproduction: 'Authorization: Digest ...' redacts every comma-separated sub-field, including the trailing response value", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description:
            'Authorization: Digest username="alice", realm="example.com", nonce="xyz", response="fake-digest-response-should-not-appear"' // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-digest-response-should-not-appear");
        expect(line).not.toContain("xyz");
        expect(line).toContain("[REDACTED]");
      });

      it("BLOCKER regression, exact reproduction: 'Authorization: AWS ...' redacts the trailing Signature component, not just the scheme/Credential prefix", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description:
            "Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20220830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=fake-signature-should-not-appear" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-signature-should-not-appear");
        expect(line).not.toContain("AKIAIOSFODNN7EXAMPLE"); // secret-scan:allow (AWS's own well-known documentation-example key id, not a real secret)
        expect(line).toContain("[REDACTED]");
      });

      it("redacts a 'Proxy-Authorization: ...' header through its complete value", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description: "Proxy-Authorization: Basic fake-proxy-credential-should-not-appear" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-proxy-credential-should-not-appear");
        expect(line).toContain("[REDACTED]");
      });

      it("no regression: the 28th round's shell-quoted 'curl -H ...' embedded-header case still preserves trailing, unrelated log text after the closing quote", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description: "curl -H 'Authorization: Bearer fake-embedded-token-should-not-appear' https://api.example.com" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).not.toContain("fake-embedded-token-should-not-appear");
        expect(line).toContain("[REDACTED]");
        expect(line).toContain("curl");
        expect(line).toContain("https://api.example.com");
      });

      it("preserves useful non-secret logging text that appears BEFORE a redacted header on the same line", () => {
        const sink = vi.fn();
        const logger = new Logger(sink);
        logger.log({
          eventType: "http.request",
          description: "incoming request headers dump: Cookie: session=fake-value-should-not-appear" // secret-scan:allow (fake fixture value)
        } as never);

        const line = sink.mock.calls[0]![0] as string;
        expect(line).toContain("incoming request headers dump:");
        expect(line).not.toContain("fake-value-should-not-appear");
        expect(line).toContain("[REDACTED]");
      });
    }
  );
});
