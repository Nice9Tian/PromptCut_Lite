/**
 * 测量的开工门(`measureGate.ts`)。跑:
 *   node --test src/editor/measureGate.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const G = await import(srcUrl("editor/measureGate.ts"));

test("MG-01 桌面:一开始就开着", async () => {
  G.resetMeasureGate();
  assert.equal(G.measureGateOpen(), true);
  await G.whenMeasureGateOpen();
  assert.equal(G.measureGateDiag().reason, "desktop");
  G.holdMeasureForCardSources();
  assert.equal(G.measureGateOpen(), true);
});
