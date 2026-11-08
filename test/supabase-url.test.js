import { test } from "node:test";
import assert from "node:assert/strict";
import { supabaseBaseUrl } from "../lib/supabase-url.js";

test("keeps only the base address of the Supabase project", () => {
  const base = "https://abcd1234.supabase.co";
  for (const raw of [base, base + "/", base + "/rest/v1/", base + "/rest/v1", " " + base + "/auth/v1 ", "abcd1234.supabase.co", base + "/?x=1"]) {
    assert.equal(supabaseBaseUrl(raw), base, raw);
  }
  assert.equal(supabaseBaseUrl(""), "");
  assert.equal(supabaseBaseUrl(undefined), "");
});
