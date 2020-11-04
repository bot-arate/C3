#!/usr/bin/env node

// Creates .versionrc.json file in the root of the repo based on
// CDK_MAJOR_VERSION which is required in order to allow multiple version lines.
// It is used when generating the .versionrc.json file which is used by
// `standard-version` to determine where to bump the major version and how to
// name the changelog.
//
// CDK_RELEASE_TYPE is required to ensure we don't accidentally release a
// pre-release without the appropriate pre-release tag. It's value must be one of
// "alpha", "rc" or "stable" and we validate that the version in
// "version.vNNN.json" adheres to this type.

const path = require('path');
const fs = require('fs');
const repoRoot = path.resolve(__dirname, '..');

const ALLOWED_RELEASE_TYPES = [ 'alpha', 'rc', 'stable' ];

const majorVersion = process.env.CDK_MAJOR_VERSION;
const releaseType = process.env.CDK_RELEASE_TYPE;

if (!majorVersion) {
  throw new Error('CDK_MAJOR_VERSION must be defined');
}

if (majorVersion !== '1' && majorVersion !== '2') {
  throw new Error(`CDK_MAJOR_VERSION=${majorVersion} is an unsupported major version`);
}

if (!releaseType) {
  throw new Error('CDK_RELEASE_TYPE must be defined');
}

if (!ALLOWED_RELEASE_TYPES.includes(releaseType)) {
  throw new Error(`CDK_RELEASE_TYPE=${releaseType} is not allowed. Allowed values: ${ALLOWED_RELEASE_TYPES.join(',')}`);
}

const versionFile = `version.v${majorVersion}.json`;
const versionFilePath = path.join(repoRoot, versionFile);
if (!fs.existsSync(versionFilePath)) {
  throw new Error(`unable to find version file ${versionFile} for major version ${majorVersion}`);
}

const currentVersion = require(versionFilePath).version;
console.error(`current version: ${currentVersion}`);

// check the pre-release tag
if (releaseType === 'stable') {
  if (currentVersion.includes('-')) {
    throw new Error(`found pre-release tag in version specified in ${versionFile} is ${currentVersion} but CDK_RELEASE_TYPE is set to "stable"`);
  }
} else {
  if (!currentVersion.includes(`-${releaseType}.`)) {
    throw new Error(`could not find pre-release tag "${releaseType}" in current version "${currentVersion}" defined in ${versionFile}`);
  }
}

const changelogFile = majorVersion === '1' ? 'CHANGELOG.md' : `CHANGELOG.v${majorVersion}.md`;

module.exports = {
  version: currentVersion,
  versionFile: versionFile,
  changelogFile: changelogFile,
  prerelease: releaseType !== 'stable' ? releaseType : undefined,
  marker: '0.0.0',
};
