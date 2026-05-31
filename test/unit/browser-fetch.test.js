'use strict';

const { injectSessionCookie } = require('../../lib/browser-fetch');

const NAME = '__Secure-next-auth.session-token';

function mockCtx() {
  const added = [];
  const cleared = [];
  return {
    added,
    cleared,
    addCookies: async (cookies) => { added.push(...cookies); },
    clearCookies: async (filter) => { cleared.push(filter); },
  };
}

describe('injectSessionCookie', () => {
  test('chunks an oversized session token into .0/.1 cookies under the 4096 limit', async () => {
    const ctx = mockCtx();
    const value = 'a'.repeat(4589); // real ChatGPT JWE size — exceeds one cookie
    const headers = { Cookie: `${NAME}=${value}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.map(c => c.name)).toEqual([`${NAME}.0`, `${NAME}.1`]);
    expect(ctx.added.every(c => c.value.length <= 4096)).toBe(true);
    // chunks concatenate back to the original value in index order
    expect(ctx.added.map(c => c.value).join('')).toBe(value);
    // header is stripped so the oversized cookie is not also sent raw
    expect(headers.Cookie).toBeUndefined();
  });

  test('evicts a stale base-name cookie before injecting chunks', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `${NAME}=${'x'.repeat(5000)}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.cleared).toEqual([{ name: NAME }]);
  });

  test('keeps a small token as a single unsuffixed cookie without clearing', async () => {
    const ctx = mockCtx();
    const value = 'short-token';
    const headers = { Cookie: `${NAME}=${value}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(1);
    expect(ctx.added[0].name).toBe(NAME);
    expect(ctx.added[0].value).toBe(value);
    expect(ctx.cleared).toHaveLength(0); // non-chunked needs no eviction
  });

  test('preserves other cookies in the header, stripping only the session token', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `cf_clearance=abc; ${NAME}=tok; oai-sc=def` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.map(c => c.value).join('')).toBe('tok');
    expect(headers.Cookie).toBe('cf_clearance=abc; oai-sc=def');
  });

  test('marks chunks Secure + httpOnly with the host derived from CONFIG.baseUrl', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `${NAME}=${'x'.repeat(5000)}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.every(c => c.secure && c.httpOnly && c.domain === 'chatgpt.com')).toBe(true);
  });

  test('is a no-op when no Cookie header is present', async () => {
    const ctx = mockCtx();
    const headers = { Authorization: 'Bearer abc' };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(0);
    expect(headers.Authorization).toBe('Bearer abc');
  });

  test('is a no-op when the Cookie header has no session token', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: 'cf_clearance=xyz; other=1' };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(0);
    expect(headers.Cookie).toBe('cf_clearance=xyz; other=1');
  });
});
