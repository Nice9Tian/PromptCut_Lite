/**
 * Measurement start gate (`measureGate.ts`). Run:
 *   node --test src/editor/measureGate.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const G = await import(srcUrl("editor/measureGate.ts"));

test("MG-01 desktop: open from the start", async () => {
  G.resetMeasureGate();
  assert.equal(G.measureGateOpen(), true);
  await G.whenMeasureGateOpen();
  assert.equal(G.measureGateDiag().reason, "desktop");
  // Desktop also called hold (will not happen, but even if called, does not close back)
  G.holdMeasureForCardSources();
  assert.equal(G.measureGateOpen(), true);
});
