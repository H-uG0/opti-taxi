import type { AppSettings, PrismaClient } from "@prisma/client";

/** The single settings row (id = 1), created with schema defaults on first read. */
export function getSettings(prisma: PrismaClient): Promise<AppSettings> {
  return prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

/**
 * Regulation phone number shown to the drivers ("04 65 71 00 00"), or null
 * when none is set. Read only: no settings row is created here.
 */
export async function getRegulatorPhone(prisma: PrismaClient): Promise<string | null> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 }, select: { regulatorPhone: true } });
  return settings?.regulatorPhone ?? null;
}
