#!/bin/bash
# Runs inside the container (see README.md). Opens each model in DeZign for Databases and, when it opened, has
# DeZign save it again under the same name into <back dir>: what DeZign wrote is then compared with what we wrote
# (packages/core/test/dezign-kit.test.ts with DBM_DEZ_KIT_BACK).
#
#   roundtrip.sh <out dir> <back dir> <model.dez | folder with a .dezproj>...
#
# <out dir>/result.txt gets one line per model: OPEN+SAVED, or what went wrong, with the sizes of the dialogs
# DeZign showed. Pictures: the object browser (counts of objects) and any dialog, never the whole diagram, so
# the script can be used on a model that must not be shown around.
# Screen positions are for the 1920x1200 display start.sh opens and for DeZign 14.9.
export DISPLAY=:99 HODLL=libwow64fex.dll
out="$1"; back="$2"; shift 2
mkdir -p "$out" "$back"
here=$(dirname "$0")
title() { xdotool search --name "DeZign for Databases 14" 2>/dev/null | head -1 | xargs -r xdotool getwindowname 2>/dev/null; }
# Windows of DeZign on top of its main one. Message boxes have no name; the Open and Save dialogs have one.
# (The progress box stays mapped under Wine.)
tops() { xwininfo -root -tree 2>/dev/null | grep -E '^\s+0x' | grep 'dezign.exe' | grep -v 'FormProgress\|DeZign for Databases 14\|x2+\|1x1+\|Default IME'; }
dialogs() { tops | grep 'has no name' | grep -oE '[0-9]+x[0-9]+\+[0-9]+\+[0-9]+' | awk -Fx '$1 >= 400'; }   # (smaller ones are hints)
named() { tops | grep -v 'has no name'; }
# (By the process's own name: a command line that merely mentions dezign.exe is not DeZign.)
alive() { ps -C dezign.exe -o stat= | grep -vq '^Z'; }
idle() { local n=0; while [ $n -lt "${1:-90}" ]; do sleep 2; cpu=$(top -b -n1 | grep dezign.exe | awk '{print $9}' | head -1); [ -z "$cpu" ] && return 1; [ "${cpu%.*}" -lt 8 ] && { sleep 1; return 0; }; n=$((n+1)); done; }
windows_path() { echo "Z:$(echo "$1" | sed 's#/#\\#g')"; }
crop() { import -window root "$out/.screen.png" 2>/dev/null; convert "$out/.screen.png" -crop "$1" +repage "$2" 2>/dev/null; rm -f "$out/.screen.png"; }

