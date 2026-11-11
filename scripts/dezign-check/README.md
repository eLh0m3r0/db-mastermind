# Checking saved files in DeZign for Databases itself

The one thing no test of ours can say is whether DeZign opens what we write and keeps it. These scripts ask
DeZign: it runs under Wine in a Docker container, opens each file, and saves it again; what DeZign wrote is then
read back and compared with what we wrote.

Needs an ARM64 host (Apple Silicon: the image uses Hangover, Wine for ARM64 with the FEX emulator; Wine for amd64
under Rosetta cannot run 32-bit programs) and an installer of DeZign for Databases 14 that you are allowed to use:
the trial from datanamic.com, or your licensed copy. The installer is never part of this repository.

```bash
docker build -t dbm-dezign-check scripts/dezign-check
docker run -d --name dbm-dezign -e WINEDLLOVERRIDES="mscoree,mshtml=" dbm-dezign-check
docker cp scripts/dezign-check/. dbm-dezign:/work/check
docker cp ~/Downloads/setup_dezign.exe dbm-dezign:/work/
docker exec dbm-dezign bash -lc 'Xvfb :99 -screen 0 1920x1200x24 & sleep 2; HODLL=libwow64fex.dll wine /work/setup_dezign.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-'

# The kit: one file per kind of edit, made from a model DeZign wrote (and three projects made from scratch).
DBM_DEZ_KIT_FROM=<model.dez | project.dezproj> DBM_DEZ_KIT_TO=<kit> npx vitest run --root packages/core test/dezign-kit.test.ts
docker cp <kit> dbm-dezign:/work/kit
docker exec dbm-dezign bash -lc 'bash /work/check/roundtrip.sh /work/out /work/back /work/kit/*.dez'
docker cp dbm-dezign:/work/back <back>
docker exec dbm-dezign cat /work/out/result.txt

# What DeZign saved, against what we wrote: the same model, or the kinds of differences and their counts.
DBM_DEZ_REPORT=report.txt DBM_DEZ_KIT_TO=<kit> DBM_DEZ_KIT_BACK=<back> npx vitest run --root packages/core test/dezign-kit.test.ts
```

Good to know:

- A model as its base must be one this DeZign opens unchanged (file `01-beze-zmeny`). The trial refused one public
  model with "Your trial has ended" although it had 14 days left; the models shipped with DeZign
  (`sample models`), saved once with "Save project as", are a safe base.
- A project of DeZign 11.1 or older is converted when it is opened (DeZign asks; the script says yes).
- For a private model: run the container with `--network none`, pass project folders instead of files
  (`roundtrip.sh` then keeps only the object counts of the object browser and the dialogs), compare without
  `DBM_DEZ_DEBUG`, and remove the container afterwards.
- Emulation is slow: a model takes one to two minutes.
