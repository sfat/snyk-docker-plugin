import { Docker } from '../docker';
import { Binary } from './types';

const semver = require('semver');

export {
  analyze,
};

async function analyze(targetImage: string, installedPackages: string[]) {
  const binaries = await getBinaries(targetImage, installedPackages);
  return {
    Image: targetImage,
    AnalyzeType: 'binaries',
    Analysis: binaries,
  };
}

// const handlers = {
//   node: require('./node'),
//   java: require('./java')
// }

async function getBinaries(targetImage: string, installedPackages: string[])
  : Promise<Binary[]> {
  const binaries: Binary[] = [];

  //  for (const handler in handlers) {
  //    const binary = handler.handle(targetImage, installedPackages);
  //    if (binary) {
  //      binaries.push(binary);
  //    }
  // }
  // return binaries;
  const node = await getNodeBinary(
    targetImage, installedPackages);
  const openJDK = await getOpenJDKBinary(
    targetImage, installedPackages);
  console.log(' #### openJDK', openJDK);
  if (node) {
     binaries.push(node);
  }
  if (openJDK) {
    binaries.push(openJDK);
  }
  return binaries;
}

function getNodeBinary(targetImage: string, installedPackages: string[])
  : Promise<Binary | null> | null {
  if (installedByPackageManager(['node', 'nodejs'], installedPackages)) {
    return null;
  }
  return new Docker(targetImage).run('node', [ '--version' ])
    .catch(stderr => {
      if (typeof stderr === 'string' && stderr.indexOf('not found') >= 0) {
        return '';
      }
      throw new Error(stderr);
    })
    .then(parseNodeBinary);
}

function getOpenJDKBinary(targetImage: string, installedPackages: string[])
  : Promise<Binary | null> | null {
    // todo for openJDK
  if (installedByPackageManager(['java', 'blablajava'], installedPackages)) {
    return null;
  }
  return new Docker(targetImage).run('java', [ '-version' ])
    .catch(stderr => {
      if (typeof stderr === 'string' && stderr.indexOf('not found') >= 0) {
        return '';
      }
      throw new Error(stderr);
    })
    .then(parseOpenJDKBinary);
}

function installedByPackageManager(
  binaryPkgNames: string[],
  installedPackages: string[]): boolean {
  return installedPackages
    .filter(pkg => binaryPkgNames.indexOf(pkg) > -1).length > 0;
}

function parseNodeBinary(version: string) {
  const nodeVersion = semver.valid(version.trim());
  if (!nodeVersion) {
    return null;
  }

  return {
    name: 'node',
    version: nodeVersion,
  };
}

function parseOpenJDKBinary(fullVersionOutput: string) {
  /*
  java version "1.8.0_191"
  Java(TM) SE Runtime Environment (build 1.8.0_191-b12)
  Java HotSpot(TM) 64-Bit Server VM (build 25.191-b12, mixed mode)
  */
 // todo: add test empty string + null/undefined output
  if (!fullVersionOutput) {
    return null;
  }
  const bracketsRE = /\(build (.*)\)$/;
  const jdkVersionLines = fullVersionOutput.split('\n');
  console.log(' **** jdkVersionLines: ', jdkVersionLines);

  const buildVersion = jdkVersionLines && jdkVersionLines.length > 1 &&
                  jdkVersionLines[1].match(bracketsRE);
  const version = buildVersion && buildVersion[1];
  console.log(' **** version: ', version);
  // const jdkVersionLines = fullVersionOutput.split('\n');
  // if (jdkVersionLines.length !== 3) {
  //   return null;
  // }
  // const jreVersionLine = jdkVersionLines[1];
  // let jreVersion = jreVersionLine && jreVersionLine.match(bracketsRE);
  // jreVersion = jreVersion ? jreVersion[0].replace('build', '') : null;
  // jreVersion = jreVersion ? jreVersion[0].replace('(', '') : null;
  // jreVersion = jreVersion ? jreVersion.slice(2, -1) : null; // ( 1.8..fmf)

  if (!version) {
    return null;
  }

  return {
    name: 'openjdk',
    version,
  };
}
