/**
 * Is the server reachable right now? A failed router refresh makes Next.js
 * fall back to a full page load, which without network shows the offline page
 * instead of the roadmap on screen: a tiny probe of a static file comes first.
 * Browser only.
 */
const PROBE_URL = "/icons/icon.svg";
const PROBE_TIMEOUT_MS = 5000;

export async function serverReachable(): Promise<boolean> {
  if (navigator.onLine === false) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_URL, { method: "HEAD", cache: "no-store", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
