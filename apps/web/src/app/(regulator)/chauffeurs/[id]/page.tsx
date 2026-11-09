import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { addDays, fromIsoDate, todayIso, toIsoDate, tomorrowIso } from "@/lib/time";
import { absenceText } from "@/lib/staff/day-crews";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { plannedSeatCount } from "../../vehicules/_lib/crew";
import { BackLink, Callout, UpcomingRoutesCallout } from "../../vehicules/_lib/ui";
import { toUpcomingRoutes, upcomingRoutesNotice } from "../../vehicules/_lib/upcoming-routes";
import { saveDriverAccount, setDriverAccountActive, setDriverActive, updateDriver } from "../actions";
import { DriverForm } from "../driver-form";
import { driverFormValues, OPEN_SESSION_NOTE } from "../schema";
import { loadDepotOptions } from "@/app/(regulator)/depots/options";
import { addAbsence, addIncompatibility, deleteAbsence, deleteIncompatibility } from "../staff-actions";
import { AccountForm } from "./account-form";
import { AbsenceForm, IncompatibilityForm } from "./staff-cards";

export const metadata: Metadata = { title: "Fiche chauffeur" };

const dateTimeFormat = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long" });

export default async function EditDriverPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const [{ id }, { cree }] = await Promise.all([params, searchParams]);

  const driver = await db.driver.findUnique({
    where: { id },
    include: {
      defaultForVehicles: { select: { id: true, label: true, type: true, active: true }, orderBy: { label: "asc" } },
      crewMateForVehicles: { select: { id: true, label: true, type: true, active: true }, orderBy: { label: "asc" } },
      // Only safe account fields: never the password hash.
      user: { select: { email: true, active: true, role: true, createdAt: true } },
    },
  });
  if (!driver) notFound();

  const today = todayIso();
  const [depots, absences, pairs, others] = await Promise.all([
    loadDepotOptions(driver.depotId),
    // Recent and upcoming: the last 30 days are kept on screen to correct a mistake.
    db.staffAbsence.findMany({
      where: { driverId: driver.id, endDate: { gte: fromIsoDate(addDays(today, -30)) } },
      orderBy: { startDate: "asc" },
      select: { id: true, kind: true, startDate: true, endDate: true, note: true },
    }),
    db.crewIncompatibility.findMany({
      where: { OR: [{ driverAId: driver.id }, { driverBId: driver.id }] },
      select: {
        id: true,
        note: true,
        driverA: { select: { id: true, firstName: true, lastName: true } },
        driverB: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    db.driver.findMany({
      where: { active: true, id: { not: driver.id } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
    // The sheet shows the person's absences with their reason (sick leave…).
    auditRead(user, { action: "driver.view", entity: "Driver", entityId: driver.id }),
  ]);
  const upcomingRoutes = toUpcomingRoutes(
    await db.route.findMany({
      where: { serviceDate: { gte: fromIsoDate(todayIso()) }, OR: [{ driverId: driver.id }, { crewMateId: driver.id }] },
      select: { serviceDate: true, status: true },
    }),
  );
  const upcomingNotice = upcomingRoutesNotice(upcomingRoutes, "driver");

  const fullName = `${driver.firstName} ${driver.lastName}`;
  const account = driver.user && driver.user.role === "DRIVER" ? driver.user : null;
  const assignments = [
    ...driver.defaultForVehicles.map((v) => ({ ...v, role: "Chauffeur par défaut" })),
    ...driver.crewMateForVehicles.map((v) => ({ ...v, role: "Équipier par défaut" })),
  ];
  // The optimisation gives a person one vehicle a day.
  const plannedSeats = plannedSeatCount(driver.defaultForVehicles, driver.crewMateForVehicles);

  return (
    <div className="max-w-7xl">
      <BackLink href="/chauffeurs">Chauffeurs</BackLink>
      <PageHeader
        title={fullName}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {driver.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}
            {account ? (
              <Badge tone={account.active ? "info" : "neutral"}>
                {account.active ? "Accès feuille de route actif" : "Accès désactivé"}
              </Badge>
            ) : (
              <Badge tone="warning">Pas d&apos;accès feuille de route</Badge>
            )}
          </span>
        }
      />

      {cree === "1" && !account ? (
        <div className="mb-6">
          <FormMessage tone="success">
            Chauffeur créé. Créez-lui maintenant un compte d&apos;accès pour qu&apos;il consulte sa feuille de route sur son
            téléphone.
          </FormMessage>
        </div>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <DriverForm
          action={updateDriver.bind(null, driver.id)}
          initial={driverFormValues(driver)}
          depots={depots}
          submitLabel="Enregistrer"
        />

        <div className="space-y-6">
          <Card>
            <CardHeader title="Compte d'accès à la feuille de route" />
            <CardBody className="space-y-4 text-sm text-slate-700">
              {account ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-slate-500">Identifiant</dt>
                  <dd className="truncate font-medium" title={account.email}>
                    {account.email}
                  </dd>
                  <dt className="text-slate-500">Statut</dt>
                  <dd>{account.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}</dd>
                  <dt className="text-slate-500">Créé le</dt>
                  <dd className="tabular">{dateTimeFormat.format(account.createdAt)}</dd>
                </dl>
              ) : (
                <p>
                  Le chauffeur n&apos;a pas encore de compte. Avec un identifiant et un mot de passe, il consulte sa
                  feuille de route du jour sur son téléphone et indique « pris en charge / déposé ».
                </p>
              )}

              {driver.active ? (
                <>
                  <AccountForm
                    action={saveDriverAccount.bind(null, driver.id)}
                    email={account?.email ?? ""}
                    hasAccount={account !== null}
                    accountActive={account?.active ?? false}
                  />
                  {account ? (
                    <div className="border-t border-slate-200 pt-4">
                      <ConfirmAction
                        action={setDriverAccountActive.bind(null, driver.id, !account.active)}
                        label={account.active ? "Désactiver l'accès" : "Réactiver l'accès"}
                        confirmLabel={account.active ? "Confirmer la désactivation" : "Confirmer la réactivation"}
                        variant={account.active ? "danger" : "primary"}
                        question={
                          account.active ? (
                            <p>Le chauffeur ne pourra plus se connecter. {OPEN_SESSION_NOTE}</p>
                          ) : (
                            <p>
                              Le chauffeur pourra de nouveau se connecter avec son identifiant et son mot de passe
                              actuels. Les sessions coupées lors de la désactivation ne reprennent pas.
                            </p>
                          )
                        }
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-slate-500">Réactivez le chauffeur pour gérer son accès.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Absences et gardes" />
            <CardBody className="space-y-4 text-sm text-slate-700">
              <p className="text-xs text-slate-500">
                Congé, arrêt, formation ou garde : la personne n&apos;est pas proposée dans les équipages de ces jours,
                et un remplaçant l&apos;est à sa place (page Équipages). Le motif n&apos;apparaît que sur cette
                fiche : les équipages et le planning indiquent seulement « absence ».
              </p>
              {absences.length === 0 ? (
                <p className="text-slate-500">Aucune absence récente ou à venir.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {absences.map((a) => {
                    const text = absenceText({ kind: a.kind, startDate: toIsoDate(a.startDate), endDate: toIsoDate(a.endDate) });
                    const past = toIsoDate(a.endDate) < today;
                    return (
                      <li key={a.id} className="space-y-1 py-2">
                        <p className={past ? "text-slate-500" : "font-medium text-slate-900"}>
                          {text}
                          {past ? " (passée)" : ""}
                        </p>
                        {a.note ? <p className="text-xs text-slate-500">{a.note}</p> : null}
                        <ConfirmAction
                          action={deleteAbsence.bind(null, driver.id, a.id)}
                          label="Supprimer"
                          confirmLabel="Confirmer la suppression"
                          pendingLabel="Suppression…"
                          variant="ghost"
                          question={<p>Supprimer « {text} » ?</p>}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-slate-200 pt-4">
                <AbsenceForm action={addAbsence.bind(null, driver.id)} defaultDate={tomorrowIso()} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Incompatibilités d'équipage" />
            <CardBody className="space-y-4 text-sm text-slate-700">
              <p className="text-xs text-slate-500">
                Personnes avec qui ne pas former d&apos;équipage : elles ne sont jamais proposées ensemble, et un
                équipage fixé avec elles est refusé.
              </p>
              {pairs.length === 0 ? (
                <p className="text-slate-500">Aucune.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {pairs.map((pair) => {
                    const other = pair.driverA.id === driver.id ? pair.driverB : pair.driverA;
                    const name = `${other.firstName} ${other.lastName}`;
                    return (
                      <li key={pair.id} className="space-y-1 py-2">
                        <Link href={`/chauffeurs/${other.id}`} className="font-medium underline-offset-2 hover:underline">
                          {name}
                        </Link>
                        {pair.note ? <p className="text-xs text-slate-500">{pair.note}</p> : null}
                        <ConfirmAction
                          action={deleteIncompatibility.bind(null, driver.id, pair.id)}
                          label="Supprimer"
                          confirmLabel="Confirmer la suppression"
                          pendingLabel="Suppression…"
                          variant="ghost"
                          question={<p>Ces deux personnes pourront de nouveau être proposées ensemble.</p>}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-slate-200 pt-4">
                <IncompatibilityForm
                  action={addIncompatibility.bind(null, driver.id)}
                  people={others.map((o) => ({ id: o.id, name: `${o.lastName.toUpperCase()} ${o.firstName}` }))}
                />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Véhicules" />
            <CardBody className="text-sm">
              {driver.active && plannedSeats > 1 ? (
                <Callout tone="warning" className="mb-3">
                  Dans l&apos;équipage par défaut de {plannedSeats} véhicules actifs : un seul pourra être planifié
                  chaque jour. Affectez une autre personne aux autres véhicules.
                </Callout>
              ) : null}
              {assignments.length === 0 ? (
                <p className="text-slate-500">
                  Affecté à aucun véhicule. L&apos;équipage par défaut se choisit sur la{" "}
                  <Link href="/vehicules" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                    fiche du véhicule
                  </Link>
                  .
                </p>
              ) : (
                <ul className="space-y-2">
                  {assignments.map((v) => (
                    <li key={`${v.role}-${v.id}`} className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <Link
                          href={`/vehicules/${v.id}`}
                          className="font-medium text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                        >
                          {v.label}
                        </Link>
                        <span className="block text-xs text-slate-500">
                          {v.role}
                          {v.active ? "" : " · véhicule désactivé"}
                        </span>
                      </span>
                      <VehicleTypeBadge type={v.type} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Statut" />
            <CardBody className="space-y-3 text-sm text-slate-700">
              {driver.active ? (
                <p>
                  Pour un départ ou un arrêt longue durée, désactivez le chauffeur plutôt que de le supprimer : son
                  historique de tournées est conservé.
                </p>
              ) : (
                <>
                  <p>
                    Le chauffeur est désactivé : il n&apos;est plus proposé à l&apos;optimisation. Son historique est
                    conservé.
                  </p>
                  <UpcomingRoutesCallout routes={upcomingRoutes} subject="driver" />
                </>
              )}
              <ConfirmAction
                action={setDriverActive.bind(null, driver.id, !driver.active)}
                label={driver.active ? "Désactiver le chauffeur" : "Réactiver le chauffeur"}
                confirmLabel={driver.active ? "Confirmer la désactivation" : "Confirmer la réactivation"}
                variant={driver.active ? "danger" : "primary"}
                question={
                  driver.active ? (
                    <div className="space-y-2">
                      <p>
                        {assignments.length > 0
                          ? `Il sera retiré de l'équipage par défaut de ${assignments.length} véhicule${assignments.length > 1 ? "s" : ""}. `
                          : ""}
                        {account?.active
                          ? `Son compte d'accès sera désactivé : il ne pourra plus se connecter. ${OPEN_SESSION_NOTE} `
                          : ""}
                        L&apos;historique est conservé.
                      </p>
                      {upcomingNotice ? <p className="font-medium text-amber-800">{upcomingNotice}</p> : null}
                    </div>
                  ) : (
                    <p>
                      Le chauffeur pourra de nouveau être affecté à un véhicule.
                      {account && !account.active
                        ? " Son compte d'accès reste désactivé : réactivez-le ensuite si besoin."
                        : ""}
                    </p>
                  )
                }
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
