import { describe, expect, it } from "vitest";
import {
  isCredentialBasename,
  isCredentialPath,
  isSensitiveSegment,
} from "./credential-denylist.js";

describe("isCredentialBasename", () => {
  it("matches the unified credential basenames (case-insensitive)", () => {
    for (const name of [
      ".env",
      ".ENV",
      ".env.local",
      ".env.production",
      ".netrc",
      ".npmrc",
      ".pgpass",
      ".git-credentials",
      "credentials",
      "id_rsa",
      "id_rsa.pub",
      "id_ed25519",
      "id_ecdsa",
      "id_ecdsa.pub",
      "id_dsa",
      "server.pem",
      "access.key",
      "cert.p12",
      "store.pfx",
      "release.keystore",
      "deepseek-api-key.txt",
    ]) {
      expect(isCredentialBasename(name)).toBe(true);
    }
  });

  it("allows the .env.example template (centralized allow-exception)", () => {
    expect(isCredentialBasename(".env.example")).toBe(false);
    expect(isCredentialBasename(".ENV.EXAMPLE")).toBe(false);
  });

  it("does NOT match ordinary source files that merely contain the words", () => {
    for (const name of [
      "credentials.ts",
      "credentials.json",
      "credentials.service.ts",
      "id_generator.ts",
      "id_map.ts",
      "apiKey.ts",
      "keychain.ts",
      "monkey.ts",
      "readme.md",
      ".environment", // not `.env.`
      "envkey.ts",
    ]) {
      expect(isCredentialBasename(name)).toBe(false);
    }
  });
});

describe("isSensitiveSegment", () => {
  it("matches credential directories, case-insensitive", () => {
    expect(isSensitiveSegment(".ssh")).toBe(true);
    expect(isSensitiveSegment(".SSH")).toBe(true);
    expect(isSensitiveSegment(".aws")).toBe(true);
    expect(isSensitiveSegment(".gnupg")).toBe(true);
    expect(isSensitiveSegment("src")).toBe(false);
    expect(isSensitiveSegment(".sshconfig")).toBe(false);
  });
});

describe("isCredentialPath", () => {
  it("catches a credential basename anywhere in a raw path", () => {
    expect(isCredentialPath("config/id_rsa")).toBe(true);
    expect(isCredentialPath("keys\\server.pem")).toBe(true);
    expect(isCredentialPath("a/b/.npmrc")).toBe(true);
  });

  it("catches a sensitive DIRECTORY segment even when the file is innocent", () => {
    // The `.ssh/config` gap the classifier had — `config` is not a credential
    // basename, but `.ssh` is a sensitive segment.
    expect(isCredentialPath(".ssh/config")).toBe(true);
    expect(isCredentialPath("home/.aws/config")).toBe(true);
    expect(isCredentialPath(".gnupg/secring.gpg")).toBe(true);
  });

  it("does not flag ordinary paths", () => {
    expect(isCredentialPath("src/main.ts")).toBe(false);
    expect(isCredentialPath("packages/tools/credentials.ts")).toBe(false);
    expect(isCredentialPath(".env.example")).toBe(false);
    expect(isCredentialPath("README.md")).toBe(false);
  });
});
