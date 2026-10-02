# Native builds of the mobile app. `expo run:*` runs prebuild first if android/ or ios/
# is missing, then builds, installs and starts Metro. Pass extra flags through, e.g.
# `just android --device` or `just ios --device "My iPhone"`.

mobile := "apps/mobile"

default:
    @just --list

# Build and run on an Android emulator or connected device
android *args:
    cd {{mobile}} && npx expo run:android {{args}}

# Build and run on the iOS simulator or a connected device
ios *args:
    cd {{mobile}} && npx expo run:ios {{args}}
