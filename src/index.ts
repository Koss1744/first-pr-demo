export { hotp, totp, secondsRemaining } from "./totp.js";
export type { TotpOptions, OtpAlgorithm } from "./totp.js";
export { parseOtpauthUri, buildOtpauthUri } from "./otpauth.js";
export type { Account } from "./otpauth.js";
export { base32Decode, base32Encode } from "./base32.js";
export {
  defaultVaultPath,
  vaultExists,
  initVault,
  openVault,
  saveAccounts,
  changePassword,
} from "./vault.js";
export type { OpenVault } from "./vault.js";
