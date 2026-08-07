import type { Directory, DirectoryUser } from "./types.js";

export interface SeedUser extends DirectoryUser {
  /** Test-only: real directories never expose or store plaintext passwords like this. */
  password?: string;
}

/**
 * In-memory fake directory for local dev and automated tests, since no real
 * AD/LDAP server is reachable from this environment. Used unconditionally
 * in the test suite; used in dev when HOFI_DIRECTORY_IMPL=memory.
 */
export class InMemoryDirectory implements Directory {
  private readonly users = new Map<string, SeedUser>();

  constructor(seedUsers: SeedUser[] = []) {
    for (const user of seedUsers) {
      this.addUser(user);
    }
  }

  addUser(user: SeedUser): void {
    this.users.set(user.username.toLowerCase(), user);
  }

  async lookupUser(username: string): Promise<DirectoryUser | null> {
    const user = this.users.get(username.toLowerCase());
    if (!user) {
      return null;
    }
    const { password: _password, ...directoryUser } = user;
    return directoryUser;
  }

  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const user = this.users.get(username.toLowerCase());
    return user !== undefined && user.active && user.password === password;
  }
}
