#!/usr/bin/env bash
set -euo pipefail

# Read-only release check. The CAPI sender posts to Meta in "test" and "live" modes; the campaign
# executor only mutates the ad account when WRITE_MODE_ENABLED is exactly "true". Both must be off
# (unset, "off" or "false") in the environment that runs the release check, so a future change to
# either gate cannot silently arm a release job.
case "${ACUITY_CAPI_SEND-}" in
  ""|off) ;;
  *) echo 'ACUITY_CAPI_SEND must be unset or "off" for the read-only release check.' >&2; exit 1 ;;
esac

case "${WRITE_MODE_ENABLED-}" in
  ""|off|false) ;;
  *) echo 'WRITE_MODE_ENABLED must be unset, "off" or "false" for the read-only release check.' >&2; exit 1 ;;
esac
echo "read-only release check: CAPI sender and Meta executor are off"
