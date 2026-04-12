import Mux from '@mux/mux-node';

if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
  throw new Error('Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET');
}

export const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export const { video } = mux;
