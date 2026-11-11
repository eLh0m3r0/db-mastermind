FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive WINEDEBUG=-all WINEPREFIX=/wine DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xvfb xdotool imagemagick unzip x11-utils procps file fonts-liberation fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
# Hangover: Wine built for ARM64 with emulators for the x86 code of Windows programs.
RUN mkdir /hangover && cd /hangover && \
    curl -fsSL -o hangover.tar https://github.com/AndreRH/hangover/releases/download/hangover-11.16/hangover_11.16_debian13_trixie_arm64.tar && \
    tar xf hangover.tar && rm hangover.tar && apt-get update && \
    apt-get install -y --no-install-recommends ./hangover-wine_*.deb ./hangover-libwow64fex_*.deb ./hangover-wowbox64_*.deb ./hangover-libarm64ecfex_*.deb && \
    rm -rf /var/lib/apt/lists/* /hangover
RUN mkdir -p /work
WORKDIR /work
CMD ["sleep", "infinity"]
