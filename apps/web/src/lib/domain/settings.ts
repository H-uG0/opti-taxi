import type { AppSettings, PrismaClient } from "@prisma/client";

/** The single settings row (id = 1), created with schema defaults on first read. */
export function getSettings(prisma: PrismaClient): Promise<AppSettings> {
  return prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}
