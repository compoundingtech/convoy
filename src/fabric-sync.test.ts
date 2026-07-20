import { describe, it, expect } from "vitest";
import { catalogSyncName, fabricSyncAddArgv, fabricSyncAvailable, declareCatalogSync } from "./fabric-sync.ts";
import { catalogDir } from "./agent-file.ts";

// A fake exec matching run()'s shape { status, stdout, stderr, ok }, injectable into the fabric-sync fns.
const exec = (status: number, out = "", errOut = ""): any => async () => ({ status, stdout: out, stderr: errOut, ok: status === 0 });
const throwingExec: any = async () => { throw new Error("ENOENT: fabric not found"); };

describe("fabric-sync — convoy DECLARES its catalog to `fabric sync` (does not sync itself)", () => {
  it("catalogSyncName: convoy-catalog-<network-name>, distinct per network, same across machines", () => {
    expect(catalogSyncName("/home/x/.local/state/convoy/default")).toBe("convoy-catalog-default");
    expect(catalogSyncName("/home/x/.local/state/convoy/staging")).toBe("convoy-catalog-staging"); // distinct per network → no collision on one box
    expect(catalogSyncName("/anywhere/default")).toBe("convoy-catalog-default"); // path differs Mac vs hetz; NAME is the shared key
  });

  it("fabricSyncAddArgv: the exact `fabric sync add` declaration — folder=abs catalog, shared name, peers=*, policy=catalog, include=*.toml", () => {
    const net = "/n/default";
    expect(fabricSyncAddArgv(net)).toEqual([
      "sync", "add", catalogDir(net), // absolute catalog dir
      "--name", "convoy-catalog-default",
      "--peers", "*",
      "--policy", "catalog",
      "--include", "*.toml",
    ]);
  });

  it("fabricSyncAvailable: capability probe — help exit 0 → true; unrecognized/absent → false; never throws", async () => {
    expect(await fabricSyncAvailable(exec(0))).toBe(true);
    expect(await fabricSyncAvailable(exec(2, "", "unrecognized subcommand 'sync'"))).toBe(false); // old fabric
    expect(await fabricSyncAvailable(throwingExec)).toBe(false); // fabric not installed
  });

  it("declareCatalogSync: available + add ok → declared with the shared name", async () => {
    const r = await declareCatalogSync("/n/default", exec(0, `sync "convoy-catalog-default" written`));
    expect(r.declared).toBe(true);
    expect(r.name).toBe("convoy-catalog-default");
    expect(r.reason).toBeUndefined();
  });

  it("declareCatalogSync: fabric sync UNAVAILABLE → declared:false + honest reason, never throws (single-machine still works)", async () => {
    const r = await declareCatalogSync("/n/default", exec(2, "", "unrecognized subcommand 'sync'"));
    expect(r.declared).toBe(false);
    expect(r.reason).toMatch(/unavailable|install\/update fabric/i);
    // a totally absent fabric (exec throws) is also a clean skip, not a crash
    expect((await declareCatalogSync("/n/default", throwingExec)).declared).toBe(false);
  });

  it("declareCatalogSync: fabric present but `add` fails → declared:false + surfaces fabric's error, no throw", async () => {
    const r = await declareCatalogSync("/n/default", async (_c: string, args: string[]) =>
      args[1] === "--help" ? { status: 0, stdout: "", stderr: "", ok: true } : { status: 1, stdout: "", stderr: "sync error: peers.toml missing", ok: false } as any,
    );
    expect(r.declared).toBe(false);
    expect(r.reason).toMatch(/fabric sync add failed.*peers\.toml/i);
  });
});
