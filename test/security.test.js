import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSecurity, hashAnswer, checkAnswer, normaliseAnswer, decoyQuestion, PRESET_QUESTIONS, MAX_ATTEMPTS } from "../lib/security.js";

function setup() {
  const rows = new Map();
  const passwords = new Map();
  let clock = new Date("2026-01-01T00:00:00Z");
  const users = { "tok-a": { id: "a", email: "Alice@Example.com" }, "tok-b": { id: "b", email: "bob@example.com" } };
  const sec = makeSecurity({
    getUserFromToken: async (t) => users[t] || null,
    store: {
      getById: async (id) => rows.get(id) || null,
      getByEmail: async (e) => [...rows.values()].find((r) => r.email === e) || null,
      upsert: async (r) => rows.set(r.user_id, { ...r }),
      update: async (id, f) => rows.set(id, { ...rows.get(id), ...f }),
    },
    setPassword: async (id, pw) => passwords.set(id, pw),
    now: () => clock,
  });
  return { sec, rows, passwords, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test("answers ignore case, spacing and punctuation", () => {
  assert.equal(normaliseAnswer("  Fluffy  McFluff! "), "fluffy mcfluff");
  const h = hashAnswer("Raffles Primary");
  assert.ok(checkAnswer("raffles   primary.", h));
  assert.ok(!checkAnswer("raffles secondary", h));
  assert.ok(!h.includes("raffles"), "answer must not be stored in plain text");
});

test("set requires sign-in, then status reports the question", async () => {
  const { sec } = setup();
  await assert.rejects(sec.set("bad-token", "What was your first pet?", "Rex"), /sign in/);
  await sec.set("tok-a", "What was your first pet?", "Rex");
  const s = await sec.status("tok-a");
  assert.equal(s.hasQuestion, true);
  assert.equal(s.question, "What was your first pet?");
  assert.equal((await sec.status("tok-b")).hasQuestion, false);
});

test("reset with the right answer sets the password; email match ignores case", async () => {
  const { sec, passwords } = setup();
  await sec.set("tok-a", "What was your first pet?", "Rex");
  assert.equal((await sec.question("  ALICE@example.com ")).question, "What was your first pet?");
  await sec.reset("alice@example.com", "rex", "new-password-1");
  assert.equal(passwords.get("a"), "new-password-1");
});

test("wrong answers are refused and lock the reset after the limit", async () => {
  const { sec, passwords, tick } = setup();
  await sec.set("tok-a", "What was your first pet?", "Rex");
  for (let i = 1; i < MAX_ATTEMPTS; i++) await assert.rejects(sec.reset("alice@example.com", "max", "new-password-1"), /doesn't match/);
  await assert.rejects(sec.reset("alice@example.com", "max", "new-password-1"), /Too many/);
  // even the right answer is refused while locked
  await assert.rejects(sec.reset("alice@example.com", "rex", "new-password-1"), /Too many/);
  assert.equal(passwords.size, 0);
  tick(16 * 60000);
  await sec.reset("alice@example.com", "rex", "new-password-1");
  assert.equal(passwords.get("a"), "new-password-1");
});

test("short new passwords are refused", async () => {
  const { sec } = setup();
  await sec.set("tok-a", "What was your first pet?", "Rex");
  await assert.rejects(sec.reset("alice@example.com", "rex", "short"), /at least 8/);
});

test("unknown emails get a stable decoy question and can never reset", async () => {
  const { sec, passwords } = setup();
  const q1 = (await sec.question("nobody@example.com")).question;
  const q2 = (await sec.question("nobody@example.com")).question;
  assert.equal(q1, q2);
  assert.ok(PRESET_QUESTIONS.includes(q1));
  assert.equal(q1, decoyQuestion("nobody@example.com"));
  await assert.rejects(sec.reset("nobody@example.com", "anything", "new-password-1"), /doesn't match/);
  assert.equal(passwords.size, 0);
});

test("question and answer are validated", async () => {
  const { sec } = setup();
  await assert.rejects(sec.set("tok-a", "Pet?", "Rex"), /between 5 and 200/);
  await assert.rejects(sec.set("tok-a", "What was your first pet?", " ! "), /longer answer/);
  await assert.rejects(sec.question("not-an-email"), /valid email/);
});
