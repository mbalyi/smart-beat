# Smart Beat – magas szintű terv

Cél: a Guitar Pro 5 modern, Mac/Windows/Linux kompatibilis újraírása, saját gépen futó (self-hosted) MI-vel, ami egy dúdolt dallamhoz harmonikusan illeszkedő kíséretet (dob, gitár, basszus, zongora) generál kottában/tabban.

> Megjegyzés: a GP5 nem volt ingyenes (Arobas Music, kb. 50–60 €), és volt Mac-verziója is (2006. július), de az 32 bites Carbon alkalmazás, ezért macOS 10.15 óta nem fut. Az Arobas hivatalos GP5 release notes-ai már nem érhetők el nyilvánosan, ezért a verziótörténet hiányos.

---

## 1. GP5 verziótörténet

| Verzió | Mikor | Mit tudunk róla |
|---|---|---|
| **5.0** | 2005. nov. (Windows) | Új felület, több elem kijelölése egyszerre, két szólam egy sávon belül, új effektek (wah-wah, hangsúlyos hangok, jobb mesterséges flageolett, hajlítás és tremoló). Új a „Realistic Sound Engine” (RSE): valódi hangszerekről vett mintákból szól a lejátszás. |
| **5.0 Mac** | 2006. júl. | Mac OS X, PowerPC és Intel |
| **5.1** | kb. 2006–2007 | Hibajavítások, RSE-fejlesztések. Részletes lista nincs meg. |
| **5.2** | 2007–2008 (a források ellentmondanak) | Az utolsó Windows-verzió. Stabilabb (ismert hiba volt, hogy hosszú használat után hibaüzenetek jöttek), Windows Vista támogatás. Az RSE 14 hangbankkal jött (2 nylon, 2 akusztikus, 2 elektromos, 1 jazz gitár, 4 basszus, 3 dobszett), 44,1 kHz / 16 bit. |
| **5.3.2b5 (Mac)** | – | A Macintosh Garden archívumban szerepel ilyen Mac-build. Nem ellenőrzött. |

## 2. GP5 funkciói (az ismert funkciókészlet összefoglalója, ellenőrizendő)

- **Sávok és hangszerek:** több sáv; gitár legfeljebb 7 húrral, basszus, bendzsó, dob, bármely MIDI-hangszer. Hangolási sablonok, capo, sáv másolása.
- **Kottaírás:** tabulatúra, hagyományos kotta és ritmusjelölés együtt, sávonként két szólam. Hangnem, ütemmutató, triola-érzet, n-olák, átkötés, előke, dinamika, ujjrend.
- **Gitártechnikák:** hajlítás szerkeszthető görbével, slide (legato, shift, be, ki), hammer-on és pull-off, vibrato, trilla, tremolo picking, palm mute, let ring, tompított (dead) és ghost hangok, staccato, akcentusok. Flageolettek: természetes, mesterséges, tapped, pinch, semi. Tapping, slap, pop, whammy bar (dive, dip), rasgueado, pengetésirány, arpeggio/brush, fade-in, wah nyitva/zárva.
- **Szerkezet:** ismétlőjelek, alternatív befejezések, Coda, Segno, D.C./D.S. al Fine, szakaszjelölők, szöveg, legfeljebb 5 dalszöveg-sor, ami lejátszás közben együtt halad a zenével.
- **Akkordok és skálák:** akkorddiagramok, akkordfelismerés, akkordvarázsló, skálaeszköz.
- **Lejátszás:** RSE-keverő erősítő- és effektláncokkal, automatizálható hangerő, panoráma, tempó és effektek. MIDI-lejátszás, metronóm, beszámolás, ismétlés (loop), Speed Trainer (fokozatosan gyorsuló gyakorlás).
- **Eszközök:** virtuális fogólap és billentyűzet, mikrofonos hangoló, ütemhossz-ellenőrzés, transzponálás, automatikus átírás tab és kotta között, lépésenkénti bevitel MIDI-billentyűről.
- **Import/export:** GP3, GP4, GP5, MIDI, ASCII tab, MusicXML, PowerTab. Kimenet: WAV, nyomtatás, stíluslapok, háromféle nézet (oldal, képernyő, „parchment”).
- **Fájlformátum:** a `.gp5` bináris formátumot a nyílt forráskódú közösség teljesen visszafejtette (PyGuitarPro, alphaTab és TuxGuitar olvassa).

