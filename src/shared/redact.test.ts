import { describe, expect, it } from "vitest";
import { redactBody, redactHeaders, redactUrl, shouldRedact, type RedactConfig } from "./redact.js";

const EXTERNAL: RedactConfig = { mode: "external", trustedDomains: ["localhost", "127.0.0.1", "::1"] };
const ALL: RedactConfig = { ...EXTERNAL, mode: "all" };
const NONE: RedactConfig = { ...EXTERNAL, mode: "none" };

describe("redactUrl", () => {
  it("masks user:pass userinfo", () => {
    expect(redactUrl("https://alice:hunter2@api.example.com/x?y=1", EXTERNAL)).toBe(
      "https://[REDACTED]@api.example.com/x?y=1",
    );
  });

  it("masks user-only userinfo", () => {
    expect(redactUrl("https://alice@api.example.com/", EXTERNAL)).toBe("https://[REDACTED]@api.example.com/");
  });

  it("does not treat an @ in the path as userinfo", () => {
    const u = "https://api.example.com/users/@alice";
    expect(redactUrl(u, EXTERNAL)).toBe(u);
  });

  it("masks secret query param values and preserves the rest", () => {
    expect(
      redactUrl("https://api.example.com/v1/data?page=2&access_token=SECRET123&Api-Key=k9#frag", EXTERNAL),
    ).toBe("https://api.example.com/v1/data?page=2&access_token=[REDACTED]&Api-Key=[REDACTED]#frag");
  });

  it("masks secrets in the fragment (OAuth implicit flow)", () => {
    expect(redactUrl("https://app.example.com/cb#access_token=abc&state=s", EXTERNAL)).toBe(
      "https://app.example.com/cb#access_token=[REDACTED]&state=s",
    );
  });

  it("leaves non-secret params that merely contain a key name alone", () => {
    const u = "https://api.example.com/?not_password_hint=x&q=password";
    expect(redactUrl(u, EXTERNAL)).toBe(u);
  });

  it("does not redact trusted hosts in external mode", () => {
    const u = "http://user:pw@localhost:3000/api?access_token=SECRET123";
    expect(redactUrl(u, EXTERNAL)).toBe(u);
    expect(redactUrl("http://127.0.0.1/?password=p", EXTERNAL)).toBe("http://127.0.0.1/?password=p");
  });

  it("redacts trusted hosts in all mode", () => {
    expect(redactUrl("http://localhost/?password=p", ALL)).toBe("http://localhost/?password=[REDACTED]");
  });

  it("is a no-op in none mode", () => {
    const u = "https://alice:hunter2@api.example.com/?access_token=SECRET123";
    expect(redactUrl(u, NONE)).toBe(u);
  });

  it("does not throw on unparseable URLs and still redacts them", () => {
    const u = "not a url ?access_token=SECRET123 http://[bad";
    expect(() => redactUrl(u, EXTERNAL)).not.toThrow();
    expect(redactUrl(u, EXTERNAL)).not.toContain("SECRET123");
    expect(redactUrl("ht!tp://u:p@[::bad/?secret=s", EXTERNAL)).not.toContain("secret=s");
  });

  it("passes null/undefined through", () => {
    expect(redactUrl(null, EXTERNAL)).toBeNull();
    expect(redactUrl(undefined, EXTERNAL)).toBeUndefined();
  });
});

describe("shouldRedact", () => {
  it("treats a missing url as external", () => {
    expect(shouldRedact(null, EXTERNAL)).toBe(true);
    expect(shouldRedact(null, NONE)).toBe(false);
  });
});

describe("redactHeaders", () => {
  it("fully masks secret headers and URL-redacts referer/location", () => {
    const out = redactHeaders(
      {
        Authorization: "Bearer abcdefghijkl",
        Referer: "https://site.example.com/p?access_token=SECRET123",
        Location: "https://u:p@x.example.com/",
        Accept: "*/*",
      },
      "https://api.example.com/",
      EXTERNAL,
    );
    expect(out).toEqual({
      Authorization: "[REDACTED]",
      Referer: "https://site.example.com/p?access_token=[REDACTED]",
      Location: "https://[REDACTED]@x.example.com/",
      Accept: "*/*",
    });
  });
});

describe("redactBody", () => {
  it("keeps the existing JSON/form/bearer patterns", () => {
    const body = '{"password":"pw1"} api_key=k2&x=1 Authorization: Bearer abcdefghijkl';
    const out = redactBody(body, "https://api.example.com/", EXTERNAL)!;
    expect(out).toBe('{"password":"[REDACTED]"} api_key=[REDACTED]&x=1 Authorization: Bearer [REDACTED]');
  });

  it("masks inline URL credentials in free text", () => {
    expect(redactBody("GET https://bob:pw@cdn.example.com/a.js failed", null, EXTERNAL)).toBe(
      "GET https://[REDACTED]@cdn.example.com/a.js failed",
    );
  });
});
