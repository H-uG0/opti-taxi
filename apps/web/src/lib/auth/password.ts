import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Hash of a random secret nobody knows. Store it whenever an account is
 * deactivated: the password fingerprint of every open session no longer
 * matches (see sessionIsCurrent), so reactivating the account later does not
 * bring an old session back (e.g. on a lost phone), and the old password no
 * longer signs in: the regulator sets a new one.
 */
export function lockedPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString("base64url"));
}
