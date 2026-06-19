#!/usr/bin/env bash
#
# Upload the how-to-use-the-app tutorial videos to the TutorialAssets bucket, under
# the `tutorials/` key prefix that DEFAULT_TUTORIALS (packages/api/src/index.ts) and
# the `Cdn` Router (sst.config.ts) expect. Run AFTER `sst deploy` has created the
# bucket. See docs/guides/tutorial-videos.md for the full runbook.
#
# Usage:
#   scripts/upload-tutorials.sh <bucket-name> [source-dir]
#
#   <bucket-name>  TutorialAssets bucket (the `tutorialBucket` value printed by `sst deploy`).
#   [source-dir]   Folder holding the raw recordings. Default: ~/Downloads/Tutorial videos
#
set -euo pipefail

BUCKET="${1:?Pass the TutorialAssets bucket name (see 'tutorialBucket' in sst deploy output)}"
SRC="${2:-$HOME/Downloads/Tutorial videos}"
PROFILE="${AWS_PROFILE:-medicoach}"
REGION="${AWS_REGION:-af-south-1}"

# Raw filename  =>  canonical key (must match DEFAULT_TUTORIALS). One pair per line.
MAP=(
  "Smart Club Tutorial_full.mp4|00-full-walkthrough.mp4"
  "Step 1_Creating your account.mp4|01-creating-account.mp4"
  "Step 2_ Completing the affiliation form.mp4|02-affiliation.mp4"
  "Step 3_Uploading compliance forms.mp4|03-compliance-forms.mp4"
  "step 4_ Completing the CQI.mp4|04-cqi.mp4"
  "Step 5_Onboarding players.mp4|05-onboarding-players.mp4"
  "Step 6_Player Clearances.mp4|06-clearances.mp4"
)

echo "Bucket : s3://$BUCKET/tutorials/"
echo "Source : $SRC"
echo "Profile: $PROFILE   Region: $REGION"
echo

for pair in "${MAP[@]}"; do
  raw="${pair%%|*}"
  key="${pair##*|}"
  if [[ ! -f "$SRC/$raw" ]]; then
    echo "MISSING: $raw — skipping" >&2
    continue
  fi
  echo "↑ $raw  ->  tutorials/$key"
  # No --only-show-errors: progress matters on the multi-GB full cut, and a stalled
  # transfer should be visible. `aws s3 cp` auto-multiparts >8 MB and is safe to re-run
  # per-file if the loop aborts mid-set.
  aws s3 cp "$SRC/$raw" "s3://$BUCKET/tutorials/$key" \
    --profile "$PROFILE" --region "$REGION" \
    --content-type video/mp4 \
    --cache-control "public,max-age=86400"
done

echo
echo "Done. Verify the object serves over HTTPS (expect 200 + accept-ranges: bytes):"
echo "  curl -I https://$BUCKET.s3.$REGION.amazonaws.com/tutorials/01-creating-account.mp4"
