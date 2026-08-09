import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { escapesCwdSync, isCredentialPath, realResolveSync } from "./paths.js";

let project: string;
let outside: string;

beforeEach(async () => {
  // realpath so the tmp dirs match what realResolveSync returns on hosts where
  // the system temp is itself a symlink (e.g. macOS /var -> /private/var).
  project = await realpath(await mkdtemp(join(tmpdir(), "opencli-paths-proj-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "opencli-paths-out-")));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("realResolveSync", () => {
  it("resolves an existing regular path", async () => {
    await writeFile(join(project, "a.txt"), "x");
    expect(realResolveSync(join(project, "a.txt"))).toBe(join(project, "a.txt"));
  });

  it("follows a symlink to its real target", async () => {
    const target = join(outside, "secret");
    await writeFile(target, "x");
    const link = join(project, "link");
    await symlink(target, link);
    expect(realResolveSync(link)).toBe(target);
  });

  it("resolves the nearest existing ancestor for a not-yet-existing path", async () => {
    // project exists; the deeper path does not yet — should still resolve inside project.
    const deep = join(project, "newdir", "newfile.txt");
    const resolved = realResolveSync(deep);
    expect(resolved.startsWith(project)).toBe(true);
    expect(resolved.endsWith(join("newdir", "newfile.txt"))).toBe(true);
  });
});

describe("escapesCwdSync", () => {
  it("returns false for a path inside cwd", async () => {
    await writeFile(join(project, "src.ts"), "x");
    expect(escapesCwdSync(join(project, "src.ts"), project)).toBe(false);
  });

  it("returns true for a path outside cwd", async () => {
    await writeFile(join(outside, "etc.txt"), "x");
    expect(escapesCwdSync(join(outside, "etc.txt"), project)).toBe(true);
  });

  it("returns true when a symlink inside cwd points outside cwd (regression for GHSA-5v6f)", async () => {
    const target = join(outside, "authorized_keys");
    await writeFile(target, "x");
    const link = join(project, "notes"); // link path is inside project...
    await symlink(target, link);
    // ...but the lexical check alone would say "inside" — symlink resolution must catch it.
    expect(escapesCwdSync(link, project)).toBe(true);
  });

  it("returns false for a not-yet-existing path inside cwd (write creating a new file)", () => {
    expect(escapesCwdSync(join(project, "brandnew.ts"), project)).toBe(false);
  });

  it("returns true for a not-yet-existing path that would resolve outside cwd", async () => {
    // A symlink dir inside project pointing outside, then a new file under it.
    const linkDir = join(project, "outsidelink");
    await symlink(outside, linkDir);
    expect(escapesCwdSync(join(linkDir, "newfile"), project)).toBe(true);
  });
});

describe("isCredentialPath", () => {
  it("flags .env and variant files", () => {
    expect(isCredentialPath(".env")).toBe(true);
    expect(isCredentialPath(join(project, ".env.local"))).toBe(true);
  });

  it("flags SSH private keys but not public keys", () => {
    expect(isCredentialPath(join(project, "id_rsa"))).toBe(true);
    expect(isCredentialPath(join(project, "id_ed25519"))).toBe(true);
    expect(isCredentialPath(join(project, "id_rsa.pub"))).toBe(false);
  });

  it("flags .npmrc and .pypirc", () => {
    expect(isCredentialPath(join(project, ".npmrc"))).toBe(true);
    expect(isCredentialPath(join(project, ".pypirc"))).toBe(true);
  });

  it("flags credentials/.netrc/kubeconfig and *.pem/*.key (GHSA-5v6f)", () => {
    expect(isCredentialPath(join(project, "credentials"))).toBe(true);
    expect(isCredentialPath(join(project, ".netrc"))).toBe(true);
    expect(isCredentialPath(join(project, ".git-credentials"))).toBe(true);
    expect(isCredentialPath(join(project, ".envrc"))).toBe(true);
    expect(isCredentialPath(join(project, "kubeconfig"))).toBe(true);
    expect(isCredentialPath(join(project, "server.pem"))).toBe(true);
    expect(isCredentialPath(join(project, "tls.key"))).toBe(true);
  });

  it("does not flag regular source files", () => {
    expect(isCredentialPath(join(project, "src", "index.ts"))).toBe(false);
    expect(isCredentialPath(join(project, "README.md"))).toBe(false);
  });
});
