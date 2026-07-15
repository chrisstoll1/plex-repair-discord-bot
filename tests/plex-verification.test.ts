import assert from "node:assert/strict";
import test from "node:test";
import { advancePlexVerification, plexVerificationBlockedMessage, readPlexVerification } from "../src/agent/plex-verification.js";

test("Plex verification stops after two timed follow-up checks", () => {
  const initial = advancePlexVerification(undefined, { source: "webhook" }, ["S48E02", "S48E03"]);
  assert.deepEqual(initial, {
    state: { followUpChecks: 0, missingMedia: ["S48E02", "S48E03"] },
    exhausted: false,
  });

  const first = advancePlexVerification({ plexVerification: initial.state }, { source: "timer" }, ["S48E02", "S48E03"]);
  assert.equal(first.state.followUpChecks, 1);
  assert.equal(first.exhausted, false);

  const second = advancePlexVerification({ plexVerification: first.state }, { source: "timer" }, ["S48E02"]);
  assert.deepEqual(second, {
    state: { followUpChecks: 2, missingMedia: ["S48E02"] },
    exhausted: true,
  });
  assert.match(plexVerificationBlockedMessage(second.state), /S48E02/);
  assert.match(plexVerificationBlockedMessage(second.state), /needs to be checked manually/);
});

test("Plex verification checkpoint parsing rejects malformed state", () => {
  assert.equal(readPlexVerification(undefined), undefined);
  assert.equal(readPlexVerification({ plexVerification: "bad" }), undefined);
  assert.deepEqual(readPlexVerification({ plexVerification: { followUpChecks: -1, missingMedia: [" S01E01 ", "S01E01", 42] } }), {
    followUpChecks: 0,
    missingMedia: ["S01E01"],
  });
});
