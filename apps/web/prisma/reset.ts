/**
 * `pnpm db:reset`: drops and recreates the database (prisma migrate reset
 * --force), which then runs the seed. The development-database guard
 * (prisma/safety.ts) runs first: run alone, migrate reset would drop the data
 * before the seed's guard could refuse.
 */
import { spawnSync } from "node:child_process";
import { PrismaClient, type Prisma } from "@prisma/client";
import { assertSeedOnlyDatabase, UnsafeDatabaseError } from "./safety";

/**
 * Accounts outside the seed's domain; none when the tables do not exist yet
 * (P2021) or the database itself does not (P1003, on a host already checked
 * local): migrate reset then creates them.
 */
async function countForeignUsers(prisma: PrismaClient, where: Prisma.UserWhereInput): Promise<number> {
  try {
    return await prisma.user.count({ where });
  } catch (error) {
    const { code, errorCode } = error as { code?: unknown; errorCode?: unknown };
    if (code === "P2021" || errorCode === "P1003") return 0;
    throw error;
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const target = await assertSeedOnlyDatabase("reset", (where) => countForeignUsers(prisma, where));
    console.log(`Réinitialisation de ${target}…`);
  } finally {
    await prisma.$disconnect();
  }
  const result = spawnSync("prisma", ["migrate", "reset", "--force"], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) console.error(`prisma migrate reset n'a pas pu être lancé (lancer via pnpm db:reset) : ${result.error.message}`);
  process.exit(result.status ?? 1);
}

main().catch((error: unknown) => {
  if (error instanceof UnsafeDatabaseError) console.error(`\n${error.message}`);
  else console.error(error);
  process.exit(1);
});
