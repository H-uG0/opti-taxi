// Runs once per test worker, before its test files: pays the one-off cost of
// loading ICU time-zone data outside any test's timeout.
new Date(0).toISOString();
new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" }).format(new Date(0));
