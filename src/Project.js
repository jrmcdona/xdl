/**
 * @flow
 */

import 'instapromise';

import bodyParser from 'body-parser';
import child_process from 'child_process';
import delayAsync from 'delay-async';
import express from 'express';
import freeportAsync from 'freeport-async';
import fs from 'fs';
import joi from 'joi';
import _ from 'lodash';
import ngrok from 'ngrok';
import path from 'path';
import request from 'request';
import spawnAsync from '@exponent/spawn-async';
import treekill from 'tree-kill';
import md5hex from 'md5hex';

import * as Analytics from './Analytics';
import * as Android from './Android';
import Api from './Api';
import Config from './Config';
import * as Doctor from './project/Doctor';
import ErrorCode from './ErrorCode';
import * as Exp from './Exp';
import * as ExpSchema from './project/ExpSchema';
import * as ProjectSettings from './ProjectSettings';
import * as ProjectUtils from './project/ProjectUtils';
import * as UrlUtils from './UrlUtils';
import UserManager from './User';
import UserSettings from './UserSettings';
import * as Watchman from './Watchman';
import XDLError from './XDLError';

import type { User as ExpUser } from './User'; //eslint-disable-line

const MINIMUM_BUNDLE_SIZE = 500;

let _projectRootToExponentServer = {};

type CachedSignedManifest = {
  manifestString: ?string,
  signedManifest: ?string,
};

let _cachedSignedManifest: CachedSignedManifest = {
  manifestString: null,
  signedManifest: null,
};

async function _assertValidProjectRoot(projectRoot) {
  if (!projectRoot) {
    throw new XDLError(ErrorCode.NO_PROJECT_ROOT, 'No project root specified');
  }
}

async function _getFreePortAsync(rangeStart) {
  let port = await freeportAsync(rangeStart);
  if (!port) {
    throw new XDLError(ErrorCode.NO_PORT_FOUND, 'No available port found');
  }

  return port;
}

async function _getForPlatformAsync(url, platform, { errorCode, minLength }) {
  url = UrlUtils.getPlatformSpecificBundleUrl(url, platform);

  let response = await request.promise.get({
    url: `${url}&platform=${platform}`,
    headers: {
      'Exponent-Platform': platform,
    },
  });

  if (response.statusCode !== 200) {
    throw new XDLError(errorCode, `Packager returned unexpected code ${response.statusCode}. Please open your project in the Exponent app and see if there are any errors. Also scroll up and make sure there were no errors or warnings when opening your project.`);
  }

  if (!response.body || (minLength && response.body.length < minLength)) {
    throw new XDLError(errorCode, `Body is: ${response.body}`);
  }

  return response.body;
}

async function _resolveManifestAssets(projectRoot, manifest, resolver) {
  // Asset fields that the user has set
  const assetSchemas = (await ExpSchema.getAssetSchemasAsync(manifest.sdkVersion))
    .filter(({ fieldPath }) => _.get(manifest, fieldPath));

  // Get the URLs
  const urls = await Promise.all(assetSchemas.map(async ({ fieldPath }) => {
    const pathOrURL = _.get(manifest, fieldPath);
    if (fs.existsSync(path.resolve(projectRoot, pathOrURL))) {
      return await resolver(pathOrURL);
    } else {
      return pathOrURL; // Assume already a URL
    }
  }));

  // Set the corresponding URL fields
  assetSchemas.forEach(({ fieldPath }, index) =>
    _.set(manifest, fieldPath + 'Url', urls[index]));
}

