# A CI image with the chant `just chant-local` packed, for the stack's jobs.
# The CI images install the chant package.json pins (images/images.ts), so
# after `just chant-local` the bundle runs the local chant on the host while a
# forge job still runs the pinned one. stack/bootstrap.sh builds this on top of
# the tofu CI image, under the same tag, through chant's `dev local-image`,
# which passes .chant-local/ as the build context `chant-local`. The image's
# chant package and its `chant` bin (the wave runtime) then come from the
# tarball, as the CI image's own lines install them from npm.
#
#   BASE      the tofu CI image (scripts/images.ts tags)
#   HCL2JSON  the @cdktn/hcl2json pin, installed again beside chant
#
# `just chant-local --reset` builds the CI images again from the pins.
ARG BASE
FROM scratch AS chant-local
FROM ${BASE}
ARG HCL2JSON
RUN --mount=type=bind,from=chant-local,target=/chant-local \
    test -f /chant-local/intentius-chant.tgz \
 && npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund /chant-local/intentius-chant.tgz "@cdktn/hcl2json@${HCL2JSON}" \
 && tar -xzOf /chant-local/intentius-chant.tgz package/dist/wave-runtime.mjs > /opt/chant/wave-runtime.mjs \
 && npm cache clean --force \
 && chant --version
