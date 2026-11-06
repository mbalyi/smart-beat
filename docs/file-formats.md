# File formats

What Smart Beat opens, saves and exports, and what each format cannot hold.

| Format              | Extensions                | Open                                     | Save / export                                                   |
| ------------------- | ------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| Guitar Pro 7/8      | `.gp`                     | Yes                                      | **Native format**: File › Save, Save As                         |
| Guitar Pro 5        | `.gp5`                    | Yes                                      | File › Save, Save As (limits below)                             |
| Guitar Pro 4        | `.gp4`                    | Yes                                      | File › Save As (limits below)                                   |
| Guitar Pro 3        | `.gp3`                    | Yes                                      | File › Save As (limits below)                                   |
| Guitar Pro 6        | `.gpx`                    | Yes                                      | No (see [below](#guitar-pro-6-gpx-open-only))                   |
| MuseScore 3 / 4     | `.mscz` `.mscx`           | Yes (own importer)                       | File › Save As (limits below)                                   |
| MusicXML (partwise) | `.musicxml` `.xml` `.mxl` | Yes (via alphaTab)                       | File › Export › MusicXML (type `.mxl` for the compressed form)  |
| Standard MIDI       | `.mid` `.midi`            | Yes (own importer)                       | File › Export › MIDI                                            |
| alphaTex            | `.atex`                   | Yes (via alphaTab)                       | File › Export › alphaTex                                        |
| ASCII tab           | `.txt`                    | Yes (own importer)                       | File › Export › ASCII tab                                       |
| Smart Beat stems    | `.sbstems`                | Yes (Open saved stems, double-click)     | Save stems on the stem page (see [below](#saved-stems-sbstems)) |
| Audio               | `.wav` `.m4a`             | (audio track: mp3, wav, flac, ogg, aiff) | File › Export › Audio (WAV), Audio (M4A, macOS only)            |

**Save** writes back into the file the song came from only for `.gp` and `.gp5`. A `.gp3`, `.gp4`, `.mscz` or `.mscx` file opened from disk is never overwritten by Save: it asks for a new file, and Save As offers every format above. The writers for these are checked by reading the files back with alphaTab and with Smart Beat's own importer, not in Guitar Pro 3/4 or MuseScore themselves (see [manual-checks.md](manual-checks.md)), so they should not replace an original unasked.

Songs opened from MIDI, MusicXML, MuseScore or text are _converted_: Save never overwrites the original file, it asks for a new `.gp` file.

## Native format: Guitar Pro 7 (`.gp`)

The native format is a Guitar Pro 7 file. It is an open container (a ZIP archive holding an XML score and small configuration files), it is written by alphaTab's exporter (MPL-2.0, the library Smart Beat already uses to read and render scores), and Guitar Pro 7 and 8 open it. Choosing it over a format of our own means files are not locked to Smart Beat, and everything alphaTab can write (techniques, chords, sections, repeats, tempo changes, lyrics) survives.

The mixer (volume, pan, mute, solo of each track) is written into the file, where Guitar Pro reads it.

Everything Guitar Pro has no place for goes into a `SmartBeat/settings.json` entry in the file's ZIP archive (`src-tauri/src/project.rs`):

- master volume and pan;
- effect chains, sounds and sound switches;
- channel EQ, automation, focus and the drum mixer;
- the audio track and chain presets saved with the song.

It is the same JSON as the app's own mixer settings (`MixerSettings`, version 2; version 1 files still load). When the user asks for it, the audio track's recording is stored too, as `SmartBeat/audio/<file name>`, uncompressed.

Guitar Pro and alphaTab ignore entries they do not know, so the file opens everywhere. On open, these settings take priority over the app's settings for the file. For other formats, the app's settings (keyed by the file's content hash) are used.

## Guitar Pro 5 (`.gp5`)

The writer (`src/lib/export/gp/writer.ts`) produces version 5.00 files. Everything Guitar Pro 5 has is saved: notes, rests, dots, tuplets, ties, bends, slides, harmonics, trills, tremolo picking, grace notes, vibrato, palm mute, let ring, hammer-ons and pull-offs, dynamics, accents, brushes, pick strokes, text, chords, lyrics (one track), repeats, alternate endings, sections, jumps (Coda, Segno, D.C., D.S.), key and time signatures, tempo changes, tunings, capos and each track's sound and mix.

What Guitar Pro 5 cannot hold is reported after saving ("saved with limits"):

- tracks without strings (piano, other instruments): saved as a seven-string track without tablature;
- more than seven strings (the notes on the lowest strings are left out), frets above 24, more than two voices, more than six simultaneous drum notes;
- double-dotted notes (saved with one dot), tuplets other than 3 in the time of 2, 5 to 7 in the time of 4 and 9 to 13 in the time of 8 (a nested tuplet such as 9:4 is saved as plain notes: Guitar Pro 5 stores only the note count), notes shorter than a 64th;
- lyrics of more than one track, dotted and Scottish triplet feels, feedback harmonics.

Text is written in a Windows code page, as Guitar Pro 5 expects: the one the song was read with (see below), else the user's (Windows-1250 for Central European languages, otherwise Windows-1252). If the text does not fit that code page but fits the other one, the other is used; characters that fit neither become "?" and the save warns about them.

Drum notes are written on the string of the drum tab they sit on in Smart Beat, so the placement a Guitar Pro 5 user chose survives a round trip (#53).

### Text encoding when reading (#53)

Guitar Pro 3–5 files store text in the code page of the computer that wrote them and do not say which. Smart Beat reads such a file with Windows-1252 first (which keeps every byte), then picks the encoding from the file's own strings: valid UTF-8 (older Smart Beat versions) stays UTF-8; otherwise Windows-1250 and Windows-1252 are scored by the letters each would produce (ő, ű, č, ł … versus õ, û …), with the user's language breaking ties. File › Reopen with encoding overrides the choice, and the choice is remembered per file. Guitar Pro 7+ files are UTF-8 XML and are not affected.

### Drum strings (#53)

alphaTab's Guitar Pro 3–5 reader drops the string a drum note was written on. Smart Beat wraps that reader at run time (alphaTab's files are not changed) to keep the string, stores it in the note's otherwise unused `fret`, draws the drum tab with it and writes it back to GP5. Guitar Pro 7+ files have no place for it, so `.gp` files carry it in `SmartBeat/settings.json` (`drumLines`).

### How the writer was made (clean-room notes)

The rules in [licensing.md](licensing.md) apply: nothing was copied or ported from TuxGuitar (LGPL-2.1) or PyGuitarPro (LGPL-3.0), and their source code was not read for this feature. The layout of the file was written down from community format descriptions and then checked against alphaTab's GP3–GP5 importer (MPL-2.0, a dependency we are allowed to use), whose field order was used to confirm details such as the bar and track headers. No code was taken from it; the writer is original code in TypeScript.

Verification is by round trip (`writer.test.ts`): songs are saved and read back with alphaTab, and the music (notes, strings and frets, durations, tuplets, tempo, repeats, endings, sections, lyrics, chords, techniques) must be identical. **Still to do by hand:** open files written by Smart Beat in Guitar Pro 5 (Windows or macOS) and TuxGuitar, as the licensing doc requires. Only alphaTab was available for the automated tests.

## Guitar Pro 4 and 3 (`.gp4`, `.gp3`)

The same writer as for GP5 (`src/lib/export/gp/writer.ts`) writes version 4.06 and 3.00 files. Most of the layout is shared; what differs from GP5 is written per version:

- the credits have one field for the words and the music (GP3 and GP4);
- the triplet feel is one setting for the whole song, and there are no page setup, tempo names, jumps (Coda, Segno, D.C., D.S.), realistic-sound-engine data or beaming groups;
- lyrics exist from GP4 on (GP3 has none);
- a repeat stores how many times the bars are repeated (one less than GP5's count of plays), and the alternate endings are stored as a number: "ending N" stands for the endings 1 to N that no earlier bar of the repeat has;
- one voice per bar (GP5 has two);
- a track ends after its colour: both staves are always shown;
- chord diagrams, beat effects, note effects, the mix table change and grace notes have their older forms. GP3 has the fewest effects: no rasgueado, pick strokes, whammy bar, palm mute, staccato, note vibrato, tremolo picking or trills, and its harmonics are one natural or artificial harmonic for the whole beat.

What a version cannot hold is listed after saving ("saved with limits"): everything the GP5 section lists, plus tempo names, jumps, the notes of other voices, grace notes that GP5 plays on the beat (GP4 and GP3 play them before it), per-bar triplet feels, alternate endings that skip a number, artificial harmonics other than 5, 7 and 12 frets (GP4), and for GP3 also lyrics, slides other than "to the next note", and the effects above.

Clean-room notes are as for GP5 (below): the field order comes from community descriptions and was confirmed against alphaTab's GP3–GP5 importer (MPL-2.0); nothing was taken from TuxGuitar or PyGuitarPro. Tests (`writer.test.ts`) read the files back with alphaTab. **Still to do by hand:** open them in Guitar Pro 3 and 4 and in TuxGuitar.

## MuseScore (`.mscz`, `.mscx`)

Export (`src/lib/export/musescore.ts`) is the mirror of the importer. It writes the MuseScore 3 XML format (MuseScore 3 and 4 read it), as `.mscx`, or zipped with its container description as `.mscz`. It was written from the file format only, with no MuseScore code or assets (GPL-3.0, see [licensing.md](licensing.md)).

Saved: parts with their name, instrument sound and mix (volume, pan, mute), up to four voices, notes, chords, rests, dots, tuplets, ties, dynamics, the first verse of lyrics, repeats with their counts, time and key signatures, and tempo (also inside a bar). Guitar parts keep their strings in the instrument; drum parts use MuseScore's standard drum set (the notes are the General MIDI drum numbers).

Left out, and listed after saving: bends, slides, hammer-ons and pull-offs, palm mute, let ring, harmonics, vibrato, staccato, accents, ghost and dead notes, trills, tremolo picking, brushes, tap, slap, pop and whammy bar; grace notes; volta endings; jumps; text, chord diagrams and section names; every voice after the fourth; and notes shorter than a 64th (saved as 64ths). Staves are standard notation, not tablature (the strings stay in the instrument, so a tablature staff can be added in MuseScore). The repeat count and the tempo come back when the file is opened again.

## alphaTex and compressed MusicXML

alphaTex export uses alphaTab's own exporter (`src/lib/export/alphatex.ts`). Compressed MusicXML (`.mxl`, `src/lib/export/mxl.ts`) is the MusicXML below inside a ZIP archive with `META-INF/container.xml`, as MusicXML readers expect; its ZIP writer (`src/lib/export/zip.ts`) stores the entries uncompressed. Pick it by typing the `.mxl` extension in the MusicXML export dialog. Smart Beat opens both again.

## Saved stems (`.sbstems`)

A stem separation (#186) is kept in the app's cache, which can be cleared. **Save stems** on the stem page writes one separated song to a file the user keeps, and **Open saved stems** on the start screen (or a double-click on the file) brings it back without separating again. The type name is "Smart Beat stems". Nothing else opens these files; they are not a standard format.

**In a cloud account.** The same file can also live in the Smart Beat folder of a connected Google Drive, OneDrive or Dropbox account (Save stems and Open saved stems offer the accounts that are connected in Settings). It is identical to a file on this computer; the app uploads and downloads it in chunks through a temporary file. Such a file is told apart from the tabs in the same folder by its `.sbstems` name only, and a song saved or opened this way remembers `drive:<id>` (or `onedrive:`, `dropbox:`) instead of a path.

**Container.** A ZIP archive. Every entry is **STORED** (no compression): the stems are already FLAC (or WAV), so deflating them gains nothing and costs time. Entries:

| Entry                           | Required | What it is                                                                                                      |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                 | Yes      | UTF-8 JSON, described below                                                                                     |
| `stems/<kind>.flac` (or `.wav`) | Yes      | One entry per stem in the manifest; `kind` is `drums`, `bass`, `vocals`, `guitar`, `piano`, `panned` or `other` |
| `original/<file name>`          | No       | The song that was separated, with its own name; only present when the user ticked the box                       |
| `state.json`                    | No       | The mixer state of the stem page (gains, mutes, solo, speed, loop), so a reopened song sounds as left           |

**`manifest.json`.**

```json
{
  "format": "smart-beat-stems",
  "version": 1,
  "id": "…",
  "name": "neon-nights",
  "durationSeconds": 6.0,
  "sampleRate": 44100,
  "channels": 2,
  "mono": false,
  "createdAtMs": 1790000000000,
  "appVersion": "1.2.0",
  "engine": { "id": "htdemucs", "modelId": "…", "modelSha256": "…", "algorithmVersion": 1 },
  "strongDrums": false,
  "skipped": [],
  "pannedShare": 0.3,
  "stems": [
    {
      "kind": "drums",
      "file": "stems/drums.flac",
      "codec": "flac",
      "bytes": 0,
      "sha256": "…",
      "frames": 0
    }
  ],
  "original": { "embedded": true, "fileName": "neon-nights.mp3", "sha256": "…", "bytes": 0 }
}
```

- `id` is the library id of the separation: 16 lowercase hex characters, the start of a SHA-256 over the original song's bytes, the engine, the parts asked for and the drum setting, so the same song separated the same way has the same id. Opening a file whose `id` is already in the library replaces that entry. `engine.id` is the stem engine (`fast`, `neural`, `scnet`, `scnet-xl`, `htdemucs`, `htdemucs-6s`); `modelId` and `modelSha256` say which model file made the stems (empty for the built-in engine) and `algorithmVersion` is the engine's own version counter.
- `skipped` lists the parts that could not be separated (for example `vocals` and `panned` in a mono song); `pannedShare` is the share of the sound that was panned off centre.
- Each stem has its `codec` (`flac`; `wav` is also allowed), its size in `bytes`, the `sha256` of the entry's content and the number of `frames`. A reader checks the hash and the frame count before using a stem.
- `original.embedded` is false when the original was left out; the `fileName`, `sha256` and `bytes` are still recorded so the original can be found again.

**Stem kinds.** The 6-part engine `htdemucs-6s` also writes `guitar` and `piano` entries (`stems/guitar.flac`, `stems/piano.flac`) next to `drums`, `bass`, `vocals` and `other`; every other engine writes the four-part set (the built-in one also `panned`). The format did not change for this: a stem is an entry with a `kind`, so `version` stays 1, an older file of four stems opens as before, and a file with six stems round-trips through save and open. A Smart Beat version from before the 6-part engine refuses such a file, because it does not know the engine id or the two kinds; it does not misread it.

**Versioning.** `version` is a whole number that only goes up when a change would make an older reader misread the file (a renamed or removed field, a different meaning). Adding an optional field or an optional entry does not change it. A reader opens `version` 1 and refuses a higher number with the message that the file was made by a newer Smart Beat.

**Forward compatibility.** A reader ignores manifest fields and ZIP entries it does not know, and treats an unknown `codec` or stem `kind` as a reason to skip that stem (and say so), not to fail the whole file. A missing optional entry (`original/…`, `state.json`) is not an error. A bad or missing `manifest.json`, a hash that does not match, or a `format` other than `smart-beat-stems` is an error and nothing is added to the library.

**Relinking by hash.** The mixer and the Recent grid know the original song by its path. When a reopened file has no embedded original, or the original has moved, the app asks for the song and accepts it only when its `sha256` equals `original.sha256`; a file with another hash is refused, so stems are never played against another recording. A bundle with the original embedded needs no relinking.

**Privacy.** The original song is included **only if the box "Include the original song" is ticked** in the Save stems dialog (it is ticked by default, and disabled when the original is not on this computer any more). Without it the file holds only the separated parts, which are derived from the music and can still be copyrighted: keep and share saved stems under the same conditions as the song (Smart Beat is for personal use, learning and research, see [licensing.md](licensing.md)). Nothing is uploaded; saving and opening happen on this computer.

## Saved stems in the cloud folder

The cloud folder (#187, Help › Settings › Cloud folder) is an ordinary folder on this computer that the user's own drive app keeps in sync: Google Drive for desktop, OneDrive, Dropbox, iCloud Drive or Nextcloud. Smart Beat never talks to those services for it; it only reads and writes files in the folder. A saved separation (#186) can go there too, so the stems reach the user's other computers the same way their tabs do.

**How it works.** The Save stems dialog works like Save As for songs: after the "Include the original song" option (with the estimated size) it shows cards, **Save to this computer** and **Cloud folder · <name>**, and a click on a card saves right away (there is no Save button). For the cloud folder Smart Beat chooses the file name itself (`<folder>/<song name>.sbstems`, with characters that file systems refuse replaced) and writes it there, with the same progress bar and the same file as anywhere else. When it is written, the dialog says "Saved in your cloud folder. Your drive app uploads it; Smart Beat does not upload anything." The upload, its speed, its retries and the account it goes to are the drive app's business. The start screen lists the `.sbstems` files in the linked folder in a section "Stems in your cloud folder" (Stems badge, cloud mark, size) next to the tabs, and a card opens the stem page. A Recent stem card whose file is in the cloud folder shows a small cloud icon ("Saved in your cloud folder"). Open saved stems asks the same way: **Open from this computer** (the file chooser) or **Open from Cloud folder · <name>**, which lists the saved stems in the folder (a file that is still online says "Waiting for download"). With no folder linked both dialogs show a **Set up Cloud storage** card that opens Settings (Link a cloud folder in Settings to keep stems in your cloud).

**Privacy.** The original song is inside the file only when "Include the original song" is ticked, the same rule as for any other `.sbstems` file ([Saved stems](#saved-stems-sbstems)). When it is, the song goes to the user's own cloud drive through the user's own sync client, under that drive's terms. Smart Beat has no server and sends nothing itself: nothing is uploaded by the app, and the analytics counters (see [analytics.md](analytics.md)) never include file names, folder names or sizes. The stems are derived from the music and can still be copyrighted, so the same conditions apply as to the song ([licensing.md](licensing.md)).

**Size.** The stems are FLAC and a `.sbstems` file is not compressed any further, so the size follows the length of the song: about 40 to 100 MB for a 4-minute song with five stems, more when the original (an MP3 adds about 4 MB, a WAV or FLAC 30 to 40 MB) is included. The dialog shows an estimate ("About NN MB") before saving, which is the sum of the entries it will write. A free Google, OneDrive or Dropbox account has a few GB, so a handful of songs can fill it: the file counts against the user's quota and, until the drive app has uploaded it, against the upload bandwidth. Leaving the original out is the quickest way to make the file smaller.

**Offline and online-only files.** The drive app may keep a file as an online-only placeholder (a "Files On-Demand" or "Smart Sync" entry that takes no disk space). The list shows such a file with "Waiting for download", and opening it asks the drive app to download it first, exactly as for tabs; the stem page opens when the file is complete. Without a connection a placeholder cannot be opened, and the open waits or fails with the drive app's own error; a file that is already on the disk opens offline. A file that the drive app is still uploading can be opened on this computer at once.

**Conflicts.** A `.sbstems` file is written once and never edited in place: Smart Beat does not update a saved file, it makes a new one. Saving the same song again does not overwrite the earlier file; the name gets a number (`neon-nights.sbstems`, then `neon-nights (2).sbstems`, and so on), so a sync client never has two devices changing one file and never has to create a "conflicted copy". A file that another device saved appears in the list when the drive app has synced it. Deleting a file from the folder (in the drive app or the file manager) is the way to remove it; Smart Beat does not delete anything in the cloud folder.

### Phase 2, not built: uploading to Google Drive, OneDrive and Dropbox directly

Not built and not planned for a release. This section records what it would take, so the decision can be made with the facts.

The accounts that Smart Beat can already connect (#187: Google Drive, OneDrive, Dropbox, with the app-folder or `drive.file` scopes) are used only for tabs. Saving stems through them, without a desktop sync client, would help users who have no drive app installed or whose folder is not synced. It does not fit the existing code:

- **No streaming.** The `Provider` trait in `src-tauri/src/cloud/mod.rs` reads and writes whole files in memory (`read` returns a `Vec<u8>`, `create` and `write_if_revision` take a `&[u8]`). Each provider refuses files above `MAX_SIZE`, 100 MB, which is below a stems file with the original in it.
- **No progress and no cancel.** The calls are blocking requests with one result. A 150 MB upload on a slow line takes minutes and would need a progress bar, a Cancel button and a way to resume after the app or the connection stops.
- **Scopes.** The tokens are limited to Smart Beat's own app folder, which is the right privacy choice, but the quota and the visibility of the file for the user (where do they find it?) differ per provider and have to be checked.

**Proposed shape.**

1. A streaming layer next to `Provider`: `upload(token, name, reader, len, progress, cancel)` and `download_range(token, id, range)`, with **resumable, chunked uploads** (Google Drive resumable sessions, OneDrive `createUploadSession`, Dropbox upload sessions), chunk sizes the providers accept (multiples of 256 KiB for Google and 320 KiB for OneDrive), retries with backoff, and a session that can be resumed after a restart.
2. **Progress and cancel** through the same event shape as the bundle writer (`stems-bundle-progress`), and a cancel that deletes the unfinished upload session.
3. A **quota check** before the upload (`about.get` for Google Drive, the drive quota for OneDrive, `users/get_space_usage` for Dropbox), with a clear message when the file would not fit.
4. **Lazy per-stem download:** the file is a ZIP with STORED entries and a central directory, so a reader can fetch the directory and then only the byte ranges of the stems it needs (for example only the drums and the bass), instead of the whole file. This needs range requests on all three providers.
5. **Trash on delete:** removing a saved separation moves the remote file to the provider's trash (never a permanent delete), and the list shows what is in the trash only through the provider.

**Spike first.** None of this should be built before a spike with **real accounts** on all three providers and a **150 MB file**: it has to show that resumable uploads survive a dropped connection and an app restart, that the app-folder scopes allow range downloads of a file this size, what the real upload time and rate limits are on a free account, and how the quota errors look. The result decides whether it is worth a streaming layer at all, or whether the cloud folder (no new code, no new tokens, no new privacy surface) stays the only route.

**Built (2026-11-04): saved stems in the connected accounts.** The Save stems and Open saved stems dialogs also offer the Google Drive, OneDrive and Dropbox accounts that are connected in Settings, through the commands `stems_cloud_save`, `stems_cloud_open` and `cloud_list_stems` (`src-tauri/src/stems/cloud.rs`). The bundle is made and read by the same code as a file on this computer; it only passes through a temporary folder (`smart-beat-stems-*` in the system temp folder, removed on success, failure and cancel). A save writes the `.sbstems` file there and `Provider::upload_file` sends it from disk in chunks; an open reads the file's metadata (the name must end in `.sbstems`), `Provider::download_file` streams it to disk and `bundle::open` opens it. Nothing is held whole in memory, so the 100 MB limit of the tab path (`create`, `read`) does not apply to stems. Progress is the existing `stems-bundle-progress` event with the stages `writing` and `uploading` (save) or `downloading` and `reading` (open); `stems_cancel` stops any of them with the same message as a stopped file save. A save never replaces a file: the name is made unique in the provider's Smart Beat folder (`name (2).sbstems`). The files sit in the same app folder as the tabs, so `cloud_list` now leaves `.sbstems` files out and `cloud_list_stems` lists only them, newest first. A song saved or opened this way remembers the item id (`drive:<id>`) as its saved place, not a path. Limits: the access token is read once per transfer, so a transfer that outlives the token (about an hour) fails with a sign-in error and has to be started again; the original audio of a song opened from the cloud is not kept on this computer, so saving that song again with the original works only while the source file is still there. The spike above is still the way to learn how the real providers behave with a 150 MB file (dropped connections, quotas, rate limits).

## Sharing a file with a link

A tab or a saved stems file in a connected Google Drive, OneDrive or Dropbox account can be shared with a link (#201). The share icon is next to the file on the start screen, in the Open from drive list and in **File › Cloud Library**.

**What the link is.** An "anyone with the link" link made by the service itself, through `cloud_share` (`src-tauri/src/cloud_commands.rs`) and `Provider::share_link`:

| Service      | Call                                                                                       | Levels     | Scope                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| Google Drive | `permissions.create` (`anyone`, role `reader` or `writer`), then `files.get` `webViewLink` | view, edit | `drive.file` (files the app made)                                                                |
| OneDrive     | `createLink` (`view` or `edit`, scope `anonymous`) on the item                             | view, edit | `Files.ReadWrite.AppFolder`; a work or school tenant can block anonymous links                   |
| Dropbox      | `sharing/list_shared_links`, else `create_shared_link_with_settings` (public, viewer)      | view only  | `sharing.read` and `sharing.write`: an account connected before this needs to be connected again |

The person chooses view or edit in the dialog; a level the service cannot make is greyed out. The link opens the service's own page for the file (to look at it or download it): **Smart Beat does not open share links**, and there is no `smartbeat://` link.

**A file on this computer** is copied first. A tab is uploaded as it is on disk (`cloud_create`, the usual 100 MB tab limit and the writable extensions apply); a separated song is saved as a `.sbstems` file without the original song (`stems_cloud_save`, with progress and Cancel). The copy goes into the service's Smart Beat folder under a name that is not taken yet (`name (2).sbstems` for stems) and is a plain copy: it is not linked to the local file, and changing the local file later does not change what the link shows. Sharing the same local file again makes a new copy. Trying again after a failed link does not upload a second copy.

**Stems** are always a file of their own with their own link; a tab and its stems are not bundled, because a `.gp` file does not refer to stems.

**The Cloud library** lists, for each connected service, the tabs (`cloud_list`) and the stems files (`cloud_list_stems`) in its Smart Beat folder, newest first, with Open and Share. The services are connected with access to Smart Beat's own files only, so files the person put in the drive themselves are not listed.

**Privacy.** A share link is a secret like a token: it is returned to the dialog, copied to the clipboard and shown there, and nowhere else. It is not stored (not in the recent list, not in settings), not written to a log or an error message (the command checks that it is an `https://` address and otherwise reports a generic error without it), and not counted by the usage statistics. Anyone who has a link can open the file.

## Audio export (WAV, M4A)

WAV is 16-bit PCM of the song rendered with the current mix. **M4A** is AAC in an MP4 file (192 kbit/s stereo, 128 kbit/s mono), made by the **operating system's own encoder**: on macOS the AVFoundation `AVAudioFile`, on Windows Media Foundation (an `IMFSinkWriter` with an MPEG-4 sink, through the MIT/Apache `windows` crate; it takes 44.1 and 48 kHz sound, which is what the export renders), both in `src-tauri/src/m4a.rs`; the UI renders the same WAV and hands it over. The menu item exists on macOS and Windows only. **Linux has no system AAC encoder** and an LGPL/GPL one (FFmpeg, FAAC, fdk-aac) cannot be bundled, so the item is left out there and the command answers with a clear error; export a WAV file instead.

**No MP3.** Every usable MP3 encoder is LGPL (LAME, shine, lamejs), and Smart Beat's binaries may be licensed commercially and link statically, so none can be bundled ([licensing.md](licensing.md)). The system encoders are the way to get a compressed file without a licence problem (the operating system vendor holds the codec licence); the other option, asking the user to install an encoder, was not taken.

## Guitar Pro 6 (`.gpx`, open only)

Guitar Pro 6 files are opened (alphaTab reads them) but not written. A `.gpx` file is a small file system around Guitar Pro's XML score (`score.gpif`). The only writer in alphaTab makes the Guitar Pro 8 flavour of that XML (`GPVersion` 8.1.3) and keeps it in a ZIP for `.gp` files; Guitar Pro 6 needs its own flavour, and nothing here can open a file in Guitar Pro 6 to check one. A `.gpx` menu item that probably produces files Guitar Pro 6 cannot read would be misleading, so it was left out. It can come back when someone with Guitar Pro 6 can test a GP6-flavoured writer (the container, `BCFZ`, is simple: a 4096-byte sector file system, stored without compression, as alphaTab's reader shows).

## MusicXML

Export (`src/lib/export/musicxml.ts`) writes score-partwise 3.1 with one part per track: pitches (as they sound; guitars get a treble clef an octave down), rhythms, dots, tuplets, ties, rests, tab positions (`<string>` counted from the highest string, `<fret>`), tunings and capo, key and time signatures, tempo, repeats and endings, rehearsal marks, drum notes and lyrics. Bends, slides, palm mute and similar techniques have no standard element and are not exported (Guitar Pro files keep them).

Import goes through alphaTab's MusicXML reader (also handles compressed `.mxl` content). alphaTab reads an "x" note head as a normal note, so dead notes come back as normal notes.

## MIDI

Export (`src/lib/export/midi.ts`) uses alphaTab's generator: a type 1 file with one track per track of the song, tempo and time signature changes, with repeats and jumps played out as in playback.

Import (`src/lib/import/midi.ts`) is Smart Beat's own. A MIDI file has sounds, not notation, so it makes choices:

- every MIDI channel with notes becomes a track (channel 10 is drums); the track name, sound (program change), volume and pan are taken over;
- time signature changes become bars; tempo changes start at the beginning of the bar they fall in;
- many files made from a recording or an audio conversion say one tempo (often 120 BPM) while the music runs at another. When a file has one tempo and one time signature and its notes do not fit its own sixteenth grid, the real sixteenth is measured from the note onsets (within 15% of the file's tempo), small drift is followed, and the bar lines are placed where the music has its downbeats (kick on 1, snare on 2 and 4, chords on the beats). The measured tempo goes into the song and the import says so (`src/lib/import/midi-grid.ts`);
- notes are snapped to sixteenth notes (a note played just before a bar line goes on the next bar's first beat); a note that lasts past the next note is cut (no ties are made) and triplets are not detected;
- guitar (programs 25-32) and bass (33-40) sounds are written as tablature in standard tuning, with notes moved by an octave when they do not fit; other sounds as a staff.
- SMPTE time division is not supported.

## ASCII tab

Export writes each stringed track as lines of text: a line per string named from the tuning (lowercase for the top string), frets, `x` for dead notes and `(5)` for ghost notes, wrapped at 80 characters. Tracks without strings are listed as left out.

Import guesses the rhythm from the spacing of each bar's own notes (snapped to 2, 3, 4, 6, 8, 12, 16, 24 or 32 steps, and doubled when two notes of a string would share a step) and takes over the usual technique marks: `h` and `p` (hammer-on, pull-off), `/`, `\` and `s` (slides), `b` (bend), `~` and `v` (vibrato), `(5)` (ghost note) and `<12>` (natural harmonic). Releases, taps and other marks are listed as left out.

## Opening MuseScore files

The importer (`src/lib/import/musescore.ts`) reads parts, staves, up to four voices, notes, chords, rests, dots, tuplets, ties, dynamics, the first verse of lyrics, repeats, time and key signatures and tempo. Not yet: grace notes, voltas, slurs, text, layout. Saving back to MuseScore is described above.

## Import only

| Format  | Extension | What is read                                                                                                                                                                                                                                                                                              |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capella | `.capx`   | Read by alphaTab. alphaTab 1.8.4 failed on every file with a note (it measures a chord before adding it to its voice); `src/lib/score/alphatab-fixes.ts` works around it. Repeat counts are only read from Capella's draw objects. There is no writer: no specification, and nothing to check one against |

## Not supported yet (needs a format specification)

These are binary formats with no public specification. Smart Beat's code is source-available but not open source, so their readers must be written clean-room ([ADR 0001](adr/0001-project-license.md), [ADR 0002](adr/0002-source-available-noncommercial-license.md)); the open-source programs that read them are GPL or LGPL and cannot be ported.

| Format    | Extension | What is needed                                                                                                                                                                     |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power Tab | `.ptb`    | A written description of the format. The only reader is Power Tab Editor 2 (GPL-3), which cannot be used as a source                                                               |
| TuxGuitar | `.tg`     | A written description of the format. TuxGuitar (LGPL-2.1) is its only documentation; reading its code to port it is not allowed                                                    |
| TablEdit  | `.tef`    | The TablEdit format specification, which its author (Matthieu Leschemelle) shares on request (MuseScore's importer was written that way). Ask for it with commercial use permitted |