export async function publishAsync(projectRoot: string, options: Object = {}) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  Analytics.logEvent('Publish', {
    projectRoot,
  });

  let schema = joi.object().keys({
    // empty
  });

  try {
    await joi.promise.validate(options, schema);
  } catch (e) {
    throw new XDLError(ErrorCode.INVALID_OPTIONS, e.toString());
  }

  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  if (!packagerInfo.packagerPort) {
    throw new XDLError(ErrorCode.NO_PACKAGER_PORT, `No packager found for project at ${projectRoot}.`);
  }

  let entryPoint = await Exp.determineEntryPointAsync(projectRoot);
  let publishUrl = await UrlUtils.constructPublishUrlAsync(projectRoot, entryPoint);
  let assetsUrl = await UrlUtils.constructAssetsUrlAsync(projectRoot, entryPoint);
  let [
    iosBundle,
    androidBundle,
    iosAssetsJson,
    androidAssetsJson,
  ] = await Promise.all([
    _getForPlatformAsync(publishUrl, 'ios', {
      errorCode: ErrorCode.INVALID_BUNDLE,
      minLength: MINIMUM_BUNDLE_SIZE,
    }),
    _getForPlatformAsync(publishUrl, 'android', {
      errorCode: ErrorCode.INVALID_BUNDLE,
      minLength: MINIMUM_BUNDLE_SIZE,
    }),
    _getForPlatformAsync(assetsUrl, 'ios', {
      errorCode: ErrorCode.INVALID_ASSETS,
    }),
    _getForPlatformAsync(assetsUrl, 'android', {
      errorCode: ErrorCode.INVALID_ASSETS,
    }),
  ]);

  let { exp, pkg } = await ProjectUtils.readConfigJsonAsync(projectRoot);

  if (!exp || !pkg) {
    throw new XDLError(ErrorCode.NO_PACKAGE_JSON, `Couldn't read exp.json file in project at ${projectRoot}`);
  }

  // Support version and name being specified in package.json for legacy
  // support pre: exp.json
  if (!exp.version && pkg.version) {
    exp.version = pkg.version;
  }
  if (!exp.slug && pkg.name) {
    exp.slug = pkg.name;
  }

  if (exp.android && exp.android.config) {
    delete exp.android.config;
  }

  if (exp.ios && exp.ios.config) {
    delete exp.ios.config;
  }

  // Resolve manifest assets to their S3 URL and add them to the list of assets to
  // be uploaded
  const manifestAssets = [];
  await _resolveManifestAssets(projectRoot, exp, async (assetPath) => {
    const contents = await fs.promise.readFile(path.resolve(projectRoot, assetPath));
    const hash = md5hex(contents);
    manifestAssets.push({ files: [assetPath], fileHashes: [hash] });
    return 'https://d1wp6m56sqw74a.cloudfront.net/~assets/' + hash;
  });

  // Upload asset files
  const iosAssets = JSON.parse(iosAssetsJson);
  const androidAssets = JSON.parse(androidAssetsJson);
  const assets = iosAssets.concat(androidAssets).concat(manifestAssets);
  if (assets.length > 0 && assets[0].fileHashes) {
    await uploadAssetsAsync(projectRoot, assets);
  }

  let formData = {
    expJson: JSON.stringify(exp),
    iosBundle: {
      value: iosBundle,
      options: {
        filename: 'iosBundle',
      },
    },
    androidBundle: {
      value: androidBundle,
      options: {
        filename: 'androidBundle',
      },
    },
  };

  let response = await Api.callMethodAsync('publish', [options], 'put', null, {formData});
  return response;
}

// TODO(jesse): Add analytics for upload
async function uploadAssetsAsync(projectRoot, assets) {
  // Collect paths by key, also effectively handles duplicates in the array
  const paths = {};
  assets.forEach(asset => {
    asset.files.forEach((path, index) => {
      paths[asset.fileHashes[index]] = path;
    });
  });

  // Collect list of assets missing on host
  const metas = (await Api.callMethodAsync('assetsMetadata', [], 'post', {
    keys: Object.keys(paths),
  })).metadata;
  const missing = Object.keys(paths).filter(key => !metas[key].exists);

  // Upload them!
  await Promise.all(_.chunk(missing, 5).map(async (keys) => {
    let formData = {};
    keys.forEach(key => {
      ProjectUtils.logDebug(projectRoot, 'exponent', `uploading ${paths[key]}`);
      formData[key] = {
        value: fs.createReadStream(paths[key]),
        options: {
          filename: paths[key],
        },
      };
    });
    await Api.callMethodAsync('uploadAssets', [], 'put', null, {formData});
  }));
}

