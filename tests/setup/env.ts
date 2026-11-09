/**
 * Feature flags the suite reads, pinned so a shell variable cannot silently change what is tested.
 *
 * `MAXX_COCKPIT_TRENDS=off` is a real switch with a real purpose — it suppresses the extra live Meta
 * Graph reads without a deploy. But nothing pinned it, so setting it (in CI, or in a dev shell that
 * exported it once) turned large parts of `cockpit-trend-claims`, `maxx-chat-message-bound` and
 * `maxx-tool-result-bound` red — a failing suite that says nothing about correctness, in exactly the
 * environment nobody is watching.
 *
 * The OFF behaviour is still tested: `cockpit-trend-kill-switch.test.ts` sets the variable itself,
 * per test, which is where a switch's behaviour belongs — not in ambient environment.
 */
delete process.env.MAXX_COCKPIT_TRENDS

// The example custom-conversion id used by the sync fixtures. Real installs set it in .env.local.
process.env.META_APPOINTMENT_CONVERSION_ID = '10000000000000002'
