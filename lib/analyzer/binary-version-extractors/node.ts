import { Docker } from '../../docker';
import { Binary } from '../types';

const semver = require('semver');

export {
  extract,
  installedByPackageManager,
};

async function extract(
  targetImage: string,
  options?: any): Promise<Binary | null> {
  try {
    const binaryVersion = (await new Docker(targetImage, options)
      .run('node', [ '--version' ])).stdout;
    return parseNodeBinary(binaryVersion);
  } catch (error) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.indexOf('not found') >= 0) {
      return null;
    }
    throw new Error(stderr);
  }
}

function parseNodeBinary(version: string) {
  const nodeVersion = semver.valid(version && version.trim());
  if (!nodeVersion) {
    return null;
  }
  return {
    name: 'node',
    version: nodeVersion,
  };
}

const packageNames = ['node', 'nodejs'];

function installedByPackageManager(
  installedPackages: string[], pkgManager?: string): boolean {
  return installedPackages
    .filter(pkg => packageNames.indexOf(pkg) > -1).length > 0;
}