export async function buildAsync(projectRoot: string, options: {
  current?: bool,
  mode?: string,
  platform?: string,
  expIds?: Array<string>,
} = {}) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  Analytics.logEvent('Build Shell App', {
    projectRoot,
  });

  let schema = joi.object().keys({
    current: joi.boolean(),
    mode: joi.string(),
    platform: joi.any().valid('ios', 'android', 'all'),
    expIds: joi.array(),
  });

  try {
    await joi.promise.validate(options, schema);
  } catch (e) {
    throw new XDLError(ErrorCode.INVALID_OPTIONS, e.toString());
  }

  let { exp, pkg } = await ProjectUtils.readConfigJsonAsync(projectRoot);

  if (!exp || !pkg) {
    throw new XDLError(ErrorCode.NO_PACKAGE_JSON, `Couldn't read exp.json file in project at ${projectRoot}`);
  }

  // Support version and name being specified in package.json for legacy
  // support pre: exp.json
  if (!exp.version && pkg.version) {
    exp.version = pkg.version;
  }
  if (!exp.slug && pkg.name) {
    exp.slug = pkg.name;
  }

  if (options.platform === 'ios' || options.platform === 'all') {
    if (!exp.ios || !exp.ios.bundleIdentifier) {
      throw new XDLError(ErrorCode.INVALID_MANIFEST, 'Must specify a bundle identifier in order to build this experience for iOS. Please specify one in exp.json at "ios.bundleIdentifier"');
    }
  }

  if (options.platform === 'android' || options.platform === 'all') {
    if (!exp.android || !exp.android.package) {
      throw new XDLError(ErrorCode.INVALID_MANIFEST, 'Must specify a java package in order to build this experience for Android. Please specify one in exp.json at "android.package"');
    }
  }

  let response = await Api.callMethodAsync(
    'build',
    [],
    'put',
    {
      manifest: exp,
      options,
    },
  );

  return response;
}

async function _waitForRunningAsync(url) {
  try {
    let response = await request.promise(url);
    // Looking for "Cached Bundles" string is hacky, but unfortunately
    // ngrok returns a 200 when it succeeds but the port it's proxying
    // isn't bound.
    if (response.statusCode >= 200 && response.statusCode < 300 &&
        response.body && response.body.includes('Cached Bundles')) {
      return true;
    }
  } catch (e) {
    // Try again after delay
  }

  await delayAsync(100);
  return _waitForRunningAsync(url);
}

function _stripPackagerOutputBox(output: string) {
  let re = /Running packager on port (\d+)/;
  let found = output.match(re);
  if (found && found.length >= 2) {
    return `Running packager on port ${found[1]}\n`;
  } else {
    return null;
  }
}

function _processPackagerLine(line: string) {
  // [10:02:59 AM]
  let timestampRe = /\s*\[\d+\:\d+\:\d+\ (AM)?(PM)?\]\s+/;
  // [11/8/2016, 10:02:59 AM]
  let sdk11AndUpTimestampRe = /\s*\[\d+\/\d+\/\d+, \d+\:\d+\:\d+\ (AM)?(PM)?\]\s+/;
  return line.replace(timestampRe, '').replace(sdk11AndUpTimestampRe, '');
}

async function _restartWatchmanAsync(projectRoot: string) {
  try {
    let result = await spawnAsync('watchman', ['watch-del', projectRoot]);
    await spawnAsync('watchman', ['watch-project', projectRoot]);
    if (result.stdout.includes('root')) {
      ProjectUtils.logInfo(projectRoot, 'exponent', 'Restarted watchman.');
      return;
    }
  } catch (e) {}

  ProjectUtils.logError(projectRoot, 'exponent', 'Attempted to restart watchman but failed. Please try running `watchman watch-del-all`.');
}

function _logPackagerOutput(projectRoot: string, level: string, data: Object) {
  let output = data.toString();
  if (output.includes('─────')) {
    output = _stripPackagerOutputBox(output);
    if (output) {
      ProjectUtils.logInfo(projectRoot, 'exponent', output);
    }
    return;
  }

  if (!output) {
    return;
  }

  // Fix watchman if it's being dumb
  if (Watchman.isPlatformSupported() && output.includes('watchman watch-del')) {
    _restartWatchmanAsync(projectRoot);
    return;
  }

  let lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    lines[i] = _processPackagerLine(lines[i]);
  }
  output = lines.join('\n');

  if (level === 'info') {
    ProjectUtils.logInfo(projectRoot, 'packager', output);
  } else {
    ProjectUtils.logError(projectRoot, 'packager', output);
  }
}

