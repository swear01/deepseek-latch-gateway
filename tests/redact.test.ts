import { expect, it } from "bun:test";
import { redactCredentials, upstreamSnippet } from "../src/redact";
import { provider } from "./helpers";

const p = provider("cc", { apiKey: "sk-live-0123456789abcdef", extraHeaders: { "X-Secret": "header-secret-value" } });

it("removes the provider key, header secrets, bearer tokens and key-shaped values", () => {
  const out = redactCredentials(
    'key sk-live-0123456789abcdef header header-secret-value auth Bearer abc.def other sk-another1234567',
    p,
  );
  for (const secret of ["sk-live-0123456789abcdef", "header-secret-value", "abc.def", "sk-another1234567"]) {
    expect(out).not.toContain(secret);
  }
  expect(out).toContain("[redacted]");
});

it("flattens control characters and caps the length", () => {
  expect(redactCredentials("a\nb\u2028c", p)).toBe("a b c");
  expect(redactCredentials("x".repeat(600), p)).toHaveLength(512);
  expect(upstreamSnippet("y".repeat(100), p, 10)).toBe("y".repeat(10));
});