## 3. Ingyenes alternatívák Macre

| Program | Mire jó |
|---|---|
| **TuxGuitar** (2.1.0, 2026. júl.) | A legközelebb áll a GP5-höz. Nyílt forráskódú, **GP3/4/5-öt olvas és ír**. A Mac-csomag nincs aláírva, ezért telepítéskor a Gatekeeper figyelmeztet. |
| **MuseScore 4** | Kottaszerkesztő, GP-fájlokat importál, tab is van benne. Ingyenes. |
| **alphaTab** | Böngészőben futó GP-megjelenítő és -lejátszó. Nem szerkesztő, de ebből lehet kiindulni (lásd 6. pont). |
| **GP5 Wine / CrossOver alatt** | Az eredeti GP5 elég jól fut így Apple Silicon Macen is. |

Fizetős megoldás a Guitar Pro 8 (kb. 70 €).

## 4. MI-alapú kísérettervezés dúdolt dallamhoz – piaci helyzet

Olyan kész program, ami pontosan ezt tudja (dúdolás → kotta → hozzá illő dob-, gitár- és zongoraszólam kottában), **ingyen nincs**. A legközelebbiek:

- **Logic Pro 11 (Mac, fizetős):** a Session Players követi az akkordsávot, és illő basszust, billentyűs szólamot és dobot generál, ami MIDI-ként szerkeszthető.
- **Band-in-a-Box (Mac/Windows, fizetős):** dallamhoz akkordokat és teljes zenekari kíséretet készít, kottát és tabot is.
- **Hookpad Aria (Hooktheory):** MI-s akkord- és dallamjavaslatok.
- **Dúdolás → kotta:** Songscription, Klangio (csak az átírás MI-alapú, a kíséretet magadnak kell megírni).
- **Suno és hasonlók:** hangot generálnak, nem szerkeszthető kottát, ezért erre a célra nem jók.

Ez az a rés, amit a Smart Beat betölthet.

## 5. Újraírás: architektúra és technológiák

| Réteg | Választás | Miért |
|---|---|---|
| Asztali keret | **Tauri 2** (Rust) | Kicsi, natív, mindhárom rendszeren fut. Az Electron nehezebb alternatíva. |
| Felület | TypeScript + React vagy Svelte | Modern felület, gyors fejlesztés |
| Kottakép és lejátszás | **alphaTab** (MPL-2.0) | Megjeleníti a GP3–7 fájlokat és a hagyományos kottát, van beépített szintetizátora (SoundFont-alapú), és lejátszás közben mutatja az aktuális hangot. A projekt kb. 40%-át adja. |
| Fájlbeolvasás és -írás | alphaTab importálók; **GP5 írásához** a PyGuitarPro vagy a TuxGuitar logikája portolva, plusz MusicXML | – |
| Hangzás (az RSE helyett) | FluidSynth vagy alphaSynth SF2/SF3 hangbankkal, később mintaalapú motor | – |
| MI-szolgáltatás | Python (FastAPI) mellékfolyamat vagy Docker-szerver; az alkalmazásban ONNX Runtime | Önállóan telepíthető, akár GPU-s szerveren is |

### MI-lánc: „dúdolok, és kapok kíséretet”

1. **Dúdolás → hangjegyek:** Spotify Basic Pitch (Apache-2.0) vagy torchcrepe/pYIN egyszólamú hangmagasság-felismeréshez. Utána ritmusigazítás (kvantálás) és a hangnem felismerése a music21 könyvtárral.
2. **Akkordok a dallamhoz:** szabályalapú vagy rejtett Markov-modell (HMM) alapú harmonizálás, vagy AccoMontage2/3.
3. **Kíséret generálása:** **Anticipatory Music Transformer** (Stanford, nyílt). Kifejezetten arra készült, hogy egy meglévő dallamhoz úgy egészítsen ki további szólamokat, hogy a dallam nem változik.
4. **Játszható gitártab:** a generált hangokhoz optimalizáló algoritmus (dinamikus programozás) választja ki, melyik húron és bundon szóljon a hang, hogy a fogás ténylegesen lejátszható legyen. Kritikus rész, ma egyik kész MI sem csinálja jól.
5. **Beszélgetős asszisztens** (pl. „tegyél alá walking basszust”): helyi LLM Ollama vagy llama.cpp alatt (Qwen, Llama). Eszközhívásokkal a fenti modelleket hívja meg, nem maga ír hangjegyeket.