function _handleDeviceLogs(projectRoot: string, deviceId: string, deviceName: string, logs: any) {
  for (let i = 0; i < logs.length; i++) {
    let log = logs[i];

    let body = typeof log.body === 'string' ? [log.body] : log.body;
    let string = body.map(obj => {
      if (typeof obj === 'undefined') {
        return 'undefined';
      }
      if (obj === 'null') {
        return 'null';
      }

      if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
        return obj;
      }

      try {
        return JSON.stringify(obj);
      } catch (e) {
        return obj.toString();
      }
    }).join(' ');

    let level = log.level;
    let groupDepth = log.groupDepth;
    let shouldHide = log.shouldHide;
    ProjectUtils.logWithLevel(projectRoot, level, {
      tag: 'device',
      deviceId,
      deviceName,
      groupDepth,
      shouldHide,
    }, string);
  }
}

export async function startReactNativeServerAsync(projectRoot: string, options: Object = {}) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  await stopReactNativeServerAsync(projectRoot);

  await Watchman.addToPathAsync();
  // Attempt to fix watchman if it's hanging
  await Watchman.unblockAndGetVersionAsync();

  let packagerPort = await _getFreePortAsync(19001);

  let exp = await Exp.expConfigForRootAsync(projectRoot);

  // Create packager options
  let packagerOpts = {
    port: packagerPort,
    projectRoots: projectRoot,
    assetRoots: projectRoot,
  };

  const userPackagerOpts = _.get(exp, 'packagerOpts');
  if (userPackagerOpts) {
    packagerOpts = {
      ...packagerOpts,
      ...userPackagerOpts,
    };
  }

  let cliOpts = _.reduce(packagerOpts, (opts, val, key) => {
    if (val && val !== '') {
      opts.push(`--${key}`, val);
    }
    return opts;
  }, ['start']);

  if (options.reset) {
    cliOpts.push('--reset-cache');
  }

  // Get custom CLI path from project package.json, but fall back to node_module path
  let defaultCliPath = path.join(projectRoot, 'node_modules', 'react-native', 'local-cli', 'cli.js');
  const cliPath = _.get(exp, 'rnCliPath', defaultCliPath);

  let nodePath;
  // When using a custom path for the RN CLI, we want it to use the project
  // root to look up config files and Node modules
  if (exp.rnCliPath) {
    nodePath = _nodePathForProjectRoot(projectRoot);
  } else {
    nodePath = null;
  }

  ProjectUtils.logInfo(projectRoot, 'exponent', 'Starting React Native packager...');

  // Run the copy of Node that's embedded in Electron by setting the
  // ELECTRON_RUN_AS_NODE environment variable
  // Note: the CLI script sets up graceful-fs and sets ulimit to 4096 in the
  // child process
  let packagerProcess = child_process.fork(cliPath, cliOpts, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_PATH: nodePath,
      ELECTRON_RUN_AS_NODE: 1,
    },
    silent: true,
  });

  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    packagerPort,
    packagerPid: packagerProcess.pid,
  });

  // TODO: do we need this? don't know if it's ever called
  process.on('exit', () => {
    treekill(packagerProcess.pid);
  });

  packagerProcess.stdout.setEncoding('utf8');
  packagerProcess.stderr.setEncoding('utf8');
  packagerProcess.stdout.on('data', (data) => {
    _logPackagerOutput(projectRoot, 'info', data);
  });

  packagerProcess.stderr.on('data', (data) => {
    _logPackagerOutput(projectRoot, 'error', data);
  });

  packagerProcess.on('exit', async (code) => {
    ProjectUtils.logDebug(projectRoot, 'exponent', `packager process exited with code ${code}`);
  });

  let packagerUrl = await UrlUtils.constructBundleUrlAsync(projectRoot, {
    urlType: 'http',
    hostType: 'localhost',
  });

  await _waitForRunningAsync(`${packagerUrl}/debug`);
}

// Simulate the node_modules resolution
// If you project dir is /Jesse/Exponent/Universe/BubbleBounce, returns
// "/Jesse/node_modules:/Jesse/Exponent/node_modules:/Jesse/Exponent/Universe/node_modules:/Jesse/Exponent/Universe/BubbleBounce/node_modules"
function _nodePathForProjectRoot(projectRoot: string): string {
  let paths = [];
  let directory = path.resolve(projectRoot);
  while (true) {
    paths.push(path.join(directory, 'node_modules'));
    let parentDirectory = path.dirname(directory);
    if (directory === parentDirectory) {
      break;
    }
    directory = parentDirectory;
  }
  return paths.join(path.delimiter);
}

