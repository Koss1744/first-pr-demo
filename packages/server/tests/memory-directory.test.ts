import { describe, expect, it } from "vitest";
import { InMemoryDirectory } from "../src/directory/memory-directory.js";

describe("InMemoryDirectory", () => {
  const directory = new InMemoryDirectory([
    { username: "jdoe", displayName: "Jane Doe", active: true, password: "correct-horse" },
    { username: "disabled.user", displayName: "Disabled User", active: false, password: "whatever" },
  ]);

  it("looks up an existing user case-insensitively", async () => {
    expect(await directory.lookupUser("JDOE")).toEqual({ username: "jdoe", displayName: "Jane Doe", active: true });
  });

  it("does not leak the password field via lookupUser", async () => {
    const user = await directory.lookupUser("jdoe");
    expect(user).not.toHaveProperty("password");
  });

  it("returns null for an unknown user", async () => {
    expect(await directory.lookupUser("nobody")).toBeNull();
  });

  it("verifies correct credentials for an active user", async () => {
    expect(await directory.verifyCredentials("jdoe", "correct-horse")).toBe(true);
  });

  it("rejects incorrect credentials", async () => {
    expect(await directory.verifyCredentials("jdoe", "wrong")).toBe(false);
  });

  it("rejects credentials for a disabled user even if the password is correct", async () => {
    expect(await directory.verifyCredentials("disabled.user", "whatever")).toBe(false);
  });

  it("rejects credentials for an unknown user", async () => {
    expect(await directory.verifyCredentials("nobody", "x")).toBe(false);
  });

  it("addUser makes a new user visible to subsequent lookups", async () => {
    const dir = new InMemoryDirectory();
    expect(await dir.lookupUser("newperson")).toBeNull();
    dir.addUser({ username: "newperson", displayName: "New Person", active: true });
    expect(await dir.lookupUser("newperson")).toEqual({ username: "newperson", displayName: "New Person", active: true });
  });
});
