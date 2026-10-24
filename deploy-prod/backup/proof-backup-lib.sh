# shellcheck shell=bash
# Pure helpers for proof-backup.sh (nightly copy of the private proof files into the backups
# bucket, docs/plans/purchase-payments.md A7) and for monitoring/backup-check.sh's proof section.
# Split out so deploy-prod/tests/proof-backup.test.sh can run them without a server. Must stay safe
# under macOS bash 3.2 with `set -u` (the tests run there): no mapfile, no associative arrays
# (awk does the set arithmetic), every possibly-empty array expanded as ${arr[@]+"${arr[@]}"}.
#
# A listing is one object per line, "KEY<TAB>SIZE", the shape `aws s3api list-objects-v2 --query
# 'Contents[].[Key,Size]' --output text` prints (it prints a lone "None" for an empty page).

# Where the copies live inside the backups bucket. The bucket's other prefixes (backups/daily,
# backups/weekly) belong to pg-backup.sh; nothing here ever lists or writes outside this one.
# shellcheck disable=SC2034 # read by the scripts that source this file
PROOF_BACKUP_DEST_PREFIX="private-files/"

# Reads plain "KEY=value" lines (docker-compose env_file format, no quoting, no expansion) without
# `source`, same as pg-backup.sh's own load_env_file.
proof_load_env_file() {
  local file="$1" line key value
  if [ ! -f "$file" ]; then
    echo "Missing env file: $file" >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "" | "#"*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      *[!A-Za-z0-9_]* | [0-9]*) continue ;;
    esac
    value="${line#*=}"
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done <"$file"
}

# 0 when KEY is a storage key this job may copy: the characters buildPrivateFileKey produces
# (prefix, purpose, yyyy/mm, uuid.ext), no "..", no empty path segment, no leading slash. Anything
# else is reported and skipped, never interpolated into a path or an S3 URL.
proof_key_is_safe() {
  local key="$1"
  case "$key" in
    "" | /* | */ | *//* | *..*) return 1 ;;
  esac
  case "$key" in
    *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  return 0
}

# stdin: raw list-objects-v2 text output. stdout: "KEY<TAB>SIZE" lines, sorted by key, without the
# "None" marker, blank lines or a CR. A line that is not KEY<TAB>non-negative-integer is kept as
# is with size "?", so the caller's safety check reports it instead of it silently vanishing.
proof_normalize_listing() {
  tr -d '\r' | awk -F '\t' '
    $0 == "" || $0 == "None" { next }
    NF == 2 && $2 ~ /^[0-9]+$/ { print $1 "\t" $2; next }
    { print $0 "\t?" }
  ' | LC_ALL=C sort
}

# $1 normalized SOURCE listing, $2 normalized DESTINATION listing, $3 destination prefix.
# Prints the source lines whose key (with the prefix) is not in the destination yet. Presence is
# what counts: keys are never reused and proof files are immutable (private_files rows and the
# private storage client have no update or delete), so an existing copy is never rewritten.
proof_keys_to_copy() {
  # FILENAME, not the FNR == NR idiom: that one breaks when the first file is EMPTY (a first run's
  # destination listing), silently treating every source line as already present.
  awk -F '\t' -v prefix="$3" '
    FILENAME == ARGV[1] { have[$1] = 1; next }
    !((prefix $1) in have) { print $1 "\t" $2 }
  ' "$2" "$1"
}

# $1 normalized SOURCE listing (the keys that must be backed up), $2 normalized DESTINATION
# listing, $3 destination prefix. Prints one line per source key whose copy is missing or has a
# different size; nothing when every copy is there.
proof_verify_copies() {
  awk -F '\t' -v prefix="$3" '
    FILENAME == ARGV[1] { size[$1] = $2; next }
    {
      k = prefix $1
      if (!(k in size)) print "missing: " $1
      else if (size[k] != $2) print "size differs: " $1 " (source " $2 ", backup " size[k] ")"
    }
  ' "$2" "$1"
}

# The two content types private_files allows (migration 0038's CHECK); anything else is octet.
proof_content_type() {
  case "$1" in
    *.jpg | *.jpeg) echo "image/jpeg" ;;
    *.pdf) echo "application/pdf" ;;
    *) echo "application/octet-stream" ;;
  esac
}

# Prints the last-proof-backup-status.json body. All arguments are non-secret: a timestamp, two
# counts and the destination (bucket name + prefix).
proof_status_json() {
  local timestamp="$1" source_objects="$2" copied="$3" destination="$4"
  printf '{\n  "timestamp": "%s",\n  "source_objects": %s,\n  "copied": %s,\n  "destination": "%s"\n}\n' \
    "$timestamp" "$source_objects" "$copied" "$destination"
}

# Prints the "timestamp" field of a status file (pg-backup.sh's or this job's), or nothing.
proof_status_timestamp() {
  [ -f "$1" ] || return 0
  grep -o '"timestamp"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/' || true
}

# Prints the "source_objects" count of this job's status file, or nothing.
proof_status_source_objects() {
  [ -f "$1" ] || return 0
  grep -o '"source_objects"[[:space:]]*:[[:space:]]*[0-9]*' "$1" | sed -E 's/.*:[[:space:]]*//' || true
}

# "YYYY-MM-DD_HHMM" (Asia/Jakarta, the format both backup jobs write) -> epoch seconds, with GNU
# date (the VPS) or BSD date (macOS, the tests). Returns 1 on anything that does not parse.
proof_ts_to_epoch() {
  local ts="$1" date_part time_part
  case "$ts" in
    [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]_[0-2][0-9][0-5][0-9]) ;;
    *) return 1 ;;
  esac
  date_part="${ts%_*}"
  time_part="${ts#*_}"
  TZ=Asia/Jakarta date -d "$date_part ${time_part:0:2}:${time_part:2:2}" +%s 2>/dev/null ||
    TZ=Asia/Jakarta date -j -f "%Y-%m-%d %H%M%S" "$date_part ${time_part}00" +%s 2>/dev/null
}

# backup-check.sh's proof section. $1 status file, $2 now (epoch seconds), $3 stale threshold in
# hours. Prints one issue line, or nothing when the last successful run is fresh.
proof_status_issue() {
  local file="$1" now="$2" stale_hours="$3" ts epoch
  if [ ! -f "$file" ]; then
    echo "proof-file backup status file is missing ($file): the nightly proof backup may never have run"
    return 0
  fi
  ts="$(proof_status_timestamp "$file")"
  if [ -z "$ts" ]; then
    echo "proof-file backup status file has no parseable \"timestamp\" field"
    return 0
  fi
  if ! epoch="$(proof_ts_to_epoch "$ts")" || [ -z "$epoch" ]; then
    echo "proof-file backup status timestamp ($ts) could not be parsed"
    return 0
  fi
  # A timestamp from the future means a wrong clock or a hand-written file, never a real run.
  if [ "$((epoch - now))" -gt 3600 ]; then
    echo "proof-file backup status timestamp ($ts) is in the future"
    return 0
  fi
  if [ "$((now - epoch))" -gt "$((stale_hours * 3600))" ]; then
    echo "proof-file backup is stale: last successful copy was $ts (over ${stale_hours}h ago)"
  fi
}
