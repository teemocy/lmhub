import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { ApiTokenRecord } from "@localhub/shared-contracts/foundation-config";

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;

function normalizeToken(token: string): string {
  const normalized = token.trim();

  if (normalized.length < 16) {
    throw new Error("Bearer tokens must be at least 16 characters long.");
  }

  return normalized;
}

export function generateBearerToken(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}

export function hashBearerToken(token: string): string {
  const normalized = normalizeToken(token);
  const salt = randomBytes(16);
  const derivedKey = scryptSync(normalized, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });

  return [
    "scrypt",
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export function verifyBearerToken(token: string, storedHash: string): boolean {
  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedHash] =
    storedHash.split("$");

  if (
    algorithm !== "scrypt" ||
    !cost ||
    !blockSize ||
    !parallelization ||
    !encodedSalt ||
    !encodedHash
  ) {
    return false;
  }

  const parsedCost = Number(cost);
  const parsedBlockSize = Number(blockSize);
  const parsedParallelization = Number(parallelization);

  if (
    !Number.isInteger(parsedCost) ||
    !Number.isInteger(parsedBlockSize) ||
    !Number.isInteger(parsedParallelization) ||
    parsedCost <= 1 ||
    parsedBlockSize <= 0 ||
    parsedParallelization <= 0
  ) {
    return false;
  }

  try {
    const normalizedToken = normalizeToken(token);
    const salt = Buffer.from(encodedSalt, "base64url");
    const expectedHash = Buffer.from(encodedHash, "base64url");

    if (salt.length === 0 || expectedHash.length !== KEY_LENGTH) {
      return false;
    }

    const derivedKey = scryptSync(normalizedToken, salt, KEY_LENGTH, {
      N: parsedCost,
      r: parsedBlockSize,
      p: parsedParallelization,
    });

    return timingSafeEqual(derivedKey, expectedHash);
  } catch {
    return false;
  }
}

export function createApiTokenRecord(
  label: string,
  scopes: string[] = ["public"],
): ApiTokenRecord & { plainTextToken: string } {
  const plainTextToken = generateBearerToken();
  const now = new Date().toISOString();

  return {
    id: randomBytes(12).toString("hex"),
    label,
    tokenHash: hashBearerToken(plainTextToken),
    scopes,
    createdAt: now,
    plainTextToken,
  };
}