### Zenére tanított, ingyenes modellek

- **ChatMusician:** LLaMA2 alapú, ABC kottaírásban „gondolkodik”.
- **NotaGen:** ABC formátum, főleg klasszikus zenére.
- **MuPT** és **MIDI-LLM:** szövegből MIDI-t generálnak.
- **Anticipatory Music Transformer:** a kíséretgeneráláshoz a legjobb választás.
- **Magenta** (Coconet: Bach-stílusú harmonizálás; Music Transformer).
- **CLaMP 3:** zenei keresésre.
- Hang alapú modellek, nem kotta: YuE, MusicGen.

A nagy általános LLM-ek gyengék a hangjegyek közvetlen generálásában. Erre a célra a kisebb, zenére szakosodott modellek plusz a zeneelméleti szabályok kombinációja működik.

### Időbecslés

| Mérföldkő | 1 fejlesztő (MI-s kódolássegédekkel) | 3–4 fős csapat |
|---|---|---|
| MVP: GP-fájl megnyitása, megjelenítése és lejátszása, alap szerkesztés, MusicXML-export | 2–3 hó | 1–1,5 hó |
| Dúdolás → kotta + MI-kíséret (dob, basszus, zongora) + tab-optimalizálás | +3–4 hó | +2 hó |
| Közel teljes GP5-funkciókészlet (minden effekt, nyomtatás, keverő, GP5-írás) | összesen 12–18 hó | összesen 8–12 hó |
| RSE-szintű hangzás (saját mintakönyvtár) | külön projekt, a hangminták miatt drága | – |

## 6. Nyílt forráskódú kiindulópontok

- **alphaTab** (CoderLine/alphaTab): megjelenítés és lejátszás, a legjobb alap.
- **TuxGuitar** (helge17/tuxguitar): teljes szerkesztő Javában, LGPL. Hivatkozás a szerkesztési logikához és a GP5 írásához.
- **PyGuitarPro:** GP3/4/5 olvasása és írása Pythonban, ideális az MI-szolgáltatáshoz.
- **MuseScore 4:** C++/Qt, GPL. A kottaszedés és a hangzás mintája.
- **music21**, **Basic Pitch**, **Anticipatory Music Transformer**, **AccoMontage**.

Licencek: a GPL-es kód (MuseScore) átvétele esetén a saját termékünknek is GPL-nek kell lennie. Az alphaTab MPL-2.0 licence ennél megengedőbb.

## Források

- [Guitar Pro – Wikipedia](https://en.wikipedia.org/wiki/Guitar_Pro)
- [Macintosh Garden – Guitar Pro 5](https://macintoshgarden.org/apps/guitar-pro-5)
- [Audiofanzine – Guitar Pro 5](https://en.audiofanzine.com/tablature-editor/arobas-music/Guitar-Pro-5/)
- [GP 5.2 + RSE hangbankok](http://marcelo93.blogspot.com/2008/06/guitar-pro-52-rse_26.html)
- [Guitar Pro 5.0 – Internet Archive](https://archive.org/details/gp5_20210423)
- [TuxGuitar – Wikipedia](https://en.wikipedia.org/wiki/TuxGuitar)
- [TuxGuitar kiadások](https://github.com/helge17/tuxguitar/releases)
- [ChatMusician (arXiv)](https://arxiv.org/abs/2402.16153)
- [AccoMontage2 (arXiv)](https://arxiv.org/pdf/2209.00353)
- [MIDI-alapú énekes kísérettervezés (arXiv)](https://arxiv.org/html/2602.22029v1)
- [Valós idejű kísérettervezés (Springer)](https://link.springer.com/chapter/10.1007/978-3-032-05748-8_44)
- [Songscription – dúdolásból kotta](https://www.songscription.ai/blog/hum-to-sheet-music)
- [YuE2](https://yue2ai.app/)
- [Zenegenerálási demók listája](https://github.com/affige/genmusic_demo_list)
