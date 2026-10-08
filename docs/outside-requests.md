# Requests to people outside the project

Drafts for the items of [issue #50](https://github.com/mbalyi/smart-beat/issues/50) that need someone else to say yes, or to publish something. **Nothing here has been sent.** Read each draft, change what you want, and send it from your own account. Put the answer (and the date) in the document or the issue it belongs to.

## 1. Jester Dyne Productions: bundling the Brutal and Emerald IR packs

**Why:** the packs are "free even for commercial use" for making music, but there is no licence text, and nothing says the files may be redistributed inside software. Bundling them would replace two generated cabinets with recorded ones ([sound-presets-research.md](sound-presets-research.md), "Next steps"). Until there is written permission they stay **import only** (users load them into the sound library themselves).

**To:** the contact on <https://www.jester-dyne-productions.com/brutal-ir-pack/>.

> Subject: Permission to include your Brutal and Emerald IR packs in a free guitar app
>
> Hello,
>
> I am building Smart Beat, a desktop app for reading, editing and playing back guitar tab and scores (a modern replacement for Guitar Pro 5 on the Mac). It is free to download; its code is not open source.
>
> Your Brutal (Vintage 30, 4×12) and Emerald (Greenback, 4×12) impulse response packs are exactly the cabinets heavier styles need, and they are free for commercial use for making music. Your pages do not say whether the files may be shipped inside software, so I am asking before I do anything with them.
>
> Would you allow Smart Beat to include the Brutal and Emerald IR files as built-in cabinets, unchanged, for free, in every copy of the app? If yes, I would:
>
> - show your name, the pack names and a link to your site in the app's About and Licenses screens and in the sound's description;
> - keep the files unchanged (no re-selling them on their own, no separate download);
> - remove them in a later version if you ask me to.
>
> If you would rather keep them out of software, that is fine too: users will still be able to import them themselves.
>
> A short written reply (an email is enough) would let me keep it on file.
>
> Thank you,
> [Your name], [email], [link to the project or the app]

**If yes:** keep the email in the repository's private notes, add the notice to `about.toml`/the licences page, then bundle the files (a separate change). **If no or no answer:** nothing changes; the research doc already says import only.

Also in that research table: the freesound.org `jesterdyne` AX15 packs have a licence per file (CC0, CC-BY or CC-BY-NC). Only CC0 and CC-BY files could ever be bundled; check each one before any of them is.

## 2. Matthieu Leschemelle: the TablEdit (`.tef`) specification

**Why:** TablEdit's binary format has no public specification. Its author shares it on request (that is how MuseScore's importer was written). Smart Beat's code is source-available under a noncommercial licence and may also be licensed commercially, so the request must say that commercial use is wanted; otherwise the specification cannot be used here ([file-formats.md](file-formats.md), "Not supported yet").

**To:** the contact on <https://www.tabledit.com/>.

> Subject: TablEdit file format specification, for a free reader in Smart Beat
>
> Hello Mr Leschemelle,
>
> I am building Smart Beat, a desktop app for reading, editing and playing back guitar tab and scores. It opens Guitar Pro, MusicXML, MIDI and MuseScore files, and TablEdit users keep asking me for `.tef`. I would like to add a reader (opening files only, to start with).
>
> I understand you share the TablEdit file format specification on request. Could you send it to me, and tell me what the terms are? The app is free to download, its source code is published under a noncommercial licence (not open source), and I may license it commercially, so I need the specification to be usable in a product like that, and I would put your name and a link to TablEdit in the app wherever it lists what it opens.
>
> If you would rather not allow that, I understand, and I will not use or look at any other source for the format.
>
> Thank you,
> [Your name], [email], [link]

**If yes:** keep the specification out of the repository unless its terms allow it; write the reader clean-room from it. **If no:** `.tef` stays unsupported.

## 3. alphaTab: two reports for <https://github.com/CoderLine/alphaTab/issues>

Smart Beat uses alphaTab 1.8.4. Search the issues first; if either is already reported, add a comment with the missing detail instead. When both are fixed in a release we upgrade to, delete `src/lib/score/alphatab-fixes.ts` and its test, and the Capella note in [file-formats.md](file-formats.md).

### 3a. Capella import fails on every file that has a note

> **Title:** Capella (`.capx`) import: chord measured before it is added to its voice, so every file with a note fails to load (1.8.4)
>
> **Version:** 1.8.4 (also checked against the source of the current dist build).
>
> **What happens:** loading a `.capx` file that contains at least one note with `ScoreLoader.loadScoreFromBytes` throws `No compatible importer found for file` (the importer loop hides the real exception, and `CapellaImporter` is not exported, so it cannot be called on its own).
>
> **Cause (what we found):** `CapellaParser` asks a new chord for its length before the chord has been added to its voice. `Beat.isFullBarRest` is
> `return this.isRest && this.voice.beats.length === 1 && this.duration === Duration.Whole;`
> and on a beat that has no voice yet, `new model.Beat().isFullBarRest` throws `TypeError: Cannot read properties of undefined (reading 'beats')`. With a guard for that case the same files open normally (see below).
>
> **Reproduce:** attach a minimal file (ours is a synthetic one-bar `.capx`: `e2e/fixtures/practice-song.capx` in the Smart Beat repository; it is a ZIP holding a `score.xml` with a few notes).
>
> **Workaround we use:** a beat without a voice answers `isFullBarRest` with `false` and every other beat is unchanged:
> `get() { return this.voice ? original.call(this) : false; }`
>
> **Suggested fix:** guard on `this.voice` in `isFullBarRest`, or add the chord to its voice before measuring it.

### 3b. Capella repeat counts are only read from voltas

> **Title:** Capella import: the number of repeats is only taken from volta draw objects
>
> **Version:** 1.8.4.
>
> **What I see:** in `CapellaParser`, `MasterBar.repeatCount` is only set from `_applyVolta` (the numbers of a volta draw object, `firstNumber` / `lastNumber`). A `repEnd` / `repEndBegin` barline without a volta never sets a count, so a plain repeat that Capella plays three times is imported as a repeat that plays twice.
>
> **Question:** does Capella store the count somewhere else (on the barline, or in a `repeat` attribute of the bar) that the importer could read? I can attach a file with a plain ×3 repeat made in Capella if that helps.
>
> **Note:** I could not check this against a Capella-made file with a counted plain repeat; the report is based on reading the importer. Please close it if Capella has no such count.

**Before sending 3b:** make a file with a plain repeat played three times in Capella (or ask someone who has it), and confirm the behaviour, so the report is not a guess. If you cannot, send only 3a.

## 4. Power Tab (`.ptb`) and TuxGuitar (`.tg`): nobody to ask

Neither format has a public specification. The only readers are Power Tab Editor 2 (GPL-3) and TuxGuitar (LGPL-2.1), and Smart Beat may not port or read that code to write its own reader ([licensing.md](licensing.md), [ADR 0001](adr/0001-project-license.md)). Unless someone publishes a written description of the format under terms that allow commercial use, or its authors grant that in writing, these two stay unsupported. A request could go to the Power Tab Editor 2 maintainers (<https://github.com/powertab/powertabeditor>) or TuxGuitar's (<https://github.com/helge17/tuxguitar>) asking whether a specification or a licence exception exists; there is no draft because the answer is very likely no.