export async function stopReactNativeServerAsync(projectRoot: string) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  if (!packagerInfo.packagerPort || !packagerInfo.packagerPid) {
    ProjectUtils.logDebug(projectRoot, 'exponent', `No packager found for project at ${projectRoot}.`);
    return;
  }

  ProjectUtils.logDebug(projectRoot, 'exponent', `Killing packager process tree: ${packagerInfo.packagerPid}`);
  try {
    await treekill.promise(packagerInfo.packagerPid, 'SIGKILL');
  } catch (e) {
    ProjectUtils.logDebug(projectRoot, 'exponent', `Error stopping packager process: ${e.toString()}`);
  }

  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    packagerPort: null,
    packagerPid: null,
  });
}

export async function startExponentServerAsync(projectRoot: string) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  await stopExponentServerAsync(projectRoot);

  let app = express();
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  if (await Doctor.validateWithNetworkAsync(projectRoot) === Doctor.FATAL) {
    throw new Error(`Couldn't start project. Please fix the above issues and restart the project.`);
  }

  // Serve the manifest.
  let manifestHandler = async (req, res) => {
    try {
      // We intentionally don't `await`. We want to continue trying even
      // if there is a potential error in the package.json and don't want to slow
      // down the request
      Doctor.validateWithNetworkAsync(projectRoot);

      let { exp: manifest } = await ProjectUtils.readConfigJsonAsync(projectRoot);
      if (!manifest) {
        throw new Error('No exp.json file found');
      }

      // Get packager opts and then copy into bundleUrlPackagerOpts
      let packagerOpts = await ProjectSettings.getPackagerOptsAsync(projectRoot);
      let bundleUrlPackagerOpts = JSON.parse(JSON.stringify(packagerOpts));
      bundleUrlPackagerOpts.urlType = 'http';
      if (bundleUrlPackagerOpts.hostType === 'redirect') {
        bundleUrlPackagerOpts.hostType = 'tunnel';
      }

      manifest.xde = true; // deprecated
      manifest.developer = {
        tool: Config.developerTool,
      };
      manifest.packagerOpts = packagerOpts;

      let entryPoint = await Exp.determineEntryPointAsync(projectRoot);
      let platform = req.headers['exponent-platform'] || 'ios';
      entryPoint = UrlUtils.getPlatformSpecificBundleUrl(entryPoint, platform);
      let mainModuleName = UrlUtils.guessMainModulePath(entryPoint);
      let queryParams = await UrlUtils.constructBundleQueryParamsAsync(projectRoot, packagerOpts);
      let path = `/${mainModuleName}.bundle?platform=${platform}&${queryParams}`;
      manifest.bundleUrl = await UrlUtils.constructBundleUrlAsync(projectRoot, bundleUrlPackagerOpts) + path;
      manifest.debuggerHost = await UrlUtils.constructDebuggerHostAsync(projectRoot);
      manifest.mainModuleName = mainModuleName;
      manifest.logUrl = `${await UrlUtils.constructManifestUrlAsync(projectRoot, {
        urlType: 'http',
      })}/logs`;

      // Resolve manifest assets to their packager URL
      await _resolveManifestAssets(projectRoot, manifest, async (path) =>
        manifest.bundleUrl.match(/^https?:\/\/.*?\//)[0] + path);

      let manifestString = JSON.stringify(manifest);
      const currentUser = await UserManager.getCurrentUserAsync();

      if (req.headers['exponent-accept-signature'] && currentUser) {
        if (_cachedSignedManifest.manifestString === manifestString) {
          manifestString = _cachedSignedManifest.signedManifest;
        } else {
          let publishInfo = await Exp.getPublishInfoAsync(projectRoot);
          let signedManifest = await Api.callMethodAsync('signManifest', [publishInfo.args], 'post', manifest);
          _cachedSignedManifest.manifestString = manifestString;
          _cachedSignedManifest.signedManifest = signedManifest.response;
          manifestString = signedManifest.response;
        }
      }

      res.send(manifestString);

      Analytics.logEvent('Serve Manifest', {
        projectRoot,
      });
    } catch (e) {
      ProjectUtils.logDebug(projectRoot, 'exponent', `Error in manifestHandler: ${e} ${e.stack}`);
      // 5xx = Server Error HTTP code
      res.status(520).send({"error": e.toString()});
    }
  };

  app.get('/', manifestHandler);
  app.get('/manifest', manifestHandler);
  app.get('/index.exp', manifestHandler);
  app.post('/logs', async (req, res) => {
    try {
      let deviceId = req.get('Device-Id');
      let deviceName = req.get('Device-Name');
      if (deviceId && deviceName && req.body) {
        _handleDeviceLogs(projectRoot, deviceId, deviceName, req.body);
      }
    } catch (e) {
      ProjectUtils.logError(projectRoot, 'exponent', `Error getting device logs: ${e} ${e.stack}`);
    }
    res.send('Success');
  });

  let exponentServerPort = await _getFreePortAsync(19000);
  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    exponentServerPort,
  });
  let server = app.listen(exponentServerPort, () => {
    let host = server.address().address;
    let port = server.address().port;

    ProjectUtils.logDebug(projectRoot, 'exponent', `Local server listening at http://${host}:${port}`);
  });

  _projectRootToExponentServer[projectRoot] = server;
  await Exp.saveRecentExpRootAsync(projectRoot);
}

