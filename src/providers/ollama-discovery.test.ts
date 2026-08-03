import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  discoverOllamaModels,
  getOllamaModels,
  clearOllamaCache,
  findOllamaModel,
  toolSupportWarning,
  toOllamaApiRoot,
  type OllamaModel,
} from "./ollama-discovery.js";

const BASE_URL = "http://localhost:11434/v1";

/** Verbatim shape returned by Ollama 0.32.5 /api/tags. */
const REAL_TAGS_RESPONSE = {
  models: [
    {
      name: "qwen2.5-coder:14b",
      model: "qwen2.5-coder:14b",
      details: {
        family: "qwen2",
        parameter_size: "14.8B",
        context_length: 32768,
        embedding_length: 5120,
      },
      capabilities: ["completion", "tools", "insert"],
    },
  ],
};

function mockFetch(impl: () => Promise<unknown> | unknown) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

beforeEach(() => {
  clearOllamaCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearOllamaCache();
});

describe("toOllamaApiRoot", () => {
  it("strips the OpenAI-compat /v1 suffix, since /api/tags lives at the server root", () => {
    expect(toOllamaApiRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(toOllamaApiRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });

  it("leaves a root URL untouched", () => {
    expect(toOllamaApiRoot("http://localhost:11434")).toBe("http://localhost:11434");
  });
});

describe("discoverOllamaModels", () => {
  it("parses context length and capabilities from a real /api/tags payload", async () => {
    mockFetch(() => ({ ok: true, json: async () => REAL_TAGS_RESPONSE }));

    const models = await discoverOllamaModels(BASE_URL);
    expect(models).toEqual([
      {
        name: "qwen2.5-coder:14b",
        contextWindow: 32768,
        capabilities: ["completion", "tools", "insert"],
      },
    ]);
  });

  it("requests /api/tags at the server root", async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => REAL_TAGS_RESPONSE }));
    vi.stubGlobal("fetch", spy);

    await discoverOllamaModels(BASE_URL);
    expect(spy).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.anything());
  });

  it("returns empty when Ollama is not running", async () => {
    mockFetch(() => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    expect(await discoverOllamaModels(BASE_URL)).toEqual([]);
  });

  it("returns empty on a non-200 response", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }));
    expect(await discoverOllamaModels(BASE_URL)).toEqual([]);
  });

  it("returns empty on malformed JSON", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token");
      },
    }));
    expect(await discoverOllamaModels(BASE_URL)).toEqual([]);
  });

  it("returns empty when the body has no models array", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ notModels: [] }) }));
    expect(await discoverOllamaModels(BASE_URL)).toEqual([]);
  });

  it("leaves contextWindow undefined when the field is missing", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ models: [{ model: "foo:latest", capabilities: ["completion"] }] }),
    }));

    const models = await discoverOllamaModels(BASE_URL);
    expect(models[0].contextWindow).toBeUndefined();
    expect(models[0].name).toBe("foo:latest");
  });

  it("skips entries with no usable name", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ models: [{ details: {} }] }) }));
    expect(await discoverOllamaModels(BASE_URL)).toEqual([]);
  });
});

describe("getOllamaModels caching", () => {
  it("queries once and serves subsequent calls from cache", async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => REAL_TAGS_RESPONSE }));
    vi.stubGlobal("fetch", spy);

    await getOllamaModels(BASE_URL);
    await getOllamaModels(BASE_URL);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed discovery, so a late-starting Ollama still gets picked up", async () => {
    const spy = vi.fn(() => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", spy);

    await getOllamaModels(BASE_URL);
    await getOllamaModels(BASE_URL);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("findOllamaModel", () => {
  const models: OllamaModel[] = [
    { name: "qwen2.5-coder:14b", contextWindow: 32768, capabilities: ["tools"] },
    { name: "llama3.3:latest", contextWindow: 131072, capabilities: ["completion"] },
  ];

  it("matches exactly", () => {
    expect(findOllamaModel(models, "qwen2.5-coder:14b")?.contextWindow).toBe(32768);
  });

  it("tolerates an omitted :latest tag", () => {
    expect(findOllamaModel(models, "llama3.3")?.contextWindow).toBe(131072);
  });

  it("falls back to matching the base name before the tag", () => {
    expect(findOllamaModel(models, "qwen2.5-coder")?.contextWindow).toBe(32768);
  });

  it("returns undefined for a model that is not installed", () => {
    expect(findOllamaModel(models, "mistral")).toBeUndefined();
  });
});

describe("toolSupportWarning", () => {
  it("stays silent for a tool-capable model", () => {
    const models: OllamaModel[] = [
      { name: "qwen2.5-coder:14b", contextWindow: 32768, capabilities: ["completion", "tools"] },
    ];
    expect(toolSupportWarning(models, "qwen2.5-coder:14b")).toBeUndefined();
  });

  it("warns when the model cannot call tools", () => {
    const models: OllamaModel[] = [
      { name: "llama3.3:latest", contextWindow: 131072, capabilities: ["completion"] },
    ];
    const warning = toolSupportWarning(models, "llama3.3");
    expect(warning).toContain("does not advertise tool-calling support");
    expect(warning).toContain("llama3.3");
  });

  it("stays silent for an unknown model — absence of evidence is not evidence of absence", () => {
    expect(toolSupportWarning([], "anything")).toBeUndefined();
  });

  it("stays silent when capabilities are unreported", () => {
    const models: OllamaModel[] = [{ name: "old:1b", capabilities: [] }];
    expect(toolSupportWarning(models, "old:1b")).toBeUndefined();
  });
});
