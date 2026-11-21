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
# The test above runs `unshare` as root, which can create user namespaces even where ordinary users can't. Where they
# can't, Chromium's only other sandbox is the SUID helper, and that can't work here: Chromium runs it by a command line
# it splits at spaces, and this app lives in "/opt/DB Mastermind" (CI run 44943689826: execve("/opt/DB", …) ENOENT).
# Without a sandbox Chromium refuses to start, so the menu entry then starts the app with --no-sandbox, as every
# version before 1.5 did, and this script says so. Users can't create user namespaces when:
#   - user.max_user_namespaces = 0 or kernel.unprivileged_userns_clone = 0 (older Debian defaults, hardened kernels);
#   - AppArmor restricts unprivileged user namespaces (Ubuntu 23.10+) and this app's profile isn't loaded (AppArmor
#     too old for the profile, apparmor_parser missing or failing).
users_get_userns() {
  [ -L /proc/self/ns/user ] || return 1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" != 0 ] || return 1
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != 0 ] || return 1
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    grep -qs '^${executable} ' /sys/kernel/security/apparmor/profiles || return 1
  fi
  return 0
}
DBM_DESKTOP='/usr/share/applications/${executable}.desktop'
DBM_BIN='/opt/${sanitizedProductName}/${executable}'
if ! users_get_userns && [ -f "$DBM_DESKTOP" ] && ! grep -q -- '--no-sandbox' "$DBM_DESKTOP"; then
  sed -i "s|^Exec=\"$DBM_BIN\" %U\$|Exec=\"$DBM_BIN\" --no-sandbox %U|" "$DBM_DESKTOP"
  echo "DB Mastermind: this system doesn't let applications create user namespaces, so the app starts without Chromium's sandbox (--no-sandbox in its menu entry). To run it sandboxed, allow them (e.g. sysctl kernel.unprivileged_userns_clone=1, or load /etc/apparmor.d/db-mastermind) and reinstall the package."
fi
