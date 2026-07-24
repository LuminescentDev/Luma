import { describe, it, expect } from "vitest";
import {
  buildHostGroupLayout,
  countTemplatePanes,
  parseTemplates,
} from "./templateStore";
import type { SnapshotPaneNode } from "../features/terminal/sessionSnapshot";

const leaf: SnapshotPaneNode = { kind: "leaf", restore: { kind: "local" } };

function validStored(templates: unknown[]): unknown {
  return { version: 1, templates };
}

describe("parseTemplates fails closed", () => {
  it("returns [] for non-objects and wrong versions", () => {
    expect(parseTemplates(null)).toEqual([]);
    expect(parseTemplates("nope")).toEqual([]);
    expect(parseTemplates({ version: 2, templates: [] })).toEqual([]);
    expect(parseTemplates({ templates: [] })).toEqual([]);
  });

  it("drops entries with missing/invalid fields or malformed roots", () => {
    const parsed = parseTemplates(
      validStored([
        { id: "1", name: "ok", createdAt: "2026-01-01", root: leaf },
        { id: "2", name: "no root" }, // missing root
        { id: "3", name: "bad root", createdAt: "x", root: { kind: "bogus" } },
        { name: "no id", createdAt: "x", root: leaf }, // missing id
        "not an object",
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("1");
  });

  it("accepts a well-formed split root", () => {
    const root: SnapshotPaneNode = {
      kind: "split",
      direction: "row",
      children: [leaf, leaf],
      sizes: [50, 50],
    };
    const parsed = parseTemplates(
      validStored([{ id: "1", name: "grp", createdAt: "x", root }]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].root).toEqual(root);
  });
});

describe("buildHostGroupLayout", () => {
  const host = (id: string) => ({ id, name: id, hostname: `${id}.example.com` });

  it("returns null for no hosts", () => {
    expect(buildHostGroupLayout([])).toBeNull();
  });

  it("returns a lone leaf for a single host", () => {
    const root = buildHostGroupLayout([host("a")]);
    expect(root?.kind).toBe("leaf");
    expect(countTemplatePanes(root!)).toBe(1);
  });

  it("splits up to three hosts evenly in a row", () => {
    const root = buildHostGroupLayout([host("a"), host("b"), host("c")]);
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    expect(root.direction).toBe("row");
    expect(root.children).toHaveLength(3);
    expect(countTemplatePanes(root)).toBe(3);
  });

  it("uses a two-column layout beyond three hosts, preserving leaf count", () => {
    const hosts = ["a", "b", "c", "d", "e"].map(host);
    const root = buildHostGroupLayout(hosts);
    expect(root?.kind).toBe("split");
    if (root?.kind !== "split") return;
    expect(root.direction).toBe("row");
    expect(root.children).toHaveLength(2); // two columns
    expect(countTemplatePanes(root)).toBe(5);
  });

  it("carries each host into an ssh restore descriptor", () => {
    const root = buildHostGroupLayout([host("a")]);
    expect(root).toEqual({
      kind: "leaf",
      restore: {
        kind: "ssh",
        hostId: "a",
        title: "a",
        connectionTarget: "a.example.com",
      },
    });
  });
});
