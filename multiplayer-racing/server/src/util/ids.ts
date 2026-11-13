import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../../shared/constants';

/** Short public identifier (not a secret). */
export function newId(bytes = 9): string {
  return randomBytes(bytes).toString('base64url');
}

/** Unpredictable reconnect credential: 192 bits from the OS CSPRNG. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Random room code from an alphabet without look-alike characters. */
export function newRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