// This only works when called from the same process that called
// startExponentServerAsync.
export async function stopExponentServerAsync(projectRoot: string) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  let server = _projectRootToExponentServer[projectRoot];
  if (!server) {
    ProjectUtils.logDebug(projectRoot, 'exponent', `No Exponent server found for project at ${projectRoot}.`);
    return;
  }

  try {
    await server.promise.close();
  } catch (e) {
    // don't care if this fails
  }
  _projectRootToExponentServer[projectRoot] = null;

  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    exponentServerPort: null,
  });
}

async function _connectToNgrokAsync(projectRoot: string, args: mixed, hostnameAsync: Function, ngrokPid: ?number, attempts: number = 0) {
  try {
    let configPath = path.join(UserSettings.dotExponentHomeDirectory(), 'ngrok.yml');
    let hostname = await hostnameAsync();
    let url = await ngrok.promise.connect({
      hostname,
      configPath,
      ...args,
    });
    return url;
  } catch (e) {
    // Attempt to connect 3 times
    if (attempts >= 2) {
      if (e.message) {
        throw new XDLError(ErrorCode.NGROK_ERROR, e.toString());
      } else {
        throw new XDLError(ErrorCode.NGROK_ERROR, JSON.stringify(e));
      }
    }

    if (!attempts) {
      attempts = 0;
    }

    // Attempt to fix the issue
    if (e.error_code && e.error_code === 103) {
      if (attempts === 0) {
        // Failed to start tunnel. Might be because url already bound to another session.
        if (ngrokPid) {
          try {
            process.kill(ngrokPid, 'SIGKILL');
          } catch (e) {
            ProjectUtils.logDebug(projectRoot, 'exponent', `Couldn't kill ngrok with PID ${ngrokPid}`);
          }
        } else {
          await ngrok.promise.kill();
        }
      } else {
        // Change randomness to avoid conflict if killing ngrok didn't help
        await Exp.resetProjectRandomnessAsync(projectRoot);
      }
    }

    // Wait 100ms and then try again
    await delayAsync(100);
    return _connectToNgrokAsync(projectRoot, args, hostnameAsync, null, attempts + 1);
  }
}

