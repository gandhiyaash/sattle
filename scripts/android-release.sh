#!/usr/bin/env bash
# Build a signed release APK and AAB locally, the same way the Android release workflow does.
#
#   KEYSTORE_BASE64="$(pbpaste)" scripts/android-release.sh      # base64 from the clipboard
#   pbpaste | scripts/android-release.sh                           # or piped in
#
# The keystore password is asked for if KEYSTORE_PASSWORD isn't set. Other inputs:
#
#   KEY_ALIAS      alias inside the keystore           (default: sattle)
#   KEY_PASSWORD   key password                         (default: the keystore password)
#   VERSION_CODE   Play build number, must keep rising  (default: 1)
#   VERSION_NAME   shown to users                       (default: apps/mobile/package.json)
#   EXPO_PUBLIC_API_URL / EXPO_PUBLIC_APP_URL           (default: the deployed hosts)
#
# Output lands in dist-android/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/apps/mobile"
OUT="$ROOT/dist-android"

die() { echo "error: $*" >&2; exit 1; }

# --- inputs -------------------------------------------------------------------------------

if [ -z "${KEYSTORE_BASE64:-}" ]; then
  # A terminal truncates pasted lines at 1024 bytes on macOS, so a keystore can't be typed in.
  [ -t 0 ] && die 'pass the keystore as KEYSTORE_BASE64="$(pbpaste)" or pipe it in'
  KEYSTORE_BASE64="$(cat)"
fi
if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
  # stdin may have carried the keystore, so ask on the terminal itself.
  read -rsp 'Keystore password: ' KEYSTORE_PASSWORD < /dev/tty
  echo
fi
[ -n "$KEYSTORE_PASSWORD" ] || die 'empty keystore password'

KEY_ALIAS="${KEY_ALIAS:-sattle}"
KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-$(node -p "require('$MOBILE/package.json').version")}"
[[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || die "VERSION_CODE must be a number, got '$VERSION_CODE'"

export EXPO_PUBLIC_USE_MOCK=false
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://battle.axiosiiitl.dev}"
export EXPO_PUBLIC_APP_URL="${EXPO_PUBLIC_APP_URL:-https://sattle.axiosiiitl.dev}"

# --- keystore -----------------------------------------------------------------------------

KEYSTORE="$(mktemp -t sattle-release).keystore"
cleanup() { rm -f "$KEYSTORE" "${KEYSTORE%.keystore}"; }
trap cleanup EXIT

# Strip whitespace so a wrapped or newline-terminated paste still decodes.
printf '%s' "$KEYSTORE_BASE64" | tr -d ' \n\r\t' | base64 --decode > "$KEYSTORE" 2>/dev/null \
  || die 'KEYSTORE_BASE64 is not valid base64'

# Fail here, not ten minutes into Gradle, on a wrong password or alias.
keytool -list -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASSWORD" -alias "$KEY_ALIAS" > /dev/null 2>&1 \
  || die "keystore won't open with that password, or has no alias '$KEY_ALIAS'"

# --- build --------------------------------------------------------------------------------

echo "Building v$VERSION_NAME ($VERSION_CODE) against $EXPO_PUBLIC_API_URL"

# prebuild rewrites the android/ios scripts in package.json; put them back afterwards.
cp "$MOBILE/package.json" "$KEYSTORE.package.json"
trap 'mv -f "$KEYSTORE.package.json" "$MOBILE/package.json"; cleanup' EXIT
# --clean regenerates android/ from app.json and the signing plugin, so stale native
# files from an older config can't end up in a release.
(cd "$MOBILE" && CI=1 npx expo prebuild --platform android --clean --no-install)

# Gradle reads ORG_GRADLE_PROJECT_<name> as -P<name>, which keeps passwords out of `ps`.
(
  cd "$MOBILE/android"
  export ORG_GRADLE_PROJECT_SATTLE_VERSION_CODE="$VERSION_CODE"
  export ORG_GRADLE_PROJECT_SATTLE_VERSION_NAME="$VERSION_NAME"
  export ORG_GRADLE_PROJECT_SATTLE_UPLOAD_STORE_FILE="$KEYSTORE"
  export ORG_GRADLE_PROJECT_SATTLE_UPLOAD_STORE_PASSWORD="$KEYSTORE_PASSWORD"
  export ORG_GRADLE_PROJECT_SATTLE_UPLOAD_KEY_ALIAS="$KEY_ALIAS"
  export ORG_GRADLE_PROJECT_SATTLE_UPLOAD_KEY_PASSWORD="$KEY_PASSWORD"
  ./gradlew assembleRelease bundleRelease
)

# --- output -------------------------------------------------------------------------------

mkdir -p "$OUT"
NAME="sattle-$VERSION_NAME-$VERSION_CODE"
cp "$MOBILE/android/app/build/outputs/apk/release/app-release.apk" "$OUT/$NAME.apk"
cp "$MOBILE/android/app/build/outputs/bundle/release/app-release.aab" "$OUT/$NAME.aab"

# Prove the APK carries the release key, not the debug one.
APKSIGNER="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/*/apksigner 2>/dev/null | tail -1)"
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$OUT/$NAME.apk" | grep -m1 'certificate DN' || true
fi

echo
echo "APK: $OUT/$NAME.apk"
echo "AAB: $OUT/$NAME.aab"
