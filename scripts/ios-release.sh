#!/usr/bin/env bash
# Build the iOS app for the App Store and upload it to App Store Connect, where it shows up in
# TestFlight and can be sent for review. Runs on a Mac with Xcode and CocoaPods; the iOS release
# workflow runs it too.
#
#   EXPO_PUBLIC_API_URL=https://… EXPO_PUBLIC_APP_URL=https://… scripts/ios-release.sh
#
# Inputs:
#
#   EXPO_PUBLIC_API_URL / EXPO_PUBLIC_APP_URL                required, as https://<host>, no path
#   VERSION_NAME          shown on the App Store   (default: the newest vX.Y.Z tag, else package.json)
#   BUILD_NUMBER          must rise with every upload                (default: minutes since 1970)
#   UPLOAD                0 exports the .ipa into dist-ios/ instead of uploading     (default: 1)
#   PROVISIONING_PROFILE  name or UUID of an installed App Store profile. Signs by hand as Apple
#                         Distribution with it. Unset, Xcode signs by itself through the account
#                         signed in under Xcode > Settings > Accounts, making what it needs.
#   ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH
#                         an App Store Connect API key (.p8). Used for signing and uploading in
#                         place of the Xcode account; a machine with none, like CI, needs one.
#
# Output lands in dist-ios/: the archive always, which Xcode's Organizer can open to upload by
# hand if the upload fails, and the .ipa with UPLOAD=0.
#
# It deletes and regenerates apps/mobile/ios, so build nothing else from there while it runs:
# Xcode or `just ios` working in the same folder pulls files out from under the archive.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/apps/mobile"
OUT="$ROOT/dist-ios"

die() { echo "error: $*" >&2; exit 1; }

# --- inputs -------------------------------------------------------------------------------

command -v xcodebuild > /dev/null || die 'xcodebuild not found: install Xcode'
command -v pod > /dev/null || die 'CocoaPods not found: brew install cocoapods'

