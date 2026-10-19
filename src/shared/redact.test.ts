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

  it("masks URL-only secret names (token, id_token, jwt, auth, session, sig) case-insensitively", () => {
    expect(
      redactUrl(
        "https://x.example.com/a?Token=t1&id_token=t2&refresh_token=t3&JWT=t4&auth=t5&session=t6&sessionid=t7&session_id=t8&sig=t9&signature=t10&q=1",
        EXTERNAL,
      ),
    ).toBe(
      "https://x.example.com/a?Token=[REDACTED]&id_token=[REDACTED]&refresh_token=[REDACTED]&JWT=[REDACTED]&auth=[REDACTED]&session=[REDACTED]&sessionid=[REDACTED]&session_id=[REDACTED]&sig=[REDACTED]&signature=[REDACTED]&q=1",
    );
  });

  it("masks an AWS SigV4 presigned S3 URL's credential params", () => {
    const u =
      "https://bucket.s3.amazonaws.com/obj.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261019%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261019T000000Z&X-Amz-Expires=3600&X-Amz-Security-Token=FQoGZXIvYXdzEXAMPLE&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456";
    expect(redactUrl(u, EXTERNAL)).toBe(
      "https://bucket.s3.amazonaws.com/obj.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[REDACTED]&X-Amz-Date=20261019T000000Z&X-Amz-Expires=3600&X-Amz-Security-Token=[REDACTED]&X-Amz-SignedHeaders=host&X-Amz-Signature=[REDACTED]",
    );
  });

  it("masks GCS V4 signed-URL params", () => {
    expect(
      redactUrl("https://storage.googleapis.com/b/o?X-Goog-Credential=svc%40p.iam&X-Goog-Expires=60&X-Goog-Signature=0a1b2c", EXTERNAL),
    ).toBe("https://storage.googleapis.com/b/o?X-Goog-Credential=[REDACTED]&X-Goog-Expires=60&X-Goog-Signature=[REDACTED]");
  });

  it("masks a Google API ?key=AIza… param", () => {
    expect(redactUrl("https://maps.googleapis.com/maps/api/js?key=AIzaSyEXAMPLE123&libraries=places", EXTERNAL)).toBe(
      "https://maps.googleapis.com/maps/api/js?key=[REDACTED]&libraries=places",
    );
  });

  it("masks an OAuth code but keeps state (and lookalike names such as country_code)", () => {
    expect(redactUrl("https://app.example.com/cb?code=4%2F0AbCdEf&state=xyz&country_code=US", EXTERNAL)).toBe(
      "https://app.example.com/cb?code=[REDACTED]&state=xyz&country_code=US",
    );
  });

  it("stops a path matrix-param value at the next path segment / query", () => {
    expect(redactUrl("https://h.example.com/p;secret=x/more?q=1", EXTERNAL)).toBe(
      "https://h.example.com/p;secret=[REDACTED]/more?q=1",
    );
    expect(redactUrl("https://h.example.com/p;jsessionid=1;session=ABC?q=1", EXTERNAL)).toBe(
      "https://h.example.com/p;jsessionid=1;session=[REDACTED]?q=1",
    );
  });

  it("fully redacts a query value containing `/` (e.g. base64)", () => {
    const out = redactUrl("https://h.example.com/p?sig=ab/cd+ef/gh==&q=1", EXTERNAL);
    expect(out).toBe("https://h.example.com/p?sig=[REDACTED]&q=1");
    expect(out).not.toContain("cd+ef");
  });

  it("leaves a URL with nothing secret byte-identical", () => {
    const u = "https://shop.example.com/cart;view=list/items?page=2&sort=price&keyword=shoes&tokens=3#top";
    expect(redactUrl(u, EXTERNAL)).toBe(u);
  });

  it("is idempotent", () => {
    for (const u of [
      "https://alice:pw@h.example.com/p;secret=x/more?token=a/b&code=c#access_token=d&state=s",
      "https://bucket.s3.amazonaws.com/o?X-Amz-Credential=A%2FB&X-Amz-Signature=sig",
      "not a url ?access_token=SECRET123 http://[bad",
    ]) {
      const once = redactUrl(u, EXTERNAL);
      expect(redactUrl(once, EXTERNAL)).toBe(once);
    }
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

  it("redacts id_token/jwt in bodies but keeps URL-only short names (code/key/token) intact there", () => {
    const body = '{"id_token":"t1","jwt":"t2","code":404,"key":"name","token":"visible"} code=abc&key=v';
    expect(redactBody(body, "https://api.example.com/", EXTERNAL)).toBe(
      '{"id_token":"[REDACTED]","jwt":"[REDACTED]","code":404,"key":"name","token":"visible"} code=abc&key=v',
    );
  });

  it("masks inline URL credentials in free text", () => {
    expect(redactBody("GET https://bob:pw@cdn.example.com/a.js failed", null, EXTERNAL)).toBe(
      "GET https://[REDACTED]@cdn.example.com/a.js failed",
    );
  });
});