export async function startTunnelsAsync(projectRoot: string) {
  const user = await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  if (!packagerInfo.packagerPort) {
    throw new XDLError(ErrorCode.NO_PACKAGER_PORT, `No packager found for project at ${projectRoot}.`);
  }

  if (!packagerInfo.exponentServerPort) {
    throw new XDLError(ErrorCode.NO_EXPONENT_SERVER_PORT, `No Exponent server found for project at ${projectRoot}.`);
  }

  await stopTunnelsAsync(projectRoot);

  if (await Android.startAdbReverseAsync(projectRoot)) {
    ProjectUtils.logInfo(projectRoot, 'exponent', 'Sucessfully ran `adb reverse`. Localhost urls should work on the connected Android device.');
  }

  const { username } = user;

  let packageShortName = path.parse(projectRoot).base;

  try {
    let exponentServerNgrokUrl = await _connectToNgrokAsync(projectRoot, {
      authtoken: Config.ngrok.authToken,
      port: packagerInfo.exponentServerPort,
      proto: 'http',
    }, async () => {
      let randomness = await Exp.getProjectRandomnessAsync(projectRoot);
      return [randomness, UrlUtils.domainify(username), UrlUtils.domainify(packageShortName), Config.ngrok.domain].join('.');
    }, packagerInfo.ngrokPid);

    let packagerNgrokUrl = await _connectToNgrokAsync(projectRoot, {
      authtoken: Config.ngrok.authToken,
      port: packagerInfo.packagerPort,
      proto: 'http',
    }, async () => {
      let randomness = await Exp.getProjectRandomnessAsync(projectRoot);
      return ['packager', randomness, UrlUtils.domainify(username), UrlUtils.domainify(packageShortName), Config.ngrok.domain].join('.');
    }, packagerInfo.ngrokPid);

    await ProjectSettings.setPackagerInfoAsync(projectRoot, {
      exponentServerNgrokUrl,
      packagerNgrokUrl,
      ngrokPid: ngrok.process().pid,
    });
  } catch (e) {
    ProjectUtils.logError(projectRoot, 'exponent', `Error starting tunnel: ${e.toString()}`);
    throw e;
  }
}

export async function stopTunnelsAsync(projectRoot: string) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  // This will kill all ngrok tunnels in the process.
  // We'll need to change this if we ever support more than one project
  // open at a time in XDE.

  let packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  let ngrokProcess = ngrok.process();
  let ngrokProcessPid = ngrokProcess ? ngrokProcess.pid : null;

  if (packagerInfo.ngrokPid && packagerInfo.ngrokPid !== ngrokProcessPid) {
    // Ngrok is running in some other process. Kill at the os level.
    try {
      process.kill(packagerInfo.ngrokPid);
    } catch (e) {
      ProjectUtils.logDebug(projectRoot, 'exponent', `Couldn't kill ngrok with PID ${packagerInfo.ngrokPid}`);
    }
  } else {
    // Ngrok is running from the current process. Kill using ngrok api.
    await ngrok.promise.kill();
  }

  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    exponentServerNgrokUrl: null,
    packagerNgrokUrl: null,
    ngrokPid: null,
  });

  await Android.stopAdbReverseAsync(projectRoot);
}

export async function setOptionsAsync(projectRoot: string, options: { packagerPort?: number }) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  // Check to make sure all options are valid
  let schema = joi.object().keys({
    packagerPort: joi.number().integer(),
  });

  try {
    await joi.promise.validate(options, schema);
  } catch (e) {
    throw new XDLError(ErrorCode.INVALID_OPTIONS, e.toString());
  }

  await ProjectSettings.setPackagerInfoAsync(projectRoot, options);
}

export async function getUrlAsync(projectRoot: string, options: Object = {}) {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  return await UrlUtils.constructManifestUrlAsync(projectRoot, options);
}

export async function startAsync(projectRoot: string, options: Object = {}): Promise<any> {
  await UserManager.ensureLoggedInAsync();
  _assertValidProjectRoot(projectRoot);

  Analytics.logEvent('Start Project', {
    projectRoot,
  });

  await startExponentServerAsync(projectRoot);
  await startReactNativeServerAsync(projectRoot, options);
  try {
    await startTunnelsAsync(projectRoot);
  } catch (e) {
    ProjectUtils.logDebug(projectRoot, 'exponent', `Error starting ngrok ${e.message}`);
  }

  let { exp } = await ProjectUtils.readConfigJsonAsync(projectRoot);
  return exp;
}

export async function stopAsync(projectRoot: string): Promise<void> {
  await stopTunnelsAsync(projectRoot);
  await stopReactNativeServerAsync(projectRoot);
  try {
    await stopExponentServerAsync(projectRoot);
  } catch (e) {
    ProjectUtils.logDebug(projectRoot, 'exponent', `Error stopping ngrok ${e.message}`);
  }
}
