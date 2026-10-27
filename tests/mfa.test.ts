import { describe, expect, it } from 'vitest';
import { decryptMfaSecret, encryptMfaSecret, verifyTotp } from '../src/common/mfa';

describe('MFA primitives', () => {
  it('encrypts enrollment secrets at rest and verifies RFC TOTP output', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(decryptMfaSecret(encryptMfaSecret(secret))).toBe(secret);
    expect(verifyTotp(secret, '287082', 59000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59000)).toBe(false);
  });
});
