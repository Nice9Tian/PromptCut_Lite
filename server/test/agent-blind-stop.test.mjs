/**
 * "What to do with unavailable capabilities": Write the decision table in the prompt according to
 * the actual situation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const prompt = fs.readFileSync(path.join(here, '..', 'ai-system-prompt.md'), 'utf8');

test('prompt: the "must look at the media first" item points to the decision table, and is no longer a hard requirement with no way out', () => {
  const must = prompt.slice(prompt.indexOf('you must first look at the picture with the media mode of `see_frames` (`source: "media"`) before arranging cards'), prompt.indexOf('What to do when a capability is unavailable'));
  assert.match(must, /When this item cannot be done/);
  assert.match(must, /do not carry on blindly by yourself/);
});

test('prompt: all three options of the decision table are present, and "hard prerequisite" has an actionable criterion', () => {
  const table = prompt.slice(prompt.indexOf('- **What to do when a capability is unavailable'), prompt.indexOf('- **Land it first, polish later'));
  assert.ok(table, 'the decision table section must be in the interaction principles');
  // Three paths
  assert.match(table, /It \*\*is\*\* a hard prerequisite/);
  assert.match(table, /It is \*\*not\*\* a hard prerequisite/);
  assert.match(table, /the same error 2 times in a row/);
  // The hard prerequisite path must land on a final + blocked progress report and stop: blocked is
  // the "waiting for your reply" bit in the UI
  assert.match(table, /`report_progress` with `final: true` and `blocked: true`/);
  assert.match(table, /Then stop and do not call any more tools/);
  // Criterion: user mentioning visual content counts as a hard prerequisite; stop if unsure
  assert.match(table, /who is where, what to avoid/);
  assert.match(table, /When in doubt, treat it as a hard prerequisite and stop to ask/);
  // Explicitly exclude "retry a third time" and "continue as if it does not exist"
  assert.match(table, /includes "retry a third time"/);
  assert.match(table, /includes "carry on as if it did not exist"/);
  // Having cloudUnavailable in the result also counts as a signal
  assert.match(table, /cloudUnavailable/);
});

test('prompt: land it first and polish later, and state that only what is handed to a tool counts as delivered', () => {
  const ship = prompt.slice(prompt.indexOf('- **Land it first, polish later'));
  assert.match(ship, /only what has actually been handed to a tool counts as delivered/);
  assert.match(ship, /card source written in code blocks/);
  assert.match(ship, /remind you once when half is left and once when only a quarter is left/, 'must match the two hints the harness actually sends');
});

test('prompt: every place that stops to wait for the user is changed to blocked, with a clear note not to fill it in carelessly', () => {
  // Outside the decision table, there are three other places to "stop and wait for user": the progress
  // report section, web page blocked handoff, and clarifying ambiguous instructions
  for (const anchor of ['The same applies when you need the user to do something or answer', 'Ask when you cannot understand', 'bring the window to the user']) {
    assert.ok(prompt.includes(anchor), anchor);
  }
  assert.match(prompt, /in all these cases call `report_progress` with `final: true` \*\*and `blocked: true`\*\*/);
  assert.match(prompt, /- \*\*Ask when you cannot understand\*\*: [^\n]*`final: true` and `blocked: true`/);
  // Do not fill arbitrarily: completed or merely hitting the limit does not count as "waiting for
  // your reply"
  assert.match(prompt, /If you finished by yourself, or merely hit the turn limit, do not set `blocked`/);
  assert.match(prompt, /`blocked: true` implies `final`/);
});
