/**
 * Runs once when a Next.js server starts (not during `next build`). Refuses to
 * start with a SESSION_SECRET unfit for production (lib/auth/secret.ts), rather
 * than failing at the first sign-in; session.ts applies the same rule each
 * time it signs or reads a cookie. In production outside demo mode, also
 * refuses to start while the seed's demo accounts (public passwords) exist
 * (lib/demo.ts). Warns when the sign-in throttling cannot key on client
 * addresses (TRUSTED_PROXY_HOPS, lib/auth/rate-limit.ts) and when the
 * optimizer is called without a token (OPTIMIZER_TOKEN, lib/optimizer/token.ts).
 * Next.js logs uncaught errors with console.error(error) and a Prisma error
 * prints its query arguments (addresses, notes): console.error is wrapped so
 * those errors are reduced to their safe fields (lib/log.ts).
 *
 * Node.js-only modules are imported inside the NEXT_RUNTIME check, as the
 * Next.js instrumentation guide prescribes (rate-limit.ts uses node:net).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { redactConsoleArgs } = await import("./lib/log");
    const consoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => consoleError(...redactConsoleArgs(args));

    const { checkSessionSecretAtStartup } = await import("./lib/auth/startup");
    checkSessionSecretAtStartup();
    const { proxyHopsWarning } = await import("./lib/auth/rate-limit");
    const warning = proxyHopsWarning(process.env.TRUSTED_PROXY_HOPS, process.env.NODE_ENV);
    if (warning) console.warn(`[startup] ${warning}`);
    const { optimizerTokenWarning } = await import("./lib/optimizer/token");
    const tokenWarning = optimizerTokenWarning(process.env);
    if (tokenWarning) console.warn(`[startup] ${tokenWarning}`);

    const { checkDemoAccountsAtStartup, DEMO_EMAIL_DOMAIN } = await import("./lib/demo");
    await checkDemoAccountsAtStartup(async () => {
      // A short-lived client: lib/db is server-only (React Server Components), not loaded here.
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      try {
        return await prisma.user.count({ where: { email: { endsWith: DEMO_EMAIL_DOMAIN, mode: "insensitive" } } });
      } finally {
        await prisma.$disconnect();
      }
    });
  }
}
