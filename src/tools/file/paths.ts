import { realpathSync } from "node:fs";
import { resolve, dirname, basename, sep } from "node:path";

/**
 * Resolve a path to its real (symlink-free) absolute form.
 *
 * If the path already exists, this is just `realpathSync`. If it does not exist
 * yet (e.g. a file `write` is about to create), the nearest existing ancestor is
 * resolved and the remaining components appended, so a not-yet-existing path
 * inside the project is still recognised as inside the project. If resolution
 * fails entirely, the lexical resolution is returned as a safe fallback.
 */
export function realResolveSync(p: string): string {
  const lexical = resolve(p);
  try {
    return realpathSync(lexical);
  } catch {
    // Walk up to the nearest existing ancestor and append the remainder.
    let dir = dirname(lexical);
    let remainder = basename(lexical);
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = realpathSync(dir);
        return realDir + sep + remainder;
      } catch {
        remainder = `${basename(dir)}${sep}${remainder}`;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return lexical;
  }
}

/**
 * True if the resolved (symlink-followed) path escapes the project root.
 *
 * Resolving symlinks is essential: a symlink whose own path is inside the project
 * but whose target is outside (e.g. `./link -> ~/.ssh/authorized_keys`) would
 * otherwise pass a purely lexical containment check and let a write/edit land
 * outside the project with no confirmation prompt (GHSA-5v6f-c99j-7m36).
 */
export function escapesCwdSync(p: string, cwd: string = process.cwd()): boolean {
  // Resolve both sides so a symlinked cwd (e.g. macOS /var -> /private/var) and
  // a symlinked target are compared consistently.
  const real = realResolveSync(p);
  const realCwd = realResolveSync(cwd);
  return !(real === realCwd || real.startsWith(realCwd + sep));
}

// Basenames that are unambiguously secrets regardless of where they live. Reading
// these should always require confirmation so a prompt-injected agent cannot
// silently slurp them up and exfiltrate them. Public key files (`*.pub`) are
// intentionally excluded.
const CREDENTIAL_BASENAME_RE = /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc)$/;

/**
 * True if the path points at an obvious credential/secret file by basename
 * (e.g. `.env`, `id_rsa`, `.npmrc`). Used to force a confirmation even when the
 * file lives inside the project, so reading it is never silent.
 */
export function isCredentialPath(p: string): boolean {
  return CREDENTIAL_BASENAME_RE.test(basename(resolve(p)));
}