for model in "$@"; do
 # (A second try when DeZign showed nothing at all: it was still starting after a restart.)
 for attempt in 1 2; do
  if [ -d "$model" ]; then label=$(basename "$model"); file=$(ls "$model"/*.dezproj | head -1); else label=$(basename "$model" .dez); file="$model"; fi
  # (Freshly started, DeZign is still settling its last project for a while after it looks quiet.)
  alive || { bash "$here/start.sh" >/dev/null 2>&1; sleep 30; }
  xdotool mousemove 960 30 click 1; sleep 0.5
  xdotool key ctrl+F11                                           # File > Open project
  for _ in $(seq 30); do sleep 2; named | grep -q 'Open Project' && break; done
  sleep 2; xdotool type --delay 20 "$(windows_path "$file")"; sleep 0.6; xdotool key Return; sleep 4
  for _ in $(seq 10); do [ -z "$(named)" ] && break; sleep 2; done   # the Open dialog is gone
  seen=""; converted=0; answered=0
  for _ in $(seq 75); do                                         # DeZign can take a minute to close the project before
    d=$(dialogs | head -1)
    size=${d%%+*}; x=$(echo "$d" | cut -d+ -f2); y=$(echo "$d" | cut -d+ -f3)
    if [ -z "$d" ]; then
      # The title names the project before DeZign asks about converting it: only a quiet DeZign has opened it.
      if title | grep -qF "$(basename "$file")"; then idle 300; sleep 8; [ -z "$(dialogs)" ] && break; continue; fi
    elif [ "${size#*x}" -ge 150 ]; then
      seen="${seen}convert;"; converted=1; xdotool key Return    # "…needs to be converted. Continue?": Yes
    elif ! title | grep -qF "$(basename "$file")"; then
      seen="$seen$d;"; crop "$d" "$out/$label-prompt.png"
      xdotool mousemove $((x + 258)) $((y + 96)) click 1         # "Save changes to <the project before>?": No
    elif [ "$converted" = 1 ]; then
      converted=2; crop "$d" "$out/$label-converted.png"; xdotool key Return   # "File converted succesfully.": OK
    elif [ -n "$ANSWER_NO" ] && [ "$answered" = 0 ]; then
      # ANSWER_NO=1: one yes/no question about the project is answered No. A project whose columns come from
      # attribute packages this DeZign does not have asks whether to delete those columns.
      answered=1; seen="${seen}no;"; crop "$d" "$out/$label-question.png"; xdotool mousemove $((x + 300)) $((y + 96)) click 1
    else break; fi                                               # a message about this very project
    sleep 4
  done
  idle 300
  left=$(dialogs | tr '\n' ';')
  case "$(title)" in *"$(basename "$file")"*) ok=OPEN ;; *) ok=NOT-OPEN ;; esac
  alive || ok="$ok+QUIT"
  crop 300x130+0+160 "$out/$label-tree.png"
  if [ -n "$left" ]; then
    crop "$(dialogs | head -1)" "$out/$label-dialog.png"
    # Closed, never answered: Enter on "Save changes?" would write into the model that is being checked.
    xdotool key Escape; sleep 4
    alive || ok="$ok+QUIT"
  elif [ "$ok" = OPEN ]; then
    xdotool mousemove 960 30 click 1; sleep 0.5
    xdotool key ctrl+alt+s                                       # File > Save project as
    for _ in $(seq 30); do sleep 2; named | grep -q 'Save project' && break; done; sleep 2
    xdotool key ctrl+a; xdotool type --delay 20 "$label"; sleep 0.3
    xdotool key Tab; sleep 0.3; xdotool key ctrl+a; xdotool type --delay 20 "$(windows_path "$back")"; sleep 0.3
    if [ -d "$model" ]; then xdotool mousemove 740 519 click 1; else xdotool mousemove 872 519 click 1; fi   # folder based / single file
    sleep 0.5; xdotool mousemove 1121 846 click 1; sleep 6
    for _ in $(seq 60); do [ -z "$(named)" ] && break; sleep 2; done; idle 300
    after=$(dialogs | tr '\n' ';')
    if [ -n "$after" ]; then crop "$(dialogs | head -1)" "$out/$label-savedialog.png"; xdotool key Escape; sleep 2; xdotool key Escape; sleep 1; left="$after"; fi
    if [ -s "$back/$label.dez" ] || ls "$back/$label"/*.dezproj >/dev/null 2>&1; then ok="$ok+SAVED"; else ok="$ok+NOT-SAVED"; fi
  fi
  # (What the screen showed when nothing at all happened: for whoever looks into it.)
  [ "$ok" = NOT-OPEN ] && [ -z "$seen$left" ] && import -window root "$out/$label-nothing-$attempt.png" 2>/dev/null
  if [ "$ok" = NOT-OPEN ] && [ -z "$seen$left" ] && [ "$attempt" = 1 ]; then pkill -x dezign.exe; sleep 10; continue; fi
  echo "$ok | $label | asked: ${seen:-nothing} | left open: ${left:-nothing}" | tee -a "$out/result.txt"
  # Whatever went wrong must not reach the next model: DeZign starts again.
  case "$ok" in OPEN+SAVED) ;; *) pkill -x dezign.exe; sleep 10 ;; esac
  break
 done
done
echo DONE >> "$out/result.txt"
