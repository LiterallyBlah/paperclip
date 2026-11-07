import fs from "node:fs/promises";

/** A saved OAuth login is ready only while its Muse subscription is active. */
export async function hasActiveMuseSubscription(authPath: string): Promise<boolean> {
  try {
    const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
    return auth?.providers?.meta?.subs_active === true;
  } catch {
    return false;
  }
}
