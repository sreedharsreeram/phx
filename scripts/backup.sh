#!/bin/sh
# Back up the paid redraw cache and the current tiles for a map to S3 (private bucket). Usage: scripts/backup.sh [map]
MAP=${1:-tempe}; B=s3://smallphx-art-216989103356
aws s3 sync "out/$MAP/redraw-cache" "$B/$MAP/redraw-cache" --size-only --quiet
aws s3 sync "public/maps/$MAP" "$B/$MAP/public" --size-only --quiet --exclude "tiles/*" 
echo "backed up $MAP: $(aws s3 ls "$B/$MAP/redraw-cache/" | wc -l | tr -d ' ') cached windows"
