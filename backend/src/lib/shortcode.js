/**
 * Short-code generator — single source of truth.
 *
 * The Cloudflare worker route only matches [a-zA-Z0-9]{4,12}, so codes
 * must never contain nanoid's default `-`/`_` characters. Ambiguous
 * glyphs (0/O, 1/l/I) are excluded because customers sometimes type
 * these codes by hand from a text message.
 */

import { customAlphabet } from 'nanoid';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export const shortCode = customAlphabet(ALPHABET, 8);
