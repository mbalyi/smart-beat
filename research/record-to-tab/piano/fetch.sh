#!/bin/sh
# Downloads the public-domain pieces (Mutopia Project) and the CC-BY piano sound set (FreePats)
# into data/ (git-ignored). Run from this folder.
set -e
mkdir -p data
B=https://www.mutopiaproject.org/ftp
get() { curl -fsSL -o "data/$(basename "$2").mid" "$B/$1/$2/$3"; }
get BachJS/BWV846 wtk1-prelude1 wtk1-prelude1.mid
get SatieE gymnopedie_1 gymnopedie_1.mid
get ChopinFF/O28 Chop-28-7 "$(curl -fsSL $B/ChopinFF/O28/Chop-28-7/ | grep -oE 'href="[^"]+\.mid"' | head -1 | cut -d'"' -f2)"
get ChopinFF/O28 Chop-28-15 "$(curl -fsSL $B/ChopinFF/O28/Chop-28-15/ | grep -oE 'href="[^"]+\.mid"' | head -1 | cut -d'"' -f2)"
get ChopinFF/O9 chopin_nocturne_op9_n2 "$(curl -fsSL $B/ChopinFF/O9/chopin_nocturne_op9_n2/ | grep -oE 'href="[^"]+\.mid"' | head -1 | cut -d'"' -f2)"
get BeethovenLv/O13 pathetique-2 "$(curl -fsSL $B/BeethovenLv/O13/pathetique-2/ | grep -oE 'href="[^"]+\.mid"' | head -1 | cut -d'"' -f2)"
curl -fsSL -o data/ydp.tar.bz2 http://freepats.zenvoid.org/Piano/YDP-GrandPiano/YDP-GrandPiano-SF2-20160804.tar.bz2
tar xjf data/ydp.tar.bz2 -C data
shasum -a 256 data/*.mid data/*/*.sf2
