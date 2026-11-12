#!/bin/bash
# Runs inside the container: starts the display and DeZign, and passes the trial's opening dialog when there is one.
export DISPLAY=:99 HODLL=libwow64fex.dll
pgrep -x Xvfb >/dev/null || { Xvfb :99 -screen 0 1920x1200x24 >/dev/null 2>&1 & sleep 2; }
ps -C dezign.exe -o stat= | grep -vq '^Z' && { echo "already running"; exit 0; }
exe=$(find "$WINEPREFIX/drive_c" -iname dezign.exe | head -1)
[ -z "$exe" ] && { echo "DeZign is not installed in this container (see README.md)"; exit 1; }
(cd "$(dirname "$exe")" && exec nohup wine dezign.exe >/tmp/dezign.log 2>&1 </dev/null) &
main() { xdotool search --name "DeZign for Databases 14" 2>/dev/null | head -1; }
# The trial's opening dialog is a 700x587 window without a name; a licensed copy shows none.
trial() { xwininfo -root -tree 2>/dev/null | grep 'dezign.exe' | grep 'has no name' | grep -c ' 700x587+'; }
for _ in $(seq 60); do sleep 3; [ -n "$(main)" ] && break; done
for _ in $(seq 30); do [ "$(trial)" != 0 ] && break; sleep 3; done   # it comes a while after the main window
for _ in $(seq 20); do
  [ "$(trial)" = 0 ] && break
  sleep 3; xdotool mousemove 798 740 click 1; sleep 6           # "Continue evaluation"
done
# DeZign then opens the project it had open last (the first time: one of its samples). Quiet twice in a row.
quiet=0
for _ in $(seq 90); do
  sleep 3; cpu=$(top -b -n1 | grep dezign.exe | awk '{print $9}' | head -1)
  if [ "${cpu%.*}" -lt 8 ]; then quiet=$((quiet + 1)); else quiet=0; fi
  [ $quiet -ge 3 ] && break
done
echo "started: $(main | xargs -r xdotool getwindowname 2>/dev/null)"
