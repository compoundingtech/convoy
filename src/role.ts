// A role is high-level intent → the persona base, the permission-mode posture, and always-on-ness.
// Ported 1:1 from Sources/ConvoyKit/Role.swift. This table is the single source of truth for AC-1.

export type Role = "chief-of-staff" | "supervisor" | "worker" | "technical-manager";

export type PermissionMode = "bypassPermissions" | "auto" | "acceptEdits" | "plan" | "default";

export const ROLES: readonly Role[] = ["chief-of-staff", "supervisor", "worker", "technical-manager"];

/** Friendly aliases so `convoy add cos …` / `convoy add tm …` just work. */
export function parseRole(raw: string): Role | null {
  switch (raw.toLowerCase()) {
    case "chief-of-staff":
    case "chiefofstaff":
    case "cos":
    case "spawner":
      return "chief-of-staff";
    case "supervisor":
    case "sup":
      return "supervisor";
    case "worker":
    case "wk":
      return "worker";
    case "technical-manager":
    case "technicalmanager":
    case "tm":
    case "manager":
      return "technical-manager";
    default: {
      const r = raw.toLowerCase();
      return (ROLES as readonly string[]).includes(r) ? (r as Role) : null;
    }
  }
}

/** Whether this role spawns/manages other agents (elevated permissions). Workers don't. */
export function isSpawner(r: Role): boolean {
  return r !== "worker";
}

/** DERIVED — never hand-set. Spawner-class roles run `bypassPermissions`; workers run `auto`. */
export function permissionMode(r: Role): PermissionMode {
  return isSpawner(r) ? "bypassPermissions" : "auto";
}

/** DERIVED — only the CoS is always-on by role. Every other long-lived agent needs `--permanent`. */
export function permanentByRole(r: Role): boolean {
  return r === "chief-of-staff";
}

export function personaBaseFilename(r: Role): string {
  return `${r}.md`;
}
