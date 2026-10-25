import { afterEach, describe, expect, it } from "bun:test";
import {
  checkLatest,
  newestInCatalog,
  parseModelName,
  pinnedDeploymentProblem,
  staleDeploymentProblem,
} from "../src/latest";
import { config, mockUpstreams, ok, provider, restoreFetch } from "./helpers";

afterEach(restoreFetch);

// OpenRouter catalog as listed on 2026-10-25 (ids and created timestamps).
const openRouterCatalog = [
  { id: "deepseek/deepseek-v4.1-flash-1017", created: 1792225624 },
  { id: "~deepseek/deepseek-flash-latest", created: 1789399150 },
  { id: "deepseek/deepseek-v4.1-flash", created: 1789021285 },
  { id: "deepseek/deepseek-v4.1-flash:batch", created: 1789021285 },
  { id: "deepseek/deepseek-v4-flash-vision-exp", created: 1787311563 },
  { id: "deepseek/deepseek-v4-pro-0813", created: 1786549364 },
  { id: "deepseek/deepseek-v4-flash-0731", created: 1785478908 },
  { id: "deepseek/deepseek-v4-pro", created: 1777000679 },
  { id: "deepseek/deepseek-v4-flash", created: 1777000666 },
];

describe("model names", () => {
  it("parses versions and snapshots and ignores variants", () => {
    expect(parseModelName("deepseek/deepseek-v4.1-flash-1017")).toEqual({ family: "flash", version: [4, 1], snapshot: "1017" });
    expect(parseModelName("deepseek-v4-pro")).toEqual({ family: "pro", version: [4], snapshot: undefined });
    expect(parseModelName("deepseek/deepseek-v4.1-flash-fast")).toBeUndefined();
    expect(parseModelName("deepseek/deepseek-v4.1-flash:batch")).toBeUndefined();
  });

  it("flags pinned snapshots but accepts undated names and latest aliases", () => {
    expect(pinnedDeploymentProblem({ provider: "or", model: "deepseek/deepseek-v4.1-flash-1017" })).toContain("pins snapshot 1017");
    expect(pinnedDeploymentProblem({ provider: "cc", model: "deepseek/deepseek-v4.1-flash" })).toBeUndefined();
    expect(pinnedDeploymentProblem({ provider: "or", model: "~deepseek/deepseek-flash-latest" })).toBeUndefined();
  });

  it("picks the newest snapshot by version, then by creation time", () => {
    expect(newestInCatalog(openRouterCatalog, "flash")?.id).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(newestInCatalog(openRouterCatalog, "pro")?.id).toBe("deepseek/deepseek-v4-pro-0813");
  });

  it("reports an undated deployment once the provider lists a newer version", () => {
    const deployment = { provider: "cc", model: "deepseek/deepseek-v4.1-flash" };
    const catalog = [{ id: "deepseek/deepseek-v4-flash" }, { id: "deepseek/deepseek-v4.1-flash" }];
    expect(staleDeploymentProblem(deployment, catalog)).toBeUndefined();
    expect(staleDeploymentProblem(deployment, [...catalog, { id: "deepseek/deepseek-v4.2-flash" }])).toContain("older than 'deepseek/deepseek-v4.2-flash'");
    expect(staleDeploymentProblem(deployment, [{ id: "deepseek/deepseek-v4-flash" }])).toContain("not in the provider's model list");
  });
});

describe("checkLatest", () => {
  const cfg = config([provider("cc"), provider("openrouter")], {
    "deepseek-flash": [
      { provider: "cc", model: "deepseek/deepseek-v4.1-flash" },
      { provider: "openrouter", model: "~deepseek/deepseek-flash-latest" },
    ],
  });

  function upstreams(served: string) {
    return mockUpstreams({
      cc: [ok({ data: [{ id: "deepseek/deepseek-v4.1-flash" }] })],
      openrouter: [(call) => (call.url.endsWith("/models") ? ok({ data: openRouterCatalog }) : ok({ model: served }))],
    });
  }

  it("passes when every deployment serves the newest model", async () => {
    upstreams("deepseek/deepseek-v4.1-flash-1017");
    expect(await checkLatest(cfg)).toEqual({
      ok: [
        "deepseek-flash: cc: deepseek/deepseek-v4.1-flash is the newest listed",
        "deepseek-flash: openrouter: ~deepseek/deepseek-flash-latest serves deepseek/deepseek-v4.1-flash-1017",
      ],
      problems: [],
    });
  });

  it("fails when the latest alias serves an older snapshot", async () => {
    upstreams("deepseek/deepseek-v4.1-flash");
    expect((await checkLatest(cfg)).problems).toEqual([
      "deepseek-flash: openrouter: '~deepseek/deepseek-flash-latest' served 'deepseek/deepseek-v4.1-flash', newest listed is 'deepseek/deepseek-v4.1-flash-1017'",
    ]);
  });

  it("reports a provider whose model list cannot be read", async () => {
    mockUpstreams({ cc: [ok({ error: "nope" })], openrouter: [ok({ data: openRouterCatalog })] });
    expect((await checkLatest(cfg)).problems[0]).toStartWith("deepseek-flash: cc: cannot list models (cc: HTTP 200");
  });
});