# As in the Android release: nothing here names a host.
for name in EXPO_PUBLIC_API_URL EXPO_PUBLIC_APP_URL; do
  [ -n "${!name:-}" ] || die "set $name to https://<host>"
  [[ "${!name}" =~ ^https://[^/[:space:]]+$ ]] || die "$name must be https://<host>, with no path, no trailing slash and no whitespace, got '${!name}'"
done
export EXPO_PUBLIC_API_URL EXPO_PUBLIC_APP_URL

# Expanded as ${ASC_KEY[@]+"${ASC_KEY[@]}"}: macOS's own bash 3.2 calls an empty array unbound under set -u.
ASC_KEY=()
if [ -n "${ASC_KEY_ID:-}${ASC_ISSUER_ID:-}${ASC_KEY_PATH:-}" ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ] \
    || die 'an App Store Connect key needs all three of ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH'
  [ -f "$ASC_KEY_PATH" ] || die "no key file at ASC_KEY_PATH ($ASC_KEY_PATH)"
  ASC_KEY=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

# Releases are tags only (see android-release.yml), so the newest tag is the current version.
LATEST_TAG="$(git -C "$ROOT" tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
VERSION_NAME="${VERSION_NAME:-${LATEST_TAG#v}}"
VERSION_NAME="${VERSION_NAME:-$(node -p "require('$MOBILE/package.json').version")}"
[[ "$VERSION_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION_NAME must be X.Y.Z, got '$VERSION_NAME'"
# App Store Connect turns away a build number it has had for this version. Minutes since 1970 keep
# rising, and the Android release uses the same clock for its version code.
BUILD_NUMBER="${BUILD_NUMBER:-$(( $(date +%s) / 60 ))}"
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || die "BUILD_NUMBER must be a number, got '$BUILD_NUMBER'"
UPLOAD="${UPLOAD:-1}"
BUNDLE_ID="$(node -p "require('$MOBILE/app.json').expo.ios.bundleIdentifier")"
# prebuild signs the project for this team too.
TEAM_ID="$(node -p "require('$MOBILE/app.json').expo.ios.appleTeamId")"

export EXPO_PUBLIC_USE_MOCK=false
# What the app says it is when it reports how it's used (apps/mobile/src/analytics).
export EXPO_PUBLIC_APP_VERSION="$VERSION_NAME"
# Expo 57's precompiled modules are built with Swift 6.3 and don't load under Xcode 27's Swift
# 6.4. Built from source they work with either; a release can afford the extra minutes.
export EXPO_USE_PRECOMPILED_MODULES=0

# --- project ------------------------------------------------------------------------------

WORK="$(mktemp -d -t sattle-ios)"
# prebuild rewrites the android/ios scripts in package.json; put them back afterwards.
cp "$MOBILE/package.json" "$WORK/package.json"
trap 'mv -f "$WORK/package.json" "$MOBILE/package.json"; rm -rf "$WORK"' EXIT

echo "Building v$VERSION_NAME ($BUILD_NUMBER) against $EXPO_PUBLIC_API_URL"

# --clean regenerates ios/ from app.json and the plugins, so stale native files from an older
# config can't end up in a release. It installs the pods too.
(cd "$MOBILE" && CI=1 npx expo prebuild --platform ios --clean)

WORKSPACE="$(ls -d "$MOBILE"/ios/*.xcworkspace | head -n1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
# prebuild writes app.json's version into Info.plist as plain values, so they are set here.
PLIST="$MOBILE/ios/$SCHEME/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION_NAME" -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"

# --- archive ------------------------------------------------------------------------------

if [ -n "${PROVISIONING_PROFILE:-}" ]; then
  # Read by the app target alone (plugins/withIosReleaseSigning).
  SIGN_ARCHIVE=(SATTLE_CODE_SIGN_STYLE=Manual 'SATTLE_CODE_SIGN_IDENTITY=Apple Distribution' "SATTLE_PROVISIONING_PROFILE=$PROVISIONING_PROFILE")
  SIGN_EXPORT=(${ASC_KEY[@]+"${ASC_KEY[@]}"})
  EXPORT_SIGNING="<key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$PROVISIONING_PROFILE</string></dict>"
else
  SIGN_ARCHIVE=(-allowProvisioningUpdates ${ASC_KEY[@]+"${ASC_KEY[@]}"})
  SIGN_EXPORT=(-allowProvisioningUpdates ${ASC_KEY[@]+"${ASC_KEY[@]}"})
  EXPORT_SIGNING="<key>signingStyle</key><string>automatic</string>"
fi

mkdir -p "$OUT"
NAME="sattle-$VERSION_NAME-$BUILD_NUMBER"
ARCHIVE="$OUT/$NAME.xcarchive"
rm -rf "$ARCHIVE"

# DerivedData of its own, shared with no dev build or open Xcode: the shared one remembers the
# ios/ that prebuild just replaced, and fails with "failed to find blueprint corresponding to PIF
# GUID" on the new project's ids. It goes with $WORK at the end.
xcodebuild archive -quiet \
  -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$WORK/DerivedData" \
  "${SIGN_ARCHIVE[@]}"

# --- export -------------------------------------------------------------------------------

[ "$UPLOAD" = 1 ] && DESTINATION=upload || DESTINATION=export
cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>teamID</key><string>$TEAM_ID</string>
  $EXPORT_SIGNING
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" \
  ${SIGN_EXPORT[@]+"${SIGN_EXPORT[@]}"}

echo
echo "Archive: $ARCHIVE"
if [ "$UPLOAD" = 1 ]; then
  echo "Uploaded v$VERSION_NAME ($BUILD_NUMBER) to App Store Connect. It shows in TestFlight once Apple has processed it."
else
  mv "$WORK"/export/*.ipa "$OUT/$NAME.ipa"
  echo "IPA: $OUT/$NAME.ipa"
fi
