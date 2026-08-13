// Stands in for the `server-only` package under Vitest.
//
// That package's real entry point throws on import. It is only silent when the
// bundler resolves the `react-server` export condition, which Next sets for
// server components and Vitest does not — so any suite that imports a module
// guarding itself with `import "server-only"` dies at collection time with
// "This module cannot be imported from a Client Component module".
//
// Aliased in vitest.config.ts rather than solved by adding `react-server` to
// resolve.conditions, which would also swap React itself for its server build
// and take useState with it.
//
// The guard it replaces is still doing its job where it matters: `next build`
// resolves the real package, so importing lib/supabase/admin from a client
// component remains a build error.
export {};
