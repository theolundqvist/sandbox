#!/bin/sh
# The site uses the game's own front end: its styles, font, menu code and backdrop clips.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/clips
cp site/* dist/
cp ../engine/client/front.css ../engine/client/front.js dist/
cp -r ../engine/client/fonts dist/
cp ../engine/client/clips/poster.jpg ../engine/client/clips/lava.mp4 ../engine/client/clips/night-aurora.mp4 ../engine/client/clips/giant-vote.mp4 dist/clips/
