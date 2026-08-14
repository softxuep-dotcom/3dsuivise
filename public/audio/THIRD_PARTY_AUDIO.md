# Third-party audio

All shipped third-party audio is permitted for commercial use. The files in
`audio/sfx/` were converted to MP3 and, where noted, trimmed for this game.

## What ships, and why it is only four files

The game once shipped 15 sets of real samples — footsteps, weapon swings, material
impacts, cloth, growls. In combat five or six of them fired at once and the whole
thing sounded like a blacksmith's shop, so everything high-frequency went back to
synthesis (see `src/audio/SynthAudio.ts`). Only two kinds of sound survived:

- **Ambience** — one at a time, never collides: `fire-loop`, `wolf-howl`.
- **UI feedback** — only on a deliberate player action, naturally sparse:
  `confirm`, `warning`.

## Kenney — Creative Commons CC0

- [Interface Sounds](https://kenney.nl/assets/interface-sounds): `confirm.mp3`,
  `warning.mp3`.

License: [Creative Commons CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Attribution is not required; Kenney is credited here as a courtesy.

## Freesound — Creative Commons CC0

- `fire-loop.mp3`: "Ambiance_Campfire_Loop_Stereo.wav" by Nox_Sound,
  [sound 558967](https://freesound.org/people/Nox_Sound/sounds/558967/).
- `wolf-howl.mp3`: "Scary Ghost Wolf Howling.wav" by BrainClaim,
  [sound 267179](https://freesound.org/people/BrainClaim/sounds/267179/).

License: [Creative Commons CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Attribution is not required; the creators are credited here as a courtesy.
