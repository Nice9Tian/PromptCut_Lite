import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { uploadGeneratedAudio } = await import("./generatedAudioUpload.ts");
const { createNotificationRecipe } = await import("../../kernel/soundEffects.ts");
const { renderSoundEffectWav } = await import("../../audio/soundGeneration.ts");

test("generated WAV uploads to local /api/asset/media chunks and completes", async () => {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    assert.ok(String(url).startsWith("/api/asset/media/"));
    if (String(url).endsWith("/chunks")) return Response.json({ complete: false, received: [] });
    return Response.json({ ok: true });
  };
  try {
    const wav = await renderSoundEffectWav(createNotificationRecipe(), { yield: () => Promise.resolve() });
    const result = await uploadGeneratedAudio(wav, new AbortController().signal);
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.equal(result.bytes, wav.length);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
    assert.ok(calls.some((c) => c.url.endsWith("/complete") && c.method === "POST"));
  } finally {
    globalThis.fetch = old;
  }
});
