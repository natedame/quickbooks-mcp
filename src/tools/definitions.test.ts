// Guards the read-only write-gate invariant: every mutating tool is named so the
// name-regex gate in serverFactory.ts catches it. If a future write tool is added
// with a non-create_/edit_/delete_ name, assertWriteToolsGated() throws at boot and
// this test fails first.

import { describe, it, expect } from "vitest";
import { toolDefinitions, WRITE_TOOLS, assertWriteToolsGated } from "./definitions.js";

describe("write-tool gating invariant", () => {
  it("passes for the current tool set (no misnamed write tool)", () => {
    expect(() => assertWriteToolsGated()).not.toThrow();
  });

  it("every WRITE_TOOL is named create_/edit_/delete_", () => {
    for (const name of WRITE_TOOLS) {
      expect(name).toMatch(/^(create_|edit_|delete_)/);
    }
  });

  it("every WRITE_TOOL exists in toolDefinitions", () => {
    const defined = new Set(toolDefinitions.map((t) => t.name));
    for (const name of WRITE_TOOLS) {
      expect(defined.has(name)).toBe(true);
    }
  });

  it("includes create_payment (the new write tool)", () => {
    expect(WRITE_TOOLS).toContain("create_payment");
    expect(toolDefinitions.some((t) => t.name === "create_payment")).toBe(true);
  });
});
