export interface DirectoryUser {
  username: string;
  displayName: string;
  active: boolean;
  /** Distinguished name, used by LdapDirectory.verifyCredentials to bind as the user. */
  dn?: string;
}

export interface Directory {
  /** Looks up a user by username. Returns null if the account doesn't exist. */
  lookupUser(username: string): Promise<DirectoryUser | null>;
  /**
   * Validates a username/password pair (e.g. by attempting an LDAP bind as
   * that user - never by touching Kerberos or storing the password).
   * Reserved for the Phase 2 web-SSO login flow; not called anywhere in
   * Phase 1.
   */
  verifyCredentials(username: string, password: string): Promise<boolean>;
}
