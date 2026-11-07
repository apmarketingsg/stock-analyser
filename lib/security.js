// Secret-question password reset.
//
// Each user sets one question and answer while signed in. The answer is
// stored only as a salted scrypt hash in a table that browsers cannot read
// (row-level security with no policies); only this server, holding the
// Supabase secret key, can read it. To reset a forgotten password the user
// gives their email, answers the question, and picks a new password; the
// server checks the answer and sets the password through the Supabase admin API.
//
// Protections:
// * answers are compared as hashes in constant time
// * 5 wrong answers lock that account's reset for 15 minutes
// * an unknown email still gets a (made-up, stable) question, so the reset
//   form does not reveal which emails have accounts

import crypto from "node:crypto";

export const PRESET_QUESTIONS = [
  "What was the name of your first pet?",
  "What was the name of your primary school?",
  "In which city were you born?",
  "What was the make and model of your first car?",
  "What is the name of the street you grew up on?",
  "What was your childhood nickname?",
];
export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 8;

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Case, spacing and punctuation shouldn't matter: "Fluffy " == "fluffy". */
export function normaliseAnswer(a) {
  return String(a || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashAnswer(answer) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normaliseAnswer(answer), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkAnswer(answer, stored) {
  const [alg, n, saltB64, hashB64] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = crypto.scryptSync(normaliseAnswer(answer), Buffer.from(saltB64, "base64"), expected.length,
    { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(expected, got);
}

/** Stable made-up question for an email with no account, so the form doesn't leak which emails exist. */
export function decoyQuestion(email) {
  const h = crypto.createHash("sha256").update("decoy:" + email).digest();
  return PRESET_QUESTIONS[h[0] % PRESET_QUESTIONS.length];
}

const normEmail = (e) => String(e || "").trim().toLowerCase();

function validQuestion(q) {
  const s = String(q || "").trim();
  if (s.length < 5 || s.length > 200) throw new UserError("The question should be between 5 and 200 characters.");
  return s;
}

/**
 * deps = {
 *   getUserFromToken(token) -> { id, email } | null
 *   store: { getById(id), getByEmail(email), upsert(row), update(id, fields) }
 *   setPassword(userId, password)
 *   now() -> Date
 * }
 */
export function makeSecurity(deps) {
  const now = deps.now || (() => new Date());

  async function requireUser(token) {
    const user = token ? await deps.getUserFromToken(token) : null;
    if (!user) throw new UserError("Please sign in again.", 401);
    return user;
  }

  return {
    // Signed in: has this user set a question yet?
    async status(token) {
      const user = await requireUser(token);
      const row = await deps.store.getById(user.id);
      return { hasQuestion: Boolean(row), question: row?.question || null, presets: PRESET_QUESTIONS };
    },

    // Signed in: set or change the question and answer.
    async set(token, question, answer) {
      const user = await requireUser(token);
      const q = validQuestion(question);
      if (normaliseAnswer(answer).length < 2) throw new UserError("Please give a longer answer.");
      await deps.store.upsert({
        user_id: user.id,
        email: normEmail(user.email),
        question: q,
        answer_hash: hashAnswer(answer),
        failed_attempts: 0,
        locked_until: null,
      });
      return { ok: true, question: q };
    },

    // Signed out: which question should this email answer?
    async question(email) {
      const e = normEmail(email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UserError("Enter a valid email address.");
      const row = await deps.store.getByEmail(e);
      return { question: row ? row.question : decoyQuestion(e) };
    },

    // Signed out: check the answer and set a new password.
    async reset(email, answer, newPassword) {
      const e = normEmail(email);
      if (String(newPassword || "").length < MIN_PASSWORD) {
        throw new UserError(`The new password must be at least ${MIN_PASSWORD} characters.`);
      }
      const row = await deps.store.getByEmail(e);
      const wrong = new UserError("That answer doesn't match. Check the spelling and try again.", 403);
      if (!row) { checkAnswer(answer, hashAnswer("x")); throw wrong; } // similar timing to a real check

      if (row.locked_until && new Date(row.locked_until) > now()) {
        const mins = Math.ceil((new Date(row.locked_until) - now()) / 60000);
        throw new UserError(`Too many wrong answers. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 429);
      }
      if (!checkAnswer(answer, row.answer_hash)) {
        const attempts = (row.failed_attempts || 0) + 1;
        const lock = attempts >= MAX_ATTEMPTS;
        await deps.store.update(row.user_id, {
          failed_attempts: lock ? 0 : attempts,
          locked_until: lock ? new Date(now().getTime() + LOCK_MINUTES * 60000).toISOString() : null,
        });
        if (lock) throw new UserError(`Too many wrong answers. Try again in ${LOCK_MINUTES} minutes.`, 429);
        throw wrong;
      }
      await deps.setPassword(row.user_id, String(newPassword));
      await deps.store.update(row.user_id, { failed_attempts: 0, locked_until: null });
      return { ok: true };
    },
  };
}
