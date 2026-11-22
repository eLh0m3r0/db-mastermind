#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# --- DB Mastermind addition (everything above is electron-builder 26.15.3's own after-install.tpl, unchanged) ---
# Chromium needs user namespaces for ordinary users (or its SUID helper). The test above runs `unshare` as root, which
# can create them even where users can't, and the SUID helper can't work for this app at all: Chromium runs it by a
# command line it splits at spaces, and the app lives in "/opt/DB Mastermind" (CI run 44943689826:
# execve("/opt/DB", …) = ENOENT). So the stock 4755 is useless here and only leaves a SUID-root binary: 0755 instead.
DBM_DIR='/opt/${sanitizedProductName}'
case "$DBM_DIR" in *' '*) chmod 0755 "$DBM_DIR/chrome-sandbox" || true ;; esac

# Without any sandbox Chromium refuses to start, so the menu entry gets --no-sandbox, but only when this running
# system positively shows that ordinary users can't create user namespaces. When the answer can't be known here, the
# entry stays sandboxed (an image or chroot build, whose profile loads at boot, mustn't be left unsandboxed for good):
#
#   condition (checked in this order)                                        answer     menu entry
#   in a chroot (ischroot), or /proc/sys/user/max_user_namespaces unreadable  unknown    sandboxed
#   user.max_user_namespaces = 0                                              no         --no-sandbox
#   kernel.unprivileged_userns_clone = 0 (Debian-style kernels)               no         --no-sandbox
#   apparmor_restrict_unprivileged_userns = 1, AppArmor not enforcing          yes        sandboxed
#     (/sys/module/apparmor/parameters/enabled is not Y)
#   … = 1, AppArmor's profile list unreadable                                 unknown    sandboxed
#   … = 1, this app's profile loaded                                          yes        sandboxed
#   … = 1, this app's profile not loaded (AppArmor too old for it, parser     no         --no-sandbox
#     missing or failing)
#   anything else                                                             yes        sandboxed
#
# Reinstalling or upgrading decides again (dpkg puts the package's entry back first). CI's linux-sandbox job tests
# every row the runner can produce.
users_lack_userns() {
  if [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then return 1; fi
  local max
  max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null) || return 1
  [ "$max" = 0 ] && return 0
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ] && return 0
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ] || return 1
    [ -r /sys/kernel/security/apparmor/profiles ] || return 1
    grep -q '^${executable} ' /sys/kernel/security/apparmor/profiles && return 1
    return 0
  fi
  return 1
}
DBM_DESKTOP='/usr/share/applications/${executable}.desktop'
DBM_BIN="$DBM_DIR/${executable}"
if users_lack_userns && [ -f "$DBM_DESKTOP" ] && ! grep -q -- '--no-sandbox' "$DBM_DESKTOP"; then
  sed -i "s|^Exec=\"$DBM_BIN\" %U\$|Exec=\"$DBM_BIN\" --no-sandbox %U|" "$DBM_DESKTOP"
  echo "DB Mastermind: this system doesn't let applications create user namespaces, so the app starts without Chromium's sandbox (--no-sandbox in its menu entry). To run it sandboxed, allow them (e.g. sysctl kernel.unprivileged_userns_clone=1, or load /etc/apparmor.d/${executable}) and reinstall the package."
fi
