// Stand-in for the real "server-only" package under Vitest: the real package's module body
// unconditionally throws unless Next's own bundler intercepts it, which doesn't happen in a
// plain Node/Vitest run. Aliased in via vitest.config.mts's resolve.alias — production code
// (built by Next) still imports the real package and gets its real protection.
export {};
