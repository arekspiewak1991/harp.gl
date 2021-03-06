#!/usr/bin/env bash

#
# This test checks if `npm` packages we are about to publish to `npmjs.org`
# actually work with sample client application - where this application is
# just output of our `yo @here/harp.gl`.
#
set -e

# direct and indirect harp.gl dependencies of our test app
# (TODO, read it from package.json)
packages="\
    @here/harp-datasource-protocol \
    @here/harp-fetch \
    @here/harp-geoutils \
    @here/harp-lines \
    @here/harp-lrucache \
    @here/harp-map-controls \
    @here/harp-map-theme \
    @here/harp-mapview \
    @here/harp-mapview-decoder \
    @here/harp-materials \
    @here/harp-omv-datasource \
    @here/harp-text-canvas \
    @here/harp-transfer-manager \
    @here/harp-utils"


# ensure we have clean environment before and after test
rootDir=`pwd`
function cleanup() {
    cd $rootDir
    rm -f @here/*/*.tgz
}
trap cleanup EXIT

set -x
cleanup

# build the npm packages
for package in $packages ; do
    # lerna exec "npm pack" is smarter and, parallel i guess but packages everything
    # and we don't want examples and other stuff
    ( cd $package && npm pack )
done

# generate test app
rm -rf harp.gl-example
yes "" | npm init @here/harp.gl-app
cd harp.gl-example

set +x
for package in $packages ; do
    packageArchives="$packageArchives ../$package/here-$(basename $package)-*.tgz"
done
set -x

# install base deps
npm install

# force use of our local versions
npm install --no-save $packageArchives

# build it
npm run build

# cleanup will be called automatically
