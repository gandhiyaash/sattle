# Native builds of the mobile app. `expo run:*` runs prebuild first if android/ or ios/
# is missing, then builds, installs and starts Metro. Pass extra flags through, e.g.
# `just android --device` or `just ios --device "My iPhone"`.

mobile := "apps/mobile"

# Expo 57's precompiled iOS modules are built with Swift 6.3 and don't load under Xcode 27's
# Swift 6.4, so every iOS build here compiles them from source, which works with either.
export EXPO_USE_PRECOMPILED_MODULES := "0"

default:
    @just --list

# Build and run on an Android emulator or connected device
android *args:
    cd {{mobile}} && npx expo run:android {{args}}

# Build and run on the iOS simulator or a connected device
ios *args:
    cd {{mobile}} && npx expo run:ios {{args}}

# Standalone install on a connected iPhone: a release build with the JS bundled in, so it
# runs without Metro, against the URLs in apps/mobile/.env. Asks which device unless one is
# named. Signed for the team in app.json (ios.appleTeamId), whose account Xcode must be signed in to.
ios-install *args:
    cd {{mobile}} && npx expo run:ios --configuration Release --no-bundler --device {{args}}

# Signed release APK + AAB into dist-android/. KEYSTORE_BASE64="$(pbpaste)" just android-release
android-release:
    scripts/android-release.sh

# App Store build, uploaded to App Store Connect (TestFlight). UPLOAD=0 keeps the .ipa in dist-ios/.
# EXPO_PUBLIC_API_URL=https://… EXPO_PUBLIC_APP_URL=https://… just ios-release
ios-release:
    scripts/ios-release.sh
