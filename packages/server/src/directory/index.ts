import type { ServerConfig } from "../config.js";
import { LdapDirectory } from "./ldap-directory.js";
import { InMemoryDirectory } from "./memory-directory.js";
import type { Directory } from "./types.js";

export type { Directory, DirectoryUser } from "./types.js";
export { InMemoryDirectory } from "./memory-directory.js";
export { LdapDirectory } from "./ldap-directory.js";

/** Picks the Directory implementation per config.directoryImpl (mirrors @hofi core's env-with-default pattern). */
export function createDirectory(config: ServerConfig): Directory {
  if (config.directoryImpl === "memory") {
    return new InMemoryDirectory();
  }
  if (!config.ldap) {
    throw new Error("HOFI_DIRECTORY_IMPL=ldap but no LDAP configuration was loaded");
  }
  return new LdapDirectory(config.ldap);
}
