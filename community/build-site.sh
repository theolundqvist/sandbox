#!/bin/sh
# The site uses the game's own front end: its styles, font and menu code.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp -r site/* dist/
cp ../engine/client/front.css ../engine/client/front.js dist/
cp -r ../engine/client/fonts dist/
