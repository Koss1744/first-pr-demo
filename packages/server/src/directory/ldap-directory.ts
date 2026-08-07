import ldap from "ldapjs";
import type { LdapConfig } from "../config.js";
import type { Directory, DirectoryUser } from "./types.js";

// ACCOUNTDISABLE bit in Active Directory's userAccountControl attribute.
const UAC_ACCOUNTDISABLE = 0x2;

function bind(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => (err ? reject(err) : resolve()));
  });
}

function search(client: ldap.Client, baseDn: string, filter: string): Promise<ldap.SearchEntry[]> {
  return new Promise((resolve, reject) => {
    client.search(baseDn, { filter, scope: "sub" }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      const entries: ldap.SearchEntry[] = [];
      res.on("searchEntry", (entry) => entries.push(entry));
      res.on("error", reject);
      res.on("end", () => resolve(entries));
    });
  });
}

function getAttribute(entry: ldap.SearchEntry, name: string): string | undefined {
  const attribute = entry.attributes.find((a) => a.type.toLowerCase() === name.toLowerCase());
  const value = attribute?.values?.[0];
  return typeof value === "string" ? value : undefined;
}

// RFC 4515 filter-value escaping.
function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof ldap.InvalidCredentialsError || (err instanceof Error && err.name === "InvalidCredentialsError");
}

function entryToDirectoryUser(entry: ldap.SearchEntry, fallbackUsername: string): DirectoryUser {
  const uac = Number(getAttribute(entry, "userAccountControl") ?? "0");
  return {
    username: getAttribute(entry, "sAMAccountName") ?? fallbackUsername,
    displayName: getAttribute(entry, "displayName") ?? getAttribute(entry, "cn") ?? fallbackUsername,
    active: (uac & UAC_ACCOUNTDISABLE) === 0,
    dn: entry.objectName ?? undefined,
  };
}

/**
 * Real Active Directory lookup via LDAP, using ldapjs.
 *
 * KNOWN RISK: ldapjs (and its @ldapjs/* dependencies) has been publicly
 * decommissioned by its maintainer (no further maintenance planned - see
 * https://github.com/ldapjs/node-ldapjs). It is still functionally complete
 * for the narrow bind+search usage here, and is isolated behind the
 * Directory interface specifically so it can be swapped for another
 * implementation (or an out-of-process LDAP gateway) without touching any
 * caller. Revisit before production rollout.
 */
export class LdapDirectory implements Directory {
  constructor(private readonly config: LdapConfig) {}

  async lookupUser(username: string): Promise<DirectoryUser | null> {
    const client = ldap.createClient({ url: this.config.url });
    try {
      await bind(client, this.config.bindDn, this.config.bindPassword);
      const filter = this.config.userFilter.replace("{username}", escapeFilterValue(username));
      const entries = await search(client, this.config.baseDn, filter);
      if (entries.length === 0) {
        return null;
      }
      return entryToDirectoryUser(entries[0], username);
    } finally {
      client.unbind();
    }
  }

  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const user = await this.lookupUser(username);
    if (!user?.dn) {
      return false;
    }
    const client = ldap.createClient({ url: this.config.url });
    try {
      await bind(client, user.dn, password);
      return true;
    } catch (err) {
      if (isInvalidCredentialsError(err)) {
        return false;
      }
      // Directory outages/network errors fail loudly rather than being
      // silently treated as "wrong password".
      throw err;
    } finally {
      client.unbind();
    }
  }
}
