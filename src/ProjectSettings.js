/**
 * @flow
 */

import 'instapromise';

import _ from 'lodash';
import JsonFile from '@exponent/json-file';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';

let projectSettingsFile = 'settings.json';
let projectSettingsDefaults = {
  hostType: 'tunnel',
  lanType: 'ip',
  dev: true,
  strict: false,
  minify: false,
  urlType: 'exp',
  urlRandomness: null,
};
let packagerInfoFile = 'packager-info.json';

function projectSettingsJsonFile(projectRoot: string, filename: string) {
  return new JsonFile(path.join(dotExponentProjectDirectory(projectRoot), filename));
}

export async function readAsync(projectRoot: string) {
  let projectSettings;
  try {
    projectSettings = await projectSettingsJsonFile(projectRoot, projectSettingsFile).readAsync();
  } catch (e) {
    projectSettings = await projectSettingsJsonFile(projectRoot, projectSettingsFile).writeAsync(projectSettingsDefaults);
  }

  if (projectSettings.hostType === 'ngrok') { // 'ngrok' is deprecated
    projectSettings.hostType = 'tunnel';
  }

  // Set defaults for any missing fields
  _.defaults(projectSettings, projectSettingsDefaults);
  return projectSettings;
}

export async function setAsync(projectRoot: string, json: any) {
  try {
    return await projectSettingsJsonFile(projectRoot, projectSettingsFile).mergeAsync(json, {cantReadFileDefault: projectSettingsDefaults});
  } catch (e) {
    return await projectSettingsJsonFile(projectRoot, packagerInfoFile).writeAsync(_.defaults(json, projectSettingsDefaults));
  }
}

export async function readPackagerInfoAsync(projectRoot: string) {
  try {
    return await projectSettingsJsonFile(projectRoot, packagerInfoFile).readAsync({cantReadFileDefault: {}});
  } catch (e) {
    return await projectSettingsJsonFile(projectRoot, packagerInfoFile).writeAsync({});
  }
}

export async function setPackagerInfoAsync(projectRoot: string, json: any) {
  try {
    return await projectSettingsJsonFile(projectRoot, packagerInfoFile).mergeAsync(json, {cantReadFileDefault: {}});
  } catch (e) {
    return await projectSettingsJsonFile(projectRoot, packagerInfoFile).writeAsync(json);
  }
}

export function dotExponentProjectDirectory(projectRoot: string) {
  let dirPath = path.join(projectRoot, '.exponent');
  try {
    // remove .exponent file if it exists, we moved to a .exponent directory
    if (fs.statSync(dirPath).isFile()) {
      fs.unlinkSync(dirPath);
    }
  } catch (e) {
    // no file or directory, continue
  }

  mkdirp.sync(dirPath);
  return dirPath;
}

export function dotExponentProjectDirectoryExists(projectRoot: string) {
  let dirPath = path.join(projectRoot, '.exponent');
  try {
    if (fs.statSync(dirPath).isDirectory()) {
      return true;
    }
  } catch (e) {
    // file doesn't exist
  }

  return false;
}

export async function getPackagerOptsAsync(projectRoot: string) {
  let projectSettings = await readAsync(projectRoot);
  return projectSettings;
}
